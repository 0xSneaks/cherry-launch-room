// POST /api/auth/cherry — Authorization: Bearer <Cherry launch token>.
// 200 with the verified identity, 401 on any bad token (wrong aud/iss/app, expired, bad signature).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bearerToken, verifyCherryToken } from '../../src/server/cherryAuth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const result = await verifyCherryToken(bearerToken(req.headers.authorization));
  if (!result.ok) return res.status(result.status).json({ error: result.code });
  const { userKey, wallet, tier, exp } = result.identity;
  return res.status(200).json({ userKey, wallet, tier, exp });
}
