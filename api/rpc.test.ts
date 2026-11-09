import { describe, expect, it } from 'vitest';
import { checkCall } from './rpc';

describe('rpc proxy allowlist', () => {
  it.each(['sendTransaction', 'requestAirdrop', 'sendRawTransaction', 'getProgramAccounts'])('refuses %s', (method) => {
    expect(checkCall({ method, params: [] })).toMatch(/not allowed/);
  });
  it('allows the reads the spike needs', () => {
    for (const method of ['getLatestBlockhash', 'getAccountInfo', 'getMultipleAccounts', 'simulateTransaction']) {
      expect(checkCall({ method, params: [] })).toBeNull();
    }
  });
  it('refuses simulation with sigVerify', () => {
    expect(checkCall({ method: 'simulateTransaction', params: ['x', { sigVerify: true }] })).toMatch(/sigVerify/);
  });
  it('refuses a call without a method', () => {
    expect(checkCall({})).toBe('missing method');
  });
});
