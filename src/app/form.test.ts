import { describe, expect, it } from 'vitest';
import { FEE_LINE } from './config';
import { emptyForm, normalizeTicker, parseAmount, requiredErrors, validateForm, type LaunchForm, type PumpLimits } from './form';

const png = { type: 'image/png', size: 1000 };
const ready = (over: Partial<LaunchForm> = {}): LaunchForm => ({ ...emptyForm(), name: 'Cherry Blossom', ticker: 'PETAL', image: png, ...over });
const open: PumpLimits = { mayhemEnabled: true, creatorFeeConfigurable: true, maxCreatorFeeBps: 250 };
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('fee line', () => {
  it('is the exact copy Sneaks asked for (derived from the pinned 95/5 split)', () => {
    expect(FEE_LINE).toBe('PetalDeck takes 5% of creator fees. You keep 95%.');
  });
});

describe('ticker', () => {
  it('uppercases, strips spaces, caps at Pump’s 13-byte limit', () => {
    expect(normalizeTicker('pe tal')).toBe('PETAL');
    expect(normalizeTicker('abcdefghijklmnopq')).toBe('ABCDEFGHIJKLM');
  });
});

describe('required fields gate the Create button', () => {
  it('empty form: name, ticker and image all required', () => {
    expect(Object.keys(requiredErrors(emptyForm())).sort()).toEqual(['image', 'name', 'ticker']);
  });
  it('valid name + ticker + image → no required errors', () => {
    expect(requiredErrors(ready())).toEqual({});
  });
  it('rejects non-images and >15 MB', () => {
    expect(requiredErrors(ready({ image: { type: 'application/pdf', size: 10 } })).image).toMatch(/PNG/);
    expect(requiredErrors(ready({ image: { type: 'image/jpeg', size: 16 * 1024 * 1024 } })).image).toMatch(/15 MB/);
  });
  it('name over 32 bytes', () => {
    expect(requiredErrors(ready({ name: 'x'.repeat(33) })).name).toMatch(/32/);
  });
});

describe('optional fields', () => {
  it('links must be https and on the right host', () => {
    const e = validateForm(ready({ website: 'http://a.com', x: 'https://evil.com/x', telegram: 'https://t.me/petal' }), open, 9);
    expect(e.website).toBeTruthy();
    expect(e.x).toBeTruthy();
    expect(e.telegram).toBeUndefined();
  });
  it('custom pair needs a valid mint', () => {
    expect(validateForm(ready({ pair: 'CUSTOM', customMint: 'nope' }), open, 9).customMint).toMatch(/valid/);
    expect(validateForm(ready({ pair: 'CUSTOM', customMint: MINT }), open, 9).customMint).toBeUndefined();
  });
  it('initial buy parses in the pair unit', () => {
    expect(parseAmount('0.5', 9).toString()).toBe('500000000');
    expect(parseAmount('1', 6).toString()).toBe('1000000');
    expect(() => parseAmount('0.0000001', 6)).toThrow(/decimals/);
    expect(() => parseAmount('0', 9)).toThrow(/more than 0/);
    expect(validateForm(ready({ initialBuy: 'abc' }), open, 9).initialBuy).toBeTruthy();
  });
  it('mayhem: SOL/USDC only, and only when Pump has it on', () => {
    expect(validateForm(ready({ mayhem: true }), open, 9).mayhem).toBeUndefined();
    expect(validateForm(ready({ mayhem: true, pair: 'CUSTOM', customMint: MINT }), open, 9).mayhem).toBeTruthy();
    expect(validateForm(ready({ mayhem: true }), { ...open, mayhemEnabled: false }, 9).mayhem).toBeTruthy();
  });
  it('creator fee respects Pump’s live max and custom pairs only', () => {
    const custom = { pair: 'CUSTOM' as const, customMint: MINT };
    expect(validateForm(ready({ ...custom, creatorFeePct: '2.5' }), open, 9).creatorFeePct).toBeUndefined();
    expect(validateForm(ready({ ...custom, creatorFeePct: '2.6' }), open, 9).creatorFeePct).toMatch(/2.5%/);
    expect(validateForm(ready({ creatorFeePct: '1' }), open, 9).creatorFeePct).toBeTruthy();
    expect(validateForm(ready({ ...custom, creatorFeePct: '1' }), { ...open, creatorFeeConfigurable: false }, 9).creatorFeePct).toBeTruthy();
  });
});
