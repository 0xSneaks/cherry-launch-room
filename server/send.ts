// POST /api/send { tx: base64 } — relay ONE fully signed PetalDeck launch tx to Solana, return { signature }.
// The user signed it in Cherry (and the app co-signed the mint). Only launch-shaped txs pass
// (src/server/launchTx.ts); preflight stays ON so a failing tx is rejected before it lands.
// Bundled to api/send.js by npm run build:api.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { upstreamUrl } from '../api/rpc.js';
import { checkLaunchTx } from '../src/server/launchTx.js';
import { allow, sameOrigin } from '../src/server/guard.js';

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!sameOrigin(req.headers.origin, req.headers.host)) return res.status(403).json({ error: 'FORBIDDEN_ORIGIN' });
  if (!allow(`send:${String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()}`, Date.now(), 12)) {
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const check = checkLaunchTx(body?.tx);
  if (!check.ok) return res.status(400).json({ error: 'REJECTED', message: check.error });
  try {
    const upstream = await fetch(upstreamUrl(process.env.SOLANA_RPC_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [Buffer.from(check.bytes).toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }],
      }),
    });
    const out = (await upstream.json()) as { result?: string; error?: { message?: string; data?: unknown } };
    if (out.error) {
      // Preflight failure: pass Solana's message + logs through so the app can explain it. No URL, no key.
      return res.status(422).json({ error: 'SEND_FAILED', message: out.error.message ?? 'send failed', data: out.error.data ?? null });
    }
    return res.status(200).json({ signature: out.result });
  } catch {
    console.error('[send] upstream unreachable');
    return res.status(502).json({ error: 'RPC_UNAVAILABLE' });
  }
}
