// The only module that talks to @pump-fun/pump-sdk. Verified against @pump-fun/pump-sdk@4.0.0
// and pump-public-docs (see docs/PUMPFUN_INTEGRATION.md).
import {
  type FeeConfig,
  type Global,
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { type Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { byteLength } from "../../shared/validation";
import { NAME_MAX_BYTES, SYMBOL_MAX_BYTES, URI_MAX_BYTES } from "../../shared/limits";
import type { LaunchPolicy } from "./policy";

/** createV2AndBuyInstructions applies a fixed 1% max-cost buffer to the first buy (SDK: slippage: 1). */
export const SDK_FIRST_BUY_SLIPPAGE_BPS = 100n;

export interface LaunchParams {
  mint: PublicKey;
  user: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  initialBuyLamports: bigint;
  policy: LaunchPolicy;
}

export interface PumpState {
  global: Global;
  feeConfig: FeeConfig | null;
}

export interface BuyQuote {
  solLamports: bigint;
  maxSolCostLamports: bigint;
  tokenAmount: bigint; // base units (6 decimals)
  supplyShareBps: number; // share of total supply, in basis points
}

export interface LaunchInstructions {
  instructions: TransactionInstruction[];
  quote: BuyQuote | null;
}

export function maxSolCost(lamports: bigint): bigint {
  return lamports + (lamports * SDK_FIRST_BUY_SLIPPAGE_BPS) / 10_000n;
}

function assertArgs(p: LaunchParams) {
  if (!p.name || byteLength(p.name) > NAME_MAX_BYTES) throw new Error("Invalid coin name length");
  if (!p.symbol || byteLength(p.symbol) > SYMBOL_MAX_BYTES) throw new Error("Invalid ticker length");
  if (!p.uri || byteLength(p.uri) > URI_MAX_BYTES) throw new Error("Invalid metadata URI length");
  if (p.user.equals(PublicKey.default)) throw new Error("Creator can't be the default public key");
  if (p.mint.equals(p.user)) throw new Error("Mint must be a fresh keypair");
  if (p.initialBuyLamports < 0n || p.initialBuyLamports > p.policy.maxInitialBuyLamports)
    throw new Error("Initial buy out of range");
}

/** Fetches the on-chain state the create-and-buy path needs. */
export async function fetchPumpState(connection: Connection, withBuy: boolean): Promise<PumpState> {
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    online.fetchGlobal(),
    withBuy ? online.fetchFeeConfig() : Promise.resolve(null),
  ]);
  return { global, feeConfig };
}

/**
 * Builds the Pump.fun instructions for a launch. Pure given `state`, so it is unit-testable.
 * - No initial buy: [create_v2]
 * - With initial buy: [create_v2, create user ATA (Token-2022, idempotent), buy]
 */
export async function buildLaunchInstructions(p: LaunchParams, state: PumpState | null): Promise<LaunchInstructions> {
  assertArgs(p);
  const flags = p.policy.createFlags();
  // Creator is always the connected wallet; the wallet also pays.
  const common = {
    mint: p.mint,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    creator: p.user,
    user: p.user,
    mayhemMode: flags.mayhemMode,
    holderReward: flags.holderReward,
  };

  if (p.initialBuyLamports === 0n) {
    return { instructions: [await PUMP_SDK.createV2Instruction(common)], quote: null };
  }

  if (!state) throw new Error("Pump state is required for an initial buy");
  const solAmount = new BN(p.initialBuyLamports.toString());
  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: solAmount,
    quoteMint: NATIVE_MINT,
  });
  if (tokenAmount.lten(0)) throw new Error("Initial buy is too small to receive any tokens");

  const instructions = await PUMP_SDK.createV2AndBuyInstructions({
    ...common,
    global: state.global,
    amount: tokenAmount,
    solAmount,
  });

  const totalSupply = BigInt(state.global.tokenTotalSupply.toString());
  const tokens = BigInt(tokenAmount.toString());
  return {
    instructions,
    quote: {
      solLamports: p.initialBuyLamports,
      maxSolCostLamports: maxSolCost(p.initialBuyLamports),
      tokenAmount: tokens,
      supplyShareBps: totalSupply > 0n ? Number((tokens * 10_000n) / totalSupply) : 0,
    },
  };
}
