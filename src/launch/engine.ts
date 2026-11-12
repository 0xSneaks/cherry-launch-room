// Launch engine: every create_v2 option Pump exposes (SDK 4.3.1), as legacy transactions
// for Cherry to sign. Pure: no RPC, no signing, no sending. The caller resolves the quote
// (OnlinePumpSdk.resolveQuoteMint) and fetches Global / FeeConfig / QuoteControl.
//
// Options (VERIFIED in @pump-fun/pump-sdk 4.3.1 README + typings, pump-public-docs COIN_CREATION.md):
//   quote pair      SOL, a Global-whitelisted mint (USDC on mainnet), a QuoteControl mint, or a pump coin
//   dev buy         optional first buy in the quote, same tx as the create
//   mayhem mode     Global.mayhemModeEnabled; not on QuoteControl or pump-coin pairs (6071)
//   creator fee     custom rate, only on QuoteControl / pump-coin pairs, 1..Global.max, gate on
//   holder rewards  creator fee goes to holders; Global.isHolderRewardEnabled; no fee split possible
//   cashback        retired by Pump (6082): never offered
import { withAppReference } from '@cherrydotfun/miniapp-sdk/solana';
import {
  PUMP_SDK,
  creatorVaultPda,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  type FeeConfig,
  type Global,
  type QuoteControl,
  type QuoteTransferFee,
  type ResolvedQuoteMint,
} from '@pump-fun/pump-sdk';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { APP_SHARE_BPS, CHERRY_APP_ID, TX_BYTE_LIMIT, USER_SHARE_BPS } from '../spike/constants.js';
import { assertRecipientNotSigner } from './guard.js';
import { HOLDER_REWARD_ALLOWED, LIMITS, TOKEN_QUOTE_CU } from './policy.js';

export interface CoinMeta {
  name: string;
  symbol: string;
  /** Metadata JSON (image, description, socials) already pinned to IPFS. */
  uri: string;
}

export interface LaunchRequest {
  /** Cherry wallet: creator, fee payer, only wallet signer. */
  wallet: PublicKey;
  /** Fresh per-launch mint (keypair in memory only; co-signs after Cherry). */
  mint: PublicKey;
  coin: CoinMeta;
  /** null = SOL. Otherwise the result of OnlinePumpSdk.resolveQuoteMint. */
  quote: ResolvedQuoteMint | null;
  /** First buy in quote base units (lamports for SOL). null = no dev buy. */
  devBuy: BN | null;
  mayhemMode: boolean;
  /** Custom creator fee (bps). Only QuoteControl / pump-coin pairs. */
  creatorFeeBps: BN | null;
  holderReward: boolean;
}

export interface LaunchContext {
  global: Global;
  feeConfig: FeeConfig | null;
  quoteControl: QuoteControl | null;
  quoteTransferFee?: QuoteTransferFee | null;
  recentBlockhash: string;
  /** 5% recipient. Must differ from the wallet. */
  appFeeRecipient: PublicKey;
  /** Percent on top of the dev buy's cost cap (SDK default 1). */
  slippagePct?: number;
}

export interface LaunchPlan {
  /** In signing and sending order. Send tx[i+1] only after tx[i] confirms. */
  txs: Transaction[];
  /** What each tx does, for the wallet label and the confirm screen. */
  steps: string[];
  /** Wire size per tx (all signature slots filled). */
  bytes: number[];
  feeSplit: boolean;
}

const isSol = (q: ResolvedQuoteMint | null) => !q || q.source === 'sol';
const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Every rule the program (or PetalDeck policy) enforces, as plain messages. Empty = OK. */
export function validateLaunch(req: LaunchRequest, ctx: LaunchContext): string[] {
  const errs: string[] = [];
  const { coin, quote } = req;
  const { global } = ctx;

  if (!coin.name.trim()) errs.push('Name is required.');
  if (byteLen(coin.name) > LIMITS.name) errs.push(`Name is too long (max ${LIMITS.name} bytes).`);
  if (!coin.symbol.trim()) errs.push('Ticker is required.');
  if (byteLen(coin.symbol) > LIMITS.symbol) errs.push(`Ticker is too long (max ${LIMITS.symbol} bytes).`);
  if (!/^https:\/\//.test(coin.uri)) errs.push('Metadata link must be https.');
  if (byteLen(coin.uri) > LIMITS.uri) errs.push(`Metadata link is too long (max ${LIMITS.uri} bytes).`);

  if (!global.createV2Enabled) errs.push('Pump has paused new coins right now.');

  const exotic = quote?.source === 'quoteControl' || quote?.source === 'pumpCoin';
  if (req.mayhemMode) {
    if (!global.mayhemModeEnabled) errs.push('Mayhem mode is switched off by Pump right now.');
    if (exotic) errs.push('Mayhem mode only works with a SOL or USDC pair.');
  }

  if (req.creatorFeeBps && !req.creatorFeeBps.isZero()) {
    if (!exotic) errs.push('A custom creator fee only works on custom pairs (not SOL or USDC).');
    else if (!global.creatorFeeConfigurable) errs.push('Pump has custom creator fees switched off right now.');
    else if (req.creatorFeeBps.ltn(1) || req.creatorFeeBps.gt(global.maxConfigurableCreatorFeeBps)) {
      errs.push(`Creator fee must be between 0.01% and ${global.maxConfigurableCreatorFeeBps.toNumber() / 100}%.`);
    }
  }

  if (req.holderReward) {
    if (!HOLDER_REWARD_ALLOWED) errs.push('Holder rewards are not available in PetalDeck yet.');
    else if (!global.isHolderRewardEnabled) errs.push('Pump has holder rewards switched off right now.');
  }

  if (req.devBuy && req.devBuy.lten(0)) errs.push('Dev buy must be more than 0.');
  if (req.wallet.equals(ctx.appFeeRecipient)) errs.push('Fee recipient must differ from your wallet.');
  return errs;
}

/** 0-lamport wallet→wallet transfer carrying the Cherry reference key (static account, never in a lookup table). */
export function referenceInstruction(wallet: PublicKey): TransactionInstruction {
  return withAppReference(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 0 }), CHERRY_APP_ID);
}

