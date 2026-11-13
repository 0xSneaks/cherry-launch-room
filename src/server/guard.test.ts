import { describe, expect, it } from 'vitest';
import { allow, sameOrigin } from './guard';

describe('write-endpoint guards', () => {
  const host = 'cherry-launch-room-git-spike-sign-only-phantomcapais-projects.vercel.app';
  it('accepts the app itself and origin-less calls, refuses other sites', () => {
    expect(sameOrigin(`https://${host}`, host)).toBe(true);
    expect(sameOrigin(undefined, host)).toBe(true);
    expect(sameOrigin('https://evil.example', host)).toBe(false);
    expect(sameOrigin(`https://${host}.evil.example`, host)).toBe(false);
    expect(sameOrigin('null', host)).toBe(false);
    expect(sameOrigin(['https://a', 'https://b'], host)).toBe(false);
  });
  it('rate-limits per key per minute', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(allow('k', t + i, 3)).toBe(true);
    expect(allow('k', t + 10, 3)).toBe(false);
    expect(allow('k', t + 61_000, 3)).toBe(true);
  });
});
