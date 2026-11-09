import { type Connection, Keypair, type PublicKey, type Transaction } from "@solana/web3.js";
import { buildLaunchInstructions, type BuyQuote, fetchPumpState, type PumpState } from "./adapter";
import type { LaunchPolicy } from "./policy";
import { type SendOutcome, type SendPhase, signAndSend } from "./send";
import {
  type BudgetPlan,
  chooseBudget,
  compileLaunchTx,
  cuLimitFromSimulation,
  estimateCuPrice,
  maxNetworkFeeLamports,
  simulateLaunch,
} from "./transaction";

// Same length as a real link (gateway + CIDv0), so the simulation sizes the transaction correctly.
export const PLACEHOLDER_URI = "https://ipfs.io/ipfs/Qm" + "1".repeat(44);

export interface LaunchRequest {
  user: PublicKey;
  name: string;
  symbol: string;
  initialBuyLamports: bigint;
  policy: LaunchPolicy;
}

export interface PreparedLaunch {
  request: LaunchRequest;
  /** Generated in the browser for this launch only; never stored or sent anywhere. */
  mintKeypair: Keypair;
  state: PumpState | null;
  cuPrice: number;
  simulatedUnits: number | undefined;
  budget: BudgetPlan;
  quote: BuyQuote | null;
  networkFeeMaxLamports: bigint;
  /** What the simulation took out of the wallet (rent + buy + fees). Null if the node didn't report it. */
  simulatedWalletDeltaLamports: bigint | null;
}

function finalBudget(plan: BudgetPlan, simulatedUnits: number | undefined): BudgetPlan {
  return plan.kind === "priority" ? { ...plan, computeUnitLimit: cuLimitFromSimulation(simulatedUnits) } : plan;
}

/** Builds and simulates the launch with a placeholder metadata link. Nothing is signed or uploaded. */
export async function prepareLaunch(connection: Connection, request: LaunchRequest): Promise<PreparedLaunch> {
  const mintKeypair = Keypair.generate();
  const withBuy = request.initialBuyLamports > 0n;
  const [state, cuPrice, latest] = await Promise.all([
    withBuy ? fetchPumpState(connection, true) : Promise.resolve(null),
    estimateCuPrice(connection),
    connection.getLatestBlockhash("confirmed"),
  ]);
  const { instructions, quote } = await buildLaunchInstructions(
    { ...request, mint: mintKeypair.publicKey, uri: PLACEHOLDER_URI },
    state,
  );
  const plan = chooseBudget(request.user, instructions, cuPrice);
  const sim = await simulateLaunch(connection, {
    payer: request.user,
    blockhash: latest.blockhash,
    instructions,
    budget: plan,
  });
  const budget = finalBudget(plan, sim.unitsConsumed);
  return {
    request,
    mintKeypair,
    state,
    cuPrice,
    simulatedUnits: sim.unitsConsumed,
    budget,
    quote,
    networkFeeMaxLamports: maxNetworkFeeLamports(2, budget),
    simulatedWalletDeltaLamports: sim.walletDeltaLamports,
  };
}

export interface ExecuteArgs {
  connection: Connection;
  prepared: PreparedLaunch;
  uri: string;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  onPhase?: (phase: SendPhase, signature?: string) => void;
}

/**
 * Rebuilds the launch with the real metadata link and a fresh blockhash, has the wallet sign,
 * co-signs with the mint keypair and sends. Safe to call again after an "expired" outcome:
 * an expired blockhash can never land, so the same mint is reused.
 */
export async function executeLaunch(a: ExecuteArgs): Promise<SendOutcome> {
  const { prepared } = a;
  const { request } = prepared;
  const { instructions } = await buildLaunchInstructions(
    { ...request, mint: prepared.mintKeypair.publicKey, uri: a.uri },
    prepared.state,
  );
  const budget = finalBudget(chooseBudget(request.user, instructions, prepared.cuPrice), prepared.simulatedUnits);
  const latest = await a.connection.getLatestBlockhash("confirmed");
  const tx = compileLaunchTx({
    payer: request.user,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    instructions,
    budget,
  });
  return signAndSend({
    connection: a.connection,
    tx,
    payer: request.user,
    mintKeypair: prepared.mintKeypair,
    signTransaction: a.signTransaction,
    onPhase: a.onPhase,
  });
}
