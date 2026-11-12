// POST /api/metadata — pin the coin image + Pump.fun metadata JSON to IPFS, return { uri, image }.
// Bundled to api/metadata.js by npm run build:api. Needs env PINATA_JWT (never echoed or logged).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanMetadata, pinMetadata } from '../src/server/metadata.js';
import { allow, sameOrigin } from '../src/server/guard.js';

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!sameOrigin(req.headers.origin, req.headers.host)) return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  if (!allow(`meta:${String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()}`, Date.now(), 6)) {
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }
  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) return res.status(503).json({ error: 'UPLOADS_NOT_CONFIGURED' });
  let clean;
  try {
    clean = cleanMetadata(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  } catch (e) {
    return res.status(400).json({ error: 'BAD_INPUT', message: (e as Error).message });
  }
  try {
    return res.status(200).json(await pinMetadata(clean, jwt));
  } catch (e) {
    console.error('[metadata] pin failed:', (e as Error).message.slice(0, 120));
    return res.status(502).json({ error: 'UPLOAD_FAILED' });
  }
}
