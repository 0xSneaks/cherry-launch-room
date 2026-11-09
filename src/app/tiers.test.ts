import { describe, expect, it } from 'vitest';
import { nextTier, tierFor } from './tiers';

describe('height tiers', () => {
  it('≥700 full, 450–699 compact, <450 minimal', () => {
    expect(tierFor(844)).toBe('full');
    expect(tierFor(700)).toBe('full');
    expect(tierFor(699)).toBe('compact');
    expect(tierFor(450)).toBe('compact');
    expect(tierFor(449)).toBe('minimal');
    expect(tierFor(350)).toBe('minimal');
  });
  it('keyboard open (input focused) never flips the tier', () => {
    expect(nextTier('compact', 300, true)).toBe('compact');
    expect(nextTier('full', 400, true)).toBe('full');
    expect(nextTier('compact', 300, false)).toBe('minimal');
  });
});
