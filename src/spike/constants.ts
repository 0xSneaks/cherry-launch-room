// Money-path constants. Any change needs Sneaks's yes (see ai-coms projects/cherry-launch-room.md).

/** Cherry App ID (= `aud` / `app_id` of every launch token). */
export const CHERRY_APP_ID = '52e41534-4c7b-4237-9a16-ec8ea7a3c9dc';

/**
 * Launch Room's 5% fee-share recipient (OWNER, Sneaks 2026-11-09 04:03).
 * Raw base58 only, never the .skr name.
 */
export const APP_FEE_WALLET = 'FtuidxSaoNDeTuNTDuf9jLACVwqjgQeBwKTYC54f3GYp';

/** Creator-fee split in basis points. User keeps 95%, app takes 5%. Set once, on-chain, forever. */
export const USER_SHARE_BPS = 9500;
export const APP_SHARE_BPS = 500;

/** Variant C first buy: 0.01 SOL. */
export const SPIKE_BUY_LAMPORTS = 10_000_000;

/** Solana legacy/v0 packet limit for a serialized transaction. */
export const TX_BYTE_LIMIT = 1232;

/** Shown in Cherry's wallet sheet for every spike request (≤ 80 chars). */
export const SPIKE_LABEL = 'TEST — sign only, will not be sent';
