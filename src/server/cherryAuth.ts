// Server-side Cherry launch-token check. Never trust anything outside the verified token.
import { LaunchTokenError, verifyLaunchToken, type VerifyLaunchTokenOptions } from '@cherrydotfun/miniapp-sdk';
import { CHERRY_APP_ID } from '../spike/constants.js';

export const CHERRY_ISSUER = 'https://chat.cherry.fun';

export interface CherryIdentity {
  /** The person (Cherry ID). Key accounts by this, never by the wallet. */
  userKey: string;
  /** Wallet Cherry signs with for this app (payment_wallet ?? sub); can change between launches. */
  wallet: string;
  tier: string | null;
  exp: number;
}

export type AuthResult = { ok: true; identity: CherryIdentity } | { ok: false; status: 400 | 401 | 503; code: string };

export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(h?.trim() ?? '');
  return m ? m[1] : null;
}

/** Verifies signature, exp/nbf, iss = chat.cherry.fun, aud (when present) and app_id = our App ID. */
export async function verifyCherryToken(
  token: string | null,
  extra: Pick<VerifyLaunchTokenOptions, 'jwks' | 'clockTolerance'> = {},
): Promise<AuthResult> {
  if (!token) return { ok: false, status: 400, code: 'TOKEN_MISSING' };
  try {
    const claims = await verifyLaunchToken(token, { appId: CHERRY_APP_ID, issuer: CHERRY_ISSUER, ...extra });
    return {
      ok: true,
      identity: {
        userKey: claims.cherry_id ?? claims.sub,
        // The wallet Cherry signs with in this app (payment_wallet), else the identity wallet.
        wallet: claims.payment_wallet ?? claims.sub,
        tier: claims.tier ?? null,
        exp: claims.exp,
      },
    };
  } catch (err) {
    const code = err instanceof LaunchTokenError ? err.code : 'TOKEN_INVALID';
    // JWKS down: refuse, but tell the client it is temporary.
    return { ok: false, status: code === 'JWKS_UNAVAILABLE' ? 503 : 401, code };
  }
}
