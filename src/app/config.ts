// PetalDeck main-screen config. UI knobs only; the money-path constants stay in src/spike/constants.ts.
import { APP_SHARE_BPS, USER_SHARE_BPS } from '../spike/constants';

/**
 * Which harness variant each form choice launches with. All of them build through the unchanged engine
 * (src/launch/engine.ts), the same builder harness F/G/H call:
 *   SOL        → C + D shapes: [create (+ buy)] then [95/5 split + reference]
 *   USDC       → F
 *   Custom     → H (no custom creator fee from this form)
 *   Mayhem on  → G (SOL or USDC pair)
 */
export type HarnessVariant = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export const ROUTES = { SOL: ['C', 'D'], USDC: ['F'], CUSTOM: ['H'], MAYHEM: ['G'] } as const satisfies Record<string, readonly HarnessVariant[]>;

/**
 * Harness results from Sneaks's in-Cherry run, 2026-11-12 (tier verified): A, B, C, D, F, H SIGNED; E is
 * measure-only; G not run yet. The 2026-11-09 DANGEROUS_INSTRUCTION refusals no longer reproduce.
 * Every fee-share tx passes simulation once its create runs first (docs/launch-flow.md).
 * A future live mode must refuse any route whose variants are not all 'signed'.
 */
export const HARNESS_RESULTS: Record<HarnessVariant, 'untested' | 'signed' | 'refused'> = {
  A: 'signed', B: 'signed', C: 'signed', D: 'signed', E: 'untested', F: 'signed', G: 'untested', H: 'signed',
};

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

/** ASSUMPTION (pump.fun create form, not verified here): images ≤ 15 MB, videos ≤ 30 MB, banner ≤ 5 MB. */
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

const pct = (bps: number) => `${bps / 100}%`;

/** Plain fee line, derived from the pinned split so it can never disagree with the transaction. */
export const FEE_LINE = `PetalDeck takes ${pct(APP_SHARE_BPS)} of creator fees. You keep ${pct(USER_SHARE_BPS)}.`;
export const FEE_SPLIT_SHORT = `You ${pct(USER_SHARE_BPS)} · PetalDeck ${pct(APP_SHARE_BPS)}`;

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
