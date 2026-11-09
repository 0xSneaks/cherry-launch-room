import { describe, expect, it } from 'vitest';
import { sessionFromResponse } from './session';

const now = 1_800_000_000;
const ok = { userKey: 'u1', wallet: 'W1', tier: 'verified', exp: now + 300 };

describe('signed-in state comes only from the server', () => {
  it('200 + matching wallet = signed in', () => {
    expect(sessionFromResponse(200, ok, 'W1', now)).toMatchObject({ kind: 'signed-in' });
  });
  it.each([
    [401, { error: 'AUDIENCE_MISMATCH' }],
    [401, { error: 'TOKEN_EXPIRED' }],
    [400, { error: 'TOKEN_MISSING' }],
    [503, { error: 'JWKS_UNAVAILABLE' }],
  ])('%i %j = signed out', (status, body) => {
    expect(sessionFromResponse(status, body, 'W1', now).kind).toBe('signed-out');
  });
  it('expired exp in a 200 = signed out', () => {
    expect(sessionFromResponse(200, { ...ok, exp: now }, 'W1', now).kind).toBe('signed-out');
  });
  it('wallet mismatch = signed out', () => {
    expect(sessionFromResponse(200, ok, 'OTHER', now).kind).toBe('signed-out');
  });
  it('malformed body = signed out', () => {
    expect(sessionFromResponse(200, { wallet: 'W1' }, 'W1', now).kind).toBe('signed-out');
  });
});
