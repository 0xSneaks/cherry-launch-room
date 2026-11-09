import { describe, expect, it } from 'vitest';
import { checkCall, upstreamUrl } from './rpc';

describe('rpc proxy allowlist', () => {
  it.each(['sendTransaction', 'requestAirdrop', 'sendRawTransaction', 'getProgramAccounts'])('refuses %s', (method) => {
    expect(checkCall({ method, params: [] })).toMatch(/not allowed/);
  });
  it('allows the reads the spike needs', () => {
    for (const method of ['getLatestBlockhash', 'getAccountInfo', 'getMultipleAccounts', 'getEpochInfo', 'simulateTransaction']) {
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

describe('upstream RPC url', () => {
  const key = '00000000-1111-2222-3333-444444444444';
  it('accepts a bare Helius API key', () => {
    expect(upstreamUrl(key)).toBe(`https://mainnet.helius-rpc.com/?api-key=${key}`);
  });
  it('accepts a full https URL', () => {
    expect(upstreamUrl('https://rpc.example.com/?api-key=x')).toBe('https://rpc.example.com/?api-key=x');
  });
  it.each([undefined, '', 'garbage', 'http://insecure.example.com'])('falls back to public mainnet for %s', (v) => {
    expect(upstreamUrl(v)).toBe('https://api.mainnet-beta.solana.com');
  });
});
