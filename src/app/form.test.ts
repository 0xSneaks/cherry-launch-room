import { describe, expect, it } from 'vitest';
import { FEE_LINE, ROUTES } from './config';
import { buyError, emptyForm, normalizeTicker, parseAmount, requiredErrors, validateForm, type LaunchForm, type PumpLimits } from './form';
import { routeFor } from './launch';

const png = { type: 'image/png', size: 1000 };
const ready = (over: Partial<LaunchForm> = {}): LaunchForm => ({ ...emptyForm(), name: 'Cherry Blossom', ticker: 'PETAL', media: png, ...over });
const open: PumpLimits = { mayhemEnabled: true };
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

describe('Create button gate: name + ticker + image', () => {
  it('empty form: all three required', () => {
    expect(Object.keys(requiredErrors(emptyForm())).sort()).toEqual(['media', 'name', 'ticker']);
  });
  it('valid → no required errors; video counts as the image', () => {
    expect(requiredErrors(ready())).toEqual({});
    expect(requiredErrors(ready({ media: { type: 'video/mp4', size: 20 * 1024 * 1024 } }))).toEqual({});
  });
  it('size + type rules', () => {
    expect(requiredErrors(ready({ media: { type: 'application/pdf', size: 10 } })).media).toMatch(/PNG/);
    expect(requiredErrors(ready({ media: { type: 'image/jpeg', size: 16 * 1024 * 1024 } })).media).toMatch(/15 MB/);
    expect(requiredErrors(ready({ media: { type: 'video/webm', size: 31 * 1024 * 1024 } })).media).toMatch(/30 MB/);
  });
  it('name over 32 bytes', () => {
    expect(requiredErrors(ready({ name: 'x'.repeat(33) })).name).toMatch(/32/);
  });
});

describe('optional fields', () => {
  it('links must be https and on the right host', () => {
    const e = validateForm(ready({ website: 'http://a.com', x: 'https://evil.com/x', telegram: 'https://t.me/petal' }), open);
    expect(e.website).toBeTruthy();
    expect(e.x).toBeTruthy();
    expect(e.telegram).toBeUndefined();
  });
  it('banner: image only, ≤ 5 MB', () => {
    expect(validateForm(ready({ banner: { type: 'video/mp4', size: 10 } }), open).banner).toBeTruthy();
    expect(validateForm(ready({ banner: { type: 'image/png', size: 6 * 1024 * 1024 } }), open).banner).toMatch(/5 MB/);
    expect(validateForm(ready({ banner: { type: 'image/png', size: 100 } }), open).banner).toBeUndefined();
  });
  it('custom pair needs a valid mint', () => {
    expect(validateForm(ready({ pair: 'CUSTOM', customMint: 'nope' }), open).customMint).toMatch(/valid/);
    expect(validateForm(ready({ pair: 'CUSTOM', customMint: MINT }), open).customMint).toBeUndefined();
  });
  it('holders is not selectable yet', () => {
    expect(validateForm(ready({ rewards: 'holders' }), open).rewards).toMatch(/soon/i);
  });
  it('mayhem: SOL/USDC only, and only when Pump has it on', () => {
    expect(validateForm(ready({ mayhem: true }), open).mayhem).toBeUndefined();
    expect(validateForm(ready({ mayhem: true, pair: 'CUSTOM', customMint: MINT }), open).mayhem).toBeTruthy();
    expect(validateForm(ready({ mayhem: true }), { mayhemEnabled: false }).mayhem).toBeTruthy();
  });
});

describe('buy sheet amount', () => {
  it('parses in the pair unit; empty = skip', () => {
    expect(parseAmount('0.5', 9).toString()).toBe('500000000');
    expect(parseAmount('1', 6).toString()).toBe('1000000');
    expect(buyError('', 9)).toBeUndefined();
    expect(buyError('abc', 9)).toBeTruthy();
    expect(buyError('0.0000001', 6)).toMatch(/decimals/);
    expect(buyError('0', 9)).toMatch(/more than 0/);
  });
});

describe('harness routing', () => {
  it('SOL → C+D shapes, USDC → F, Custom → H, Mayhem → G', () => {
    expect(routeFor({ pair: 'SOL', mayhem: false })).toEqual(['C', 'D']);
    expect(routeFor({ pair: 'USDC', mayhem: false })).toEqual(['F']);
    expect(routeFor({ pair: 'CUSTOM', mayhem: false })).toEqual(['H']);
    expect(routeFor({ pair: 'SOL', mayhem: true })).toEqual(['G']);
    expect(routeFor({ pair: 'USDC', mayhem: true })).toEqual(ROUTES.MAYHEM);
  });
});
