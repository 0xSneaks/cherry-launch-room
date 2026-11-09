// Who the page shows as signed in. Only the server-verified launch token counts:
// the SDK handshake alone is not proof (a wrong-app or expired token must look signed out).
export interface VerifiedSession {
  userKey: string;
  wallet: string;
  tier: string | null;
  exp: number;
}

export type SessionState =
  | { kind: 'checking' }
  | { kind: 'signed-in'; session: VerifiedSession }
  | { kind: 'signed-out'; reason: string };

/** Turn the /api/auth/cherry response into a state. Wallet must match the SDK's wallet. */
export function sessionFromResponse(
  status: number,
  body: unknown,
  sdkWallet: string | null,
  nowSec = Math.floor(Date.now() / 1000),
): SessionState {
  const b = (body ?? {}) as Partial<VerifiedSession> & { error?: string };
  if (status !== 200) return { kind: 'signed-out', reason: `server rejected the launch token (${status}${b.error ? ' ' + b.error : ''})` };
  if (typeof b.wallet !== 'string' || typeof b.userKey !== 'string' || typeof b.exp !== 'number') {
    return { kind: 'signed-out', reason: 'server answer was malformed' };
  }
  if (b.exp <= nowSec) return { kind: 'signed-out', reason: 'launch token expired' };
  if (sdkWallet && b.wallet !== sdkWallet) return { kind: 'signed-out', reason: 'verified wallet differs from the Cherry wallet' };
  return { kind: 'signed-in', session: { userKey: b.userKey, wallet: b.wallet, tier: b.tier ?? null, exp: b.exp } };
}

export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
