// Create-coin form: state shape + validation. Pure (no DOM, no RPC) so it is unit-tested.
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { LIMITS } from '../launch/policy';
import { BANNER_MAX_BYTES, DESCRIPTION_MAX, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES } from './config';

export type Pair = 'SOL' | 'USDC' | 'CUSTOM';
export type Rewards = 'creator' | 'holders';

export interface FileInfo {
  type: string;
  size: number;
}

export interface LaunchForm {
  name: string;
  ticker: string;
  description: string;
  /** Coin image or video. */
  media: FileInfo | null;
  /** Optional wide banner image. */
  banner: FileInfo | null;
  website: string;
  x: string;
  telegram: string;
  pair: Pair;
  customMint: string;
  /** Who gets creator rewards. 'holders' = Pump holder rewards (no 95/5 split: PetalDeck earns 0). */
  rewards: Rewards;
  mayhem: boolean;
  /** Decimal string in the pair's unit, set in the buy sheet. Empty = no initial buy. */
  initialBuy: string;
}

/** What Pump allows right now (read from chain). null = not loaded. */
export interface PumpLimits {
  mayhemEnabled: boolean;
  /** Pump Global.isHolderRewardEnabled. */
  holdersEnabled?: boolean;
}

export type Field = keyof LaunchForm;
export type FieldErrors = Partial<Record<Field, string>>;

export const emptyForm = (): LaunchForm => ({
  name: '',
  ticker: '',
  description: '',
  media: null,
  banner: null,
  website: '',
  x: '',
  telegram: '',
  pair: 'SOL',
  customMint: '',
  rewards: 'creator',
  mayhem: false,
  initialBuy: '',
});

const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Uppercase, no spaces, cut to Pump's on-chain symbol limit. */
export function normalizeTicker(raw: string): string {
  let t = raw.toUpperCase().replace(/\s+/g, '');
  while (byteLen(t) > LIMITS.symbol) t = t.slice(0, -1);
  return t;
}

export function unitOf(pair: Pair): string {
  return pair === 'SOL' ? 'SOL' : pair === 'USDC' ? 'USDC' : 'tokens';
}

export function isValidMint(s: string): boolean {
  try {
    return new PublicKey(s.trim()).toBytes().length === 32 && s.trim().length >= 32;
  } catch {
    return false;
  }
}

/** "1.5" with 9 decimals → 1_500_000_000. Throws a user-facing message on bad input. */
export function parseAmount(raw: string, decimals: number): BN {
  const s = raw.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('Enter a number, like 0.5.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimals.`);
  const units = new BN(whole || '0').mul(new BN(10).pow(new BN(decimals))).add(new BN(frac.padEnd(decimals, '0') || '0'));
  if (units.isZero()) throw new Error('Must be more than 0.');
  return units;
}

function httpsUrl(s: string, hosts?: string[]): boolean {
  try {
    const u = new URL(s.trim());
    if (u.protocol !== 'https:') return false;
    return !hosts || hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;
const VIDEO_TYPES = /^video\/(mp4|webm)$/;
export const isVideo = (f: FileInfo | null) => !!f && VIDEO_TYPES.test(f.type);

export function mediaError(f: FileInfo | null): string | undefined {
  if (!f) return 'Add an image or video.';
  if (IMAGE_TYPES.test(f.type)) return f.size > IMAGE_MAX_BYTES ? 'Images must be 15 MB or less.' : undefined;
  if (VIDEO_TYPES.test(f.type)) return f.size > VIDEO_MAX_BYTES ? 'Videos must be 30 MB or less.' : undefined;
  return 'Use PNG, JPG, GIF, WebP, MP4 or WebM.';
}

/** The three fields that gate the Create button: name, ticker, image. */
export function requiredErrors(f: LaunchForm): FieldErrors {
  const e: FieldErrors = {};
  if (!f.name.trim()) e.name = 'Give your coin a name.';
  else if (byteLen(f.name) > LIMITS.name) e.name = `Max ${LIMITS.name} characters.`;
  if (!f.ticker) e.ticker = 'Add a ticker.';
  else if (byteLen(f.ticker) > LIMITS.symbol) e.ticker = `Max ${LIMITS.symbol} characters.`;
  const m = mediaError(f.media);
  if (m) e.media = m;
  return e;
}

/** Every inline error on the main form (the buy amount is checked in the buy sheet). */
export function validateForm(f: LaunchForm, limits: PumpLimits | null): FieldErrors {
  const e = requiredErrors(f);
  if (f.description.length > DESCRIPTION_MAX) e.description = `Max ${DESCRIPTION_MAX} characters.`;
  if (f.banner) {
    if (!IMAGE_TYPES.test(f.banner.type)) e.banner = 'Banner must be PNG, JPG, GIF or WebP.';
    else if (f.banner.size > BANNER_MAX_BYTES) e.banner = 'Banner must be 5 MB or less.';
  }
  if (f.website && !httpsUrl(f.website)) e.website = 'Use a full https:// link.';
  if (f.x && !httpsUrl(f.x, ['x.com', 'twitter.com'])) e.x = 'Use an https://x.com/… link.';
  if (f.telegram && !httpsUrl(f.telegram, ['t.me', 'telegram.me'])) e.telegram = 'Use an https://t.me/… link.';
  if (f.pair === 'CUSTOM' && !isValidMint(f.customMint)) {
    e.customMint = f.customMint.trim() ? 'Not a valid token mint address.' : 'Paste the pair token mint.';
  }
  if (f.rewards === 'holders' && limits && limits.holdersEnabled === false) e.rewards = 'Pump has holder rewards switched off right now.';
  if (f.mayhem) {
    if (f.pair === 'CUSTOM') e.mayhem = 'Mayhem mode works with SOL or USDC only.';
    else if (limits && !limits.mayhemEnabled) e.mayhem = 'Pump has mayhem mode off right now.';
  }
  return e;
}

/** Buy-sheet amount check. Empty = skip. */
export function buyError(raw: string, decimals: number): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    parseAmount(raw, decimals);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;