export function feeShareholders(wallet: PublicKey, appFeeRecipient: PublicKey) {
  assertRecipientNotSigner(wallet, appFeeRecipient);
  return [
    { address: wallet, shareBps: USER_SHARE_BPS },
    { address: appFeeRecipient, shareBps: APP_SHARE_BPS },
  ];
}

/** The create, and (with a dev buy) the buy-side instructions that follow it. */
export interface CreateParts {
  /** Compute-unit limits for [create tx, buy tx] (token quotes only; empty for SOL). */
  cu: { create?: number; buy?: number };
  create: TransactionInstruction;
  /** User's token account + first buy. Empty without a dev buy. */
  buy: TransactionInstruction[];
}

/** create_v2 (+ the dev buy) for any quote. */
export async function createInstructions(req: LaunchRequest, ctx: LaunchContext): Promise<CreateParts> {
  const { wallet, mint, coin, quote } = req;
  const common = {
    mint,
    ...coin,
    creator: wallet,
    user: wallet,
    mayhemMode: req.mayhemMode,
    holderReward: req.holderReward || undefined,
    creatorFeeBps: req.creatorFeeBps ?? undefined,
  };
  const token = !isSol(quote);
  const quoteArgs = token
    ? { quoteMint: quote!.mint, quoteTokenProgram: quote!.quoteTokenProgram ?? TOKEN_PROGRAM_ID, pumpQuote: quote!.pumpQuote?.accounts }
    : {};
  const create = await PUMP_SDK.createV2Instruction({ ...common, ...quoteArgs });
  const cu = token ? { create: TOKEN_QUOTE_CU.create, buy: TOKEN_QUOTE_CU.buy } : {};
  if (!req.devBuy) return { cu, create, buy: [] };

  const amount = getBuyTokenAmountFromSolAmount({
    global: ctx.global,
    feeConfig: ctx.feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: req.devBuy,
    quoteMint: token ? quote!.mint : NATIVE_MINT,
    quoteControl: ctx.quoteControl,
    creatorFeeBps: req.creatorFeeBps ?? undefined,
    pumpQuote: quote?.pumpQuote?.curve,
    quoteTransferFee: ctx.quoteTransferFee ?? null,
  });

  const all = token
    ? await PUMP_SDK.createV2AndBuyV2Instructions({
        ...common,
        ...quoteArgs,
        global: ctx.global,
        amount,
        quoteAmount: req.devBuy,
        slippage: ctx.slippagePct,
      })
    : // SOL: the legacy buy is the smallest (VERIFIED 1203 B with realistic metadata).
      await PUMP_SDK.createV2AndBuyInstructions({ ...common, global: ctx.global, amount, solAmount: req.devBuy });

  // The SDK returns [create_v2, ...buy side]. Prove ix 0 is exactly our standalone create.
  if (!all[0].programId.equals(create.programId) || !all[0].data.equals(create.data)) {
    throw new Error('Pump SDK create-and-buy did not start with create_v2.');
  }
  return { cu, create: all[0], buy: all.slice(1) };
}

