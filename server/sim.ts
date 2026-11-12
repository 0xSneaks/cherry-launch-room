// Chained launch simulation on an in-memory mainnet fork (src/sim). NEVER sends anything:
// the only upstream calls are account/slot reads (src/sim/fork.ts READ_METHODS).
//
// POST { txs: base64[] (unsigned legacy txs, signing order), fundPayer?: boolean }
//   → { results: TxResult[] } — tx i runs on the state txs 0..i-1 left.
//   fundPayer (Preview only): give the fee payer 5 SOL on the fork, to test program logic
//   without a funded wallet. Production always uses the wallet's real balance.
// GET ?suite=1[&variants=A,B,…][&pair=<mint>] (Preview only) → A–H suite, chained vs unchained.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PublicKey, Transaction } from '@solana/web3.js';
import { upstreamUrl } from '../api/rpc.js';
import { rpcReader, simulateChain } from '../src/sim/fork.js';
import { fundedWallet, runSuite, suiteMarkdown } from '../src/sim/suite.js';
import { ALL_VARIANTS, type AnyVariant } from '../src/spike/variants.js';
import { TX_BYTE_LIMIT } from '../src/spike/constants.js';

export const config = { maxDuration: 60 };

const MAX_TXS = 4;
const isPreview = () => process.env.VERCEL_ENV !== 'production';

// Small per-instance limiter: simulation costs RPC reads.
const hits = new Map<string, number[]>();
export function allow(ip: string, now = Date.now(), perMinute = 20): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

/** Decode and size-check client transactions. Returns an error string or the txs. */
export function parseTxs(body: unknown): Transaction[] | string {
  const txs = (body as { txs?: unknown })?.txs;
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > MAX_TXS) return `txs must be 1..${MAX_TXS} base64 strings`;
  const out: Transaction[] = [];
  for (const t of txs) {
    if (typeof t !== 'string' || t.length > 2000) return 'bad tx';
    const bytes = Buffer.from(t, 'base64');
    if (bytes.length > TX_BYTE_LIMIT) return `tx over ${TX_BYTE_LIMIT} B`;
    try {
      out.push(Transaction.from(bytes));
    } catch {
      return 'not a legacy transaction';
    }
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  const ip = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
  if (!allow(ip)) return res.status(429).json({ error: 'RATE_LIMITED' });
  const rpcUrl = upstreamUrl(process.env.SOLANA_RPC_URL);
  const read = rpcReader(rpcUrl);

  try {
    if (req.method === 'GET') {
      if (!isPreview() || req.query.suite !== '1') return res.status(404).json({ error: 'NOT_FOUND' });
      const want = String(req.query.variants ?? '')
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .filter((v): v is AnyVariant => (ALL_VARIANTS as string[]).includes(v));
      const pair = typeof req.query.pair === 'string' && req.query.pair ? new PublicKey(req.query.pair) : undefined;
      const rows = await runSuite({ rpcUrl, read, variants: want.length ? want : undefined, pairMint: pair });
      return res.status(200).json({ at: new Date().toISOString(), markdown: suiteMarkdown(rows), rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const txs = parseTxs(body);
    if (typeof txs === 'string') return res.status(400).json({ error: txs });
    const payer = txs[0].feePayer;
    const fund = isPreview() && body?.fundPayer === true && payer;
    const results = await simulateChain(read, txs, {
      overrides: fund ? [{ pubkey: payer, account: fundedWallet() }] : [],
    });
    return res.status(200).json({ results, funded: Boolean(fund) });
  } catch (e) {
    // Never echo the upstream URL (it can carry an API key).
    console.error('[sim] failed:', (e as Error).message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200));
    return res.status(502).json({ error: 'SIM_UNAVAILABLE' });
  }
}
