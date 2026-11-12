// A–H test transactions, shared by the in-Cherry test page and the server sim suite.
// Builds only: no signing, no sending.
import type { OnlinePumpSdk, ResolvedQuoteMint } from '@pump-fun/pump-sdk';
import { PublicKey, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { buildLaunch, type LaunchRequest } from '../launch/engine.js';
import { assertRecipientNotSigner } from '../launch/guard.js';
import { VARIANTS, buildVariant, type Variant } from './build.js';
import { SPIKE_COIN } from './coin.js';

export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/** F–H go through the REAL launch engine (src/launch). */
export const ENGINE_VARIANTS = {
  F: 'USDC pair: create + 1 USDC first buy + 95/5 split (one approval)',
  G: 'Mayhem mode: create + 0.01 SOL first buy + 95/5 split',
  H: 'Custom pair (mint below): create + 95/5 split (+2.5% creator fee if Pump allows)',
} as const;
export type EngineVariant = keyof typeof ENGINE_VARIANTS;
export type AnyVariant = Variant | EngineVariant;
export const isEngine = (v: string): v is EngineVariant => v in ENGINE_VARIANTS;
export const ALL_VARIANTS: AnyVariant[] = [...(Object.keys(VARIANTS) as Variant[]), ...(Object.keys(ENGINE_VARIANTS) as EngineVariant[])];

export const F_USDC_BUY = new BN(1_000_000); // 1 USDC (6 decimals)
export const G_SOL_BUY = new BN(10_000_000); // 0.01 SOL

export interface VariantInput {
  pump: OnlinePumpSdk;
  wallet: PublicKey;
  mint: PublicKey;
  /** 5% recipient. Never the signing wallet (guard throws). */
  appFeeRecipient: PublicKey;
  recentBlockhash: string;
  /** H only: the pair mint. */
  pairMint?: PublicKey;
}

export interface BuiltVariant {
  txs: Transaction[];
  steps: string[];
  quote: ResolvedQuoteMint | null;
}

export async function buildAnyVariant(variant: AnyVariant, input: VariantInput): Promise<BuiltVariant> {
  const { pump, wallet, mint, appFeeRecipient, recentBlockhash } = input;
  assertRecipientNotSigner(wallet, appFeeRecipient);

  if (!isEngine(variant)) {
    const spec = VARIANTS[variant];
    const needsPump = spec.txs.some((t) => t.buy);
    const [global, feeConfig] = needsPump
      ? await Promise.all([pump.fetchGlobal(), pump.fetchFeeConfig().catch(() => null)])
      : [undefined, undefined];
    const txs = await buildVariant(variant, { wallet, mint, recentBlockhash, coin: SPIKE_COIN, global, feeConfig, appFeeRecipient });
    return { txs, steps: [spec.title], quote: null };
  }

  const [global, feeConfig, quoteControl] = await Promise.all([
    pump.fetchGlobal(),
    pump.fetchFeeConfig().catch(() => null),
    pump.fetchQuoteControl().catch(() => null),
  ]);
  let quote: ResolvedQuoteMint | null = null;
  if (variant === 'F') quote = await pump.resolveQuoteMint(USDC);
  if (variant === 'H') {
    if (!input.pairMint) throw new Error('Paste a pair mint for H (a pump coin or a listed token).');
    quote = await pump.resolveQuoteMint(input.pairMint);
  }
  const exotic = quote?.source === 'quoteControl' || quote?.source === 'pumpCoin';
  const req: LaunchRequest = {
    wallet,
    mint,
    coin: SPIKE_COIN,
    quote,
    devBuy: variant === 'F' ? F_USDC_BUY : variant === 'G' ? G_SOL_BUY : null,
    mayhemMode: variant === 'G',
    creatorFeeBps: exotic && global.creatorFeeConfigurable ? BN.min(new BN(250), global.maxConfigurableCreatorFeeBps) : null,
    holderReward: false,
  };
  const quoteTransferFee = quote && quote.source !== 'sol' ? await pump.fetchQuoteTransferFee(quote.mint).catch(() => null) : null;
  const plan = await buildLaunch(req, { global, feeConfig, quoteControl, quoteTransferFee, recentBlockhash, appFeeRecipient });
  return { txs: plan.txs, steps: plan.steps, quote };
}
