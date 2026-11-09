import { BridgeError } from '@cherrydotfun/miniapp-sdk';
import { describe, expect, it } from 'vitest';
import { isKill, refusalFields, toMarkdown, type SpikeRow } from './result';

const row = (over: Partial<SpikeRow>): SpikeRow => ({ variant: 'A', result: 'REFUSED', bytes: [858], at: 'now', ...over });

describe('refusal mapping', () => {
  it('reads policyCode from POLICY_DENIED', () => {
    const f = refusalFields(new BridgeError('denied', 'POLICY_DENIED', { code: 'FORBIDDEN_INSTRUCTION', reason: 'SetAuthority' }));
    expect(f).toMatchObject({ result: 'REFUSED', code: 'POLICY_DENIED', policyCode: 'FORBIDDEN_INSTRUCTION' });
  });
  it('maps a non-bridge error to ERROR', () => {
    expect(refusalFields(new Error('boom')).result).toBe('ERROR');
  });
});

describe('kill rule', () => {
  it.each(['FORBIDDEN_INSTRUCTION'])('A + POLICY_DENIED/%s = KILL', (policyCode) => {
    expect(isKill(row({ code: 'POLICY_DENIED', policyCode }))).toBe(true);
  });
  it.each(['DANGEROUS_INSTRUCTION', 'UNSTATED_ROLE'])('A + %s = KILL', (code) => {
    expect(isKill(row({ code }))).toBe(true);
  });
  it('limits, rejection and other variants are not KILL', () => {
    expect(isKill(row({ code: 'POLICY_DENIED', policyCode: 'TX_LIMIT' }))).toBe(false);
    expect(isKill(row({ code: 'USER_REJECTED' }))).toBe(false);
    expect(isKill(row({ variant: 'B', code: 'UNSTATED_ROLE' }))).toBe(false);
    expect(isKill(row({ result: 'SIGNED' }))).toBe(false);
  });
});

it('renders a markdown table without any signature data', () => {
  const md = toMarkdown([row({ result: 'SIGNED', returnedBytes: [858], sim: ['ok'], mintCosignOk: true })]);
  expect(md).toContain('| A | SIGNED | — | 858 | 858 | ok | ok |');
});
