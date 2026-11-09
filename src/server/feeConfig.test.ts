import { describe, expect, it } from 'vitest';
import { APP_FEE_WALLET } from '../spike/constants';
import { feeRecipientFromEnv } from './feeConfig';

describe('feeRecipientFromEnv', () => {
  it('falls back to the pinned fee wallet when unset or blank', () => {
    expect(feeRecipientFromEnv(undefined)).toBe('FtuidxSaoNDeTuNTDuf9jLACVwqjgQeBwKTYC54f3GYp');
    expect(feeRecipientFromEnv('  ')).toBe(APP_FEE_WALLET);
  });
  it('uses a valid env address', () => {
    expect(feeRecipientFromEnv('Hy3LMfJfKq2TzeYs1f2vHo32Wy22qF6PaEbo3xVWYP8N')).toBe('Hy3LMfJfKq2TzeYs1f2vHo32Wy22qF6PaEbo3xVWYP8N');
  });
  it('fails closed on a bad value (never silently pays someone else)', () => {
    expect(() => feeRecipientFromEnv('sneaks.skr')).toThrow(/not a valid/);
    expect(() => feeRecipientFromEnv('0OIl')).toThrow(/not a valid/);
  });
});
