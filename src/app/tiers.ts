// Height tiers for Cherry's split view. Driven only by the app area's real height, never a chat-open signal.
export type Tier = 'full' | 'compact' | 'minimal';

export const TIER_FULL_MIN = 700;
export const TIER_COMPACT_MIN = 450;

export function tierFor(heightPx: number): Tier {
  if (heightPx >= TIER_FULL_MIN) return 'full';
  if (heightPx >= TIER_COMPACT_MIN) return 'compact';
  return 'minimal';
}

/**
 * Next tier to apply. While an input is focused the on-screen keyboard can shrink the app area, so the
 * tier stays at what was measured with nothing focused; the new height is applied once focus leaves.
 */
export function nextTier(current: Tier, heightPx: number, inputFocused: boolean): Tier {
  return inputFocused ? current : tierFor(heightPx);
}
