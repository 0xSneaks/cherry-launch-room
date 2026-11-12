// GET /api/pairs — Pump.fun's current pool pairs (SOL, USDC, every custom pair) with names, tickers,
// logos, category, market cap and liquidity. Read from chain on each refresh, cached at Vercel's CDN
// for a day (stale-while-revalidate), so the list follows Pump's whitelist within 24 h without a cron.
// Bundled to api/pairs.js by npm run build:api.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { Connection } from '@solana/web3.js';
import { upstreamUrl } from '../api/rpc.js';
import { buildPairs, type ReadAccounts } from '../src/server/pairs.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const url = upstreamUrl(process.env.SOLANA_RPC_URL);
  const connection = new Connection(url, 'confirmed');
  const read: ReadAccounts = async (keys) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] }),
    });
    const body = (await r.json()) as { result?: { value: ({ owner: string; data: [string, string] } | null)[] }; error?: { message?: string } };
    if (!body.result) throw new Error(`rpc: ${body.error?.message ?? r.status}`);
    return body.result.value.map((a) => (a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data[0], 'base64')) } : null));
  };
  try {
    const supported = await new OnlinePumpSdk(connection).fetchSupportedQuoteMints();
    const payload = await buildPairs(supported, read);
    // A day at the edge; serve the old list while the next one builds.
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[pairs] failed:', (e as Error).message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160));
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json({ error: 'PAIRS_UNAVAILABLE' });
  }
}
