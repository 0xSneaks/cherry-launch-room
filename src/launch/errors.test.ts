import { BridgeError } from '@cherrydotfun/miniapp-sdk';
import { CashbackDeprecatedError, UnsupportedQuoteMintError } from '@pump-fun/pump-sdk';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { LaunchTooLargeError, LaunchValidationError } from './engine';
import { UNKNOWN_LAUNCH_ERROR, explainLaunchError } from './errors';

describe('every launch error becomes one plain sentence', () => {
  it('Cherry: user cancel, policy codes, safety blocks', () => {
    expect(explainLaunchError(new BridgeError('x', 'USER_REJECTED'))).toMatch(/cancelled/);
    expect(explainLaunchError(new BridgeError('x', 'POLICY_DENIED', { code: 'TX_LIMIT', reason: 'r' }))).toMatch(/per-transaction limit/);
    expect(explainLaunchError(new BridgeError('x', 'DANGEROUS_INSTRUCTION'))).toMatch(/blocked/);
  });
  it('Pump program codes from logs or simulation errors', () => {
    expect(explainLaunchError({ InstructionError: [0, { Custom: 6071 }] })).toMatch(/Mayhem/);
    expect(explainLaunchError(new Error('custom program error: 0x17b7'))).toMatch(/Mayhem/); // 0x17b7 = 6071
  });
  it('Pump SDK typed errors', () => {
    expect(explainLaunchError(new UnsupportedQuoteMintError(PublicKey.default))).toMatch(/pair token/);
    expect(explainLaunchError(new CashbackDeprecatedError(PublicKey.default))).toMatch(/cashback/);
  });
  it('our own validation and size errors', () => {
    expect(explainLaunchError(new LaunchValidationError(['Name is required.']))).toBe('Name is required.');
    expect(explainLaunchError(new LaunchTooLargeError('Create coin', 1266))).toMatch(/too complex/);
  });
  it('never leaks raw text for unknown errors', () => {
    expect(explainLaunchError(new Error('secret internal stack'))).toBe(UNKNOWN_LAUNCH_ERROR);
    expect(explainLaunchError(new Error('Transfer: insufficient lamports'))).toMatch(/Not enough balance/);
  });
});
