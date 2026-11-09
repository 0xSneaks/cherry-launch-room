import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { describeSimulationFailure, LaunchError } from "./errors";

export const PACKET_DATA_SIZE = 1232;
export const SIMULATION_CU_LIMIT = 1_400_000;
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;
// Priority fee bounds (micro-lamports per CU). Our choice: enough to land during normal
// congestion without letting a fee spike drain users. At 400k CU the cap is 0.0008 SOL.
export const MIN_CU_PRICE = 50_000;
export const MAX_CU_PRICE = 2_000_000;

/**
 * A launch transaction either carries compute-budget instructions (CU limit + priority fee)
 * or not. Create + initial buy at realistic field lengths only fits Solana's 1232-byte
 * limit without them (see docs/PUMPFUN_INTEGRATION.md, "Transaction size"), so the builder
 * picks the richest layout that fits.
 */
export type BudgetPlan =
  | { kind: "priority"; computeUnitLimit: number; computeUnitPriceMicroLamports: number }
  | { kind: "default" };

export interface CompileArgs {
  payer: PublicKey;
  blockhash: string;
  lastValidBlockHeight?: number;
  instructions: TransactionInstruction[];
  budget: BudgetPlan;
}

/** Legacy transaction: the most widely supported format across wallets. */
export function compileLaunchTx(a: CompileArgs): Transaction {
  const tx = new Transaction({
    feePayer: a.payer,
    blockhash: a.blockhash,
    lastValidBlockHeight: a.lastValidBlockHeight ?? 0,
  });
  if (a.budget.kind === "priority") {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: a.budget.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.budget.computeUnitPriceMicroLamports }),
    );
  }
  tx.add(...a.instructions);
  return tx;
}

/** Wire size of the signed transaction, computed without signing. */
export function serializedSize(tx: Transaction): number {
  const msg = tx.compileMessage();
  const sigs = msg.header.numRequiredSignatures;
  const shortVecLen = sigs < 0x80 ? 1 : sigs < 0x4000 ? 2 : 3;
  return shortVecLen + 64 * sigs + msg.serialize().length;
}

const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/** Picks the richest budget layout whose transaction fits in one packet. */
export function chooseBudget(payer: PublicKey, instructions: TransactionInstruction[], cuPrice: number): BudgetPlan {
  const candidates: BudgetPlan[] = [
    { kind: "priority", computeUnitLimit: SIMULATION_CU_LIMIT, computeUnitPriceMicroLamports: cuPrice },
    { kind: "default" },
  ];
  for (const budget of candidates) {
    const tx = compileLaunchTx({ payer, blockhash: PLACEHOLDER_BLOCKHASH, instructions, budget });
    if (serializedSize(tx) <= PACKET_DATA_SIZE) return budget;
  }
  throw new LaunchError("This launch is too large for one Solana transaction. Shorten the name or ticker and try again.");
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function clampCuPrice(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_CU_PRICE;
  return Math.min(MAX_CU_PRICE, Math.max(MIN_CU_PRICE, Math.ceil(raw)));
}

export async function estimateCuPrice(connection: Connection): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    return clampCuPrice(percentile(fees.map((f) => f.prioritizationFee).filter((f) => f > 0), 75));
  } catch {
    return MIN_CU_PRICE;
  }
}

export function cuLimitFromSimulation(unitsConsumed: number | undefined): number {
  const units = unitsConsumed && unitsConsumed > 0 ? unitsConsumed : 400_000;
  return Math.min(SIMULATION_CU_LIMIT, Math.ceil(units * 1.2) + 10_000);
}

/** Upper bound on the network fee: base fee per signature plus any priority fee. */
export function maxNetworkFeeLamports(signatures: number, budget: BudgetPlan): bigint {
  const base = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(signatures);
  if (budget.kind === "default") return base;
  const priority = (BigInt(budget.computeUnitLimit) * BigInt(budget.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n;
  return base + priority;
}

export interface SimulationResult {
  unitsConsumed: number | undefined;
  /** Lamports leaving the wallet in the simulation (pre-balance minus post-balance). */
  walletDeltaLamports: bigint | null;
}

/** Simulates the launch without signatures (sigVerify off, blockhash replaced by the node). */
export async function simulateLaunch(connection: Connection, args: CompileArgs): Promise<SimulationResult> {
  const legacy = compileLaunchTx(args);
  const vtx = new VersionedTransaction(legacy.compileMessage());
  const [preBalance, sim] = await Promise.all([
    connection.getBalance(args.payer, "processed"),
    connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
      accounts: { encoding: "base64", addresses: [args.payer.toBase58()] },
    }),
  ]);
  if (sim.value.err) {
    throw new LaunchError(describeSimulationFailure(sim.value.err, sim.value.logs ?? []), sim.value.logs ?? []);
  }
  const post = sim.value.accounts?.[0]?.lamports;
  return {
    unitsConsumed: sim.value.unitsConsumed,
    walletDeltaLamports: typeof post === "number" ? BigInt(preBalance) - BigInt(post) : null,
  };
}

/**
 * Sanity checks on what the wallet hands back before the mint keypair co-signs it.
 * Wallets may add their own safety instructions, so we don't require byte equality,
 * only that the wallet paid, signed, and still expects the mint's signature.
 */
export function assertWalletSigned(tx: Transaction, payer: PublicKey, mint: PublicKey) {
  if (!tx.feePayer || !tx.feePayer.equals(payer)) throw new LaunchError("Your wallet changed the fee payer. Launch cancelled.");
  const payerSig = tx.signatures.find((s) => s.publicKey.equals(payer));
  if (!payerSig?.signature || payerSig.signature.every((b) => b === 0))
    throw new LaunchError("Your wallet didn't sign the transaction.");
  if (!tx.signatures.some((s) => s.publicKey.equals(mint)))
    throw new LaunchError("The transaction returned by your wallet is missing the new coin's mint. Launch cancelled.");
}
