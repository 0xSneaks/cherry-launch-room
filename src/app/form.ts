// Create-coin form: state shape + validation. Pure (no DOM, no RPC) so it is unit-tested.
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { LIMITS } from '../launch/policy';
import { DESCRIPTION_MAX, IMAGE_MAX_BYTES } from './config';

export type Pair = 'SOL' | 'USDC' | 'CUSTOM';

export interface ImageInfo {
  type: string;
  size: number;
}

export interface LaunchForm {
  name: string;
  ticker: string;
  description: string;
  image: ImageInfo | null;
  website: string;
  x: string;
  telegram: string;
  pair: Pair;
  customMint: string;
  /** Decimal string in the pair's unit. Empty = no initial buy. */
  initialBuy: string;
  mayhem: boolean;
  /** Percent, e.g. "1.5". Empty = Pump default. Custom pairs only. */
  creatorFeePct: string;
}

/** What Pump allows right now (read from chain). null = not loaded. */
export interface PumpLimits {
  mayhemEnabled: boolean;
  creatorFeeConfigurable: boolean;
  maxCreatorFeeBps: number;
}

export type Field = keyof LaunchForm;
export type FieldErrors = Partial<Record<Field, string>>;

export const emptyForm = (): LaunchForm => ({
  name: '',
  ticker: '',
  description: '',
  image: null,
  website: '',
  x: '',
  telegram: '',
  pair: 'SOL',
  customMint: '',
  initialBuy: '',
  mayhem: false,
  creatorFeePct: '',
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

/** Percent string → bps. "1.25" → 125. */
export function pctToBps(raw: string): number {
  const n = Number(raw.trim());
  if (!/^\d*\.?\d{0,2}$/.test(raw.trim()) || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
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

/** The three fields that gate the Create button. */
export function requiredErrors(f: LaunchForm): FieldErrors {
  const e: FieldErrors = {};
  if (!f.name.trim()) e.name = 'Name is required.';
  else if (byteLen(f.name) > LIMITS.name) e.name = `Max ${LIMITS.name} characters.`;
  if (!f.ticker) e.ticker = 'Ticker is required.';
  else if (byteLen(f.ticker) > LIMITS.symbol) e.ticker = `Max ${LIMITS.symbol} characters.`;
  if (!f.image) e.image = 'Add an image.';
  else if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.image.type)) e.image = 'Use PNG, JPG, GIF or WebP.';
  else if (f.image.size > IMAGE_MAX_BYTES) e.image = 'Image must be 15 MB or less.';
  return e;
}

/** Every inline error. `decimals` = pair token decimals (SOL 9, USDC 6, custom from chain). */
export function validateForm(f: LaunchForm, limits: PumpLimits | null, decimals: number): FieldErrors {
  const e = requiredErrors(f);
  if (f.description.length > DESCRIPTION_MAX) e.description = `Max ${DESCRIPTION_MAX} characters.`;
  if (f.website && !httpsUrl(f.website)) e.website = 'Use a full https:// link.';
  if (f.x && !httpsUrl(f.x, ['x.com', 'twitter.com'])) e.x = 'Use an https://x.com/… link.';
  if (f.telegram && !httpsUrl(f.telegram, ['t.me', 'telegram.me'])) e.telegram = 'Use an https://t.me/… link.';
  if (f.pair === 'CUSTOM' && !isValidMint(f.customMint)) {
    e.customMint = f.customMint.trim() ? 'Not a valid token mint address.' : 'Paste the pair token mint.';
  }
  if (f.initialBuy.trim()) {
    try {
      parseAmount(f.initialBuy, decimals);
    } catch (err) {
      e.initialBuy = (err as Error).message;
    }
  }
  if (f.mayhem) {
    if (f.pair === 'CUSTOM') e.mayhem = 'Mayhem mode only works with a SOL or USDC pair.';
    else if (limits && !limits.mayhemEnabled) e.mayhem = 'Pump has mayhem mode off right now.';
  }
  if (f.creatorFeePct.trim()) {
    const bps = pctToBps(f.creatorFeePct);
    if (f.pair !== 'CUSTOM') e.creatorFeePct = 'Custom creator fee only works on custom pairs.';
    else if (!limits?.creatorFeeConfigurable) e.creatorFeePct = 'Pump has custom creator fees off right now.';
    else if (!(bps >= 1 && bps <= limits.maxCreatorFeeBps)) e.creatorFeePct = `Between 0.01% and ${limits.maxCreatorFeeBps / 100}%.`;
  }
  return e;
}

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;