/** create_fee_sharing_config + update_fee_shares(_v2): user 95% / app 5%, set once, forever. */
export async function feeShareInstructions(req: LaunchRequest, ctx: LaunchContext): Promise<TransactionInstruction[]> {
  const { wallet, mint, quote } = req;
  const newShareholders = feeShareholders(wallet, ctx.appFeeRecipient);
  const config = await PUMP_SDK.createFeeSharingConfig({ creator: wallet, mint, pool: null });
  if (isSol(quote)) {
    const update = await PUMP_SDK.updateFeeShares({ authority: wallet, mint, currentShareholders: [wallet], newShareholders, bondingCurveComplete: false });
    return [config, update];
  }
  const quoteTokenProgram = quote!.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const update = await PUMP_SDK.updateFeeSharesV2({
    authority: wallet,
    mint,
    currentShareholders: [wallet],
    newShareholders,
    quoteMint: quote!.mint,
    quoteTokenProgram,
    bondingCurveComplete: false,
  });
  return [config, sharingVaultAtaInstruction(wallet, mint, quote!.mint, quoteTokenProgram), update];
}

/**
 * Token-quoted coins only. create_fee_sharing_config moves the curve creator to the sharing
 * config, and update_fee_shares_v2 CPIs distribute_creator_fees_v2, which reads the quote ATA of
 * creatorVault(sharingConfig). Nothing creates that ATA, so without this the update fails with
 * InvalidAccountData (VERIFIED on a mainnet fork 2026-11-12, with and without a dev buy).
 * Idempotent; the wallet pays its rent.
 */
export function sharingVaultAtaInstruction(
  wallet: PublicKey,
  mint: PublicKey,
  quoteMint: PublicKey,
  quoteTokenProgram: PublicKey,
): TransactionInstruction {
  const vault = creatorVaultPda(feeSharingConfigPda(mint));
  const ata = getAssociatedTokenAddressSync(quoteMint, vault, true, quoteTokenProgram);
  return createAssociatedTokenAccountIdempotentInstruction(wallet, ata, vault, quoteMint, quoteTokenProgram);
}

export function serializedSize(tx: Transaction): number {
  const message = tx.serializeMessage();
  return 1 + message[0] * 64 + message.length;
}

const txOf = (req: LaunchRequest, ctx: LaunchContext, ixs: TransactionInstruction[]) =>
  new Transaction({ feePayer: req.wallet, recentBlockhash: ctx.recentBlockhash }).add(...ixs);

const cuIx = (units?: number) => (units ? [ComputeBudgetProgram.setComputeUnitLimit({ units })] : []);

/**
 * The launch as Cherry will sign it, all under ONE signAllTransactions approval:
 *   create (+ dev buy in the same tx when it fits) → dev buy on its own when it doesn't
 *   → fee split 95/5 + reference key.
 * Holder-reward coins have no creator to split: no split tx, the reference rides on the last tx
 * when it fits. Throws on a validation problem or a tx over 1232 B (deep migrated pump-coin
 * chains: Pump says those need a lookup table).
 */
export async function buildLaunch(req: LaunchRequest, ctx: LaunchContext): Promise<LaunchPlan> {
  const errs = validateLaunch(req, ctx);
  if (errs.length) throw new LaunchValidationError(errs);

  const parts = await createInstructions(req, ctx);
  const txs: Transaction[] = [];
  const steps: string[] = [];
  const feeSplit = !req.holderReward;

  const atomic = parts.buy.length
    ? txOf(req, ctx, [...cuIx(parts.cu.create && parts.cu.buy ? TOKEN_QUOTE_CU.createAndBuy : undefined), parts.create, ...parts.buy])
    : null;
  if (atomic && serializedSize(atomic) <= TX_BYTE_LIMIT) {
    txs.push(atomic);
    steps.push('Create coin + first buy');
  } else {
    txs.push(txOf(req, ctx, [...cuIx(parts.cu.create), parts.create]));
    steps.push('Create coin');
    if (parts.buy.length) {
      txs.push(txOf(req, ctx, [...cuIx(parts.cu.buy), ...parts.buy]));
      steps.push('First buy (sent right after the create; capped by slippage)');
    }
  }

  if (feeSplit) {
    txs.push(txOf(req, ctx, [...(await feeShareInstructions(req, ctx)), referenceInstruction(req.wallet)]));
    steps.push('Set creator fees: you 95% / PetalDeck 5% (permanent)');
  } else {
    const last = txs[txs.length - 1];
    const withRef = txOf(req, ctx, [...last.instructions, referenceInstruction(req.wallet)]);
    if (serializedSize(withRef) <= TX_BYTE_LIMIT) txs[txs.length - 1] = withRef;
  }

  const bytes = txs.map(serializedSize);
  const over = bytes.findIndex((b) => b > TX_BYTE_LIMIT);
  if (over >= 0) throw new LaunchTooLargeError(steps[over], bytes[over]);
  return { txs, steps, bytes, feeSplit };
}

export class LaunchValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'LaunchValidationError';
  }
}

export class LaunchTooLargeError extends Error {
  constructor(public readonly step: string, public readonly bytes: number) {
    super(`This pair is too complex to launch from Cherry yet ("${step}" is ${bytes} bytes, limit ${TX_BYTE_LIMIT}).`);
    this.name = 'LaunchTooLargeError';
  }
}
