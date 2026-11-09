// PetalDeck main-screen config. UI knobs only; the money-path constants stay in src/spike/constants.ts.
import { APP_SHARE_BPS, USER_SHARE_BPS } from '../spike/constants';

/**
 * Which harness variant the main form launches with. 'engine' = the full-option launch engine
 * (src/launch/engine.ts) that harness F/G/H exercise: create (+ first buy) → 95/5 fee split + reference,
 * all under one signAllTransactions approval. Change only after Sneaks approves a variant from the harness.
 */
export const LAUNCH_VARIANT = 'engine' as const;

/**
 * 'dry-run' = Cherry signs, the signed bytes are dropped, nothing is sent.
 * There is no 'live' mode: sending needs Sneaks's approval and send + metadata-pin wiring first.
 */
export const LAUNCH_MODE = 'dry-run' as const;

/** Wallet sheet label in dry-run (≤ 80 chars). Says plainly that nothing is sent. */
export const DRY_RUN_LABEL = 'TEST — sign only, will not be sent';

/**
 * Metadata link used in dry-run (realistic Pinata CIDv1 length so byte sizes are real). Never fetched:
 * nothing is sent. Live mode must pin the real image + metadata first.
 */
export const DRY_RUN_METADATA_URI = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** Quick chips for the initial buy, in the pair's unit. */
export const QUICK_BUYS = ['0.1', '0.5', '1'] as const;

/** ASSUMPTION: pump.fun's create form caps the description around this; metadata JSON only, not on-chain. */
export const DESCRIPTION_MAX = 500;

/** ASSUMPTION: pump.fun accepts images up to 15 MB. */
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const pct = (bps: number) => `${bps / 100}%`;

/** Plain fee line, derived from the pinned split so it can never disagree with the transaction. */
export const FEE_LINE = `PetalDeck takes ${pct(APP_SHARE_BPS)} of creator fees. You keep ${pct(USER_SHARE_BPS)}.`;
export const FEE_SPLIT_SHORT = `You ${pct(USER_SHARE_BPS)} · PetalDeck ${pct(APP_SHARE_BPS)}`;

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
