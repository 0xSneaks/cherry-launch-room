// Read-only Solana JSON-RPC proxy. Allowlisted reads + simulation only: anything that could
// broadcast is refused here. Launch txs go out ONLY through /api/send, which checks their shape.
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const ALLOWED_METHODS = new Set([
  'getLatestBlockhash',
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getEpochInfo', // Token-2022 quote transfer fee (pump SDK fetchQuoteTransferFee)
  'getMinimumBalanceForRentExemption',
  'simulateTransaction',
  'getSignatureStatuses', // launch confirmation polling (read only)
]);

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SOLANA_RPC_URL may hold a full https URL or, as pasted from the Helius dashboard,
 * only the Helius API key (a UUID). Anything else falls back to public mainnet.
 */
export function upstreamUrl(value: string | undefined): string {
  const v = value?.trim() ?? '';
  if (UUID.test(v)) return `https://mainnet.helius-rpc.com/?api-key=${v}`;
  try {
    if (new URL(v).protocol === 'https:') return v;
  } catch {
    /* not a URL */
  }
  return DEFAULT_RPC;
}

type RpcCall = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

/** Returns an error message for a disallowed call, or null when allowed. */
export function checkCall(call: RpcCall): string | null {
  if (typeof call?.method !== 'string') return 'missing method';
  if (!ALLOWED_METHODS.has(call.method)) return `method not allowed: ${call.method}`;
  if (call.method === 'simulateTransaction') {
    // Simulation must never verify real signatures we might log; force sigVerify off.
    const opts = Array.isArray(call.params) ? call.params[1] : undefined;
    if (opts && typeof opts === 'object' && (opts as { sigVerify?: boolean }).sigVerify === true) {
      return 'sigVerify not allowed';
    }
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const calls: RpcCall[] = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 10) return res.status(400).json({ error: 'bad batch' });
  for (const call of calls) {
    const problem = checkCall(call);
    if (problem) {
      return res.status(403).json({ jsonrpc: '2.0', id: call?.id ?? null, error: { code: -32601, message: problem } });
    }
  }
  try {
    const upstream = await fetch(upstreamUrl(process.env.SOLANA_RPC_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    res.status(upstream.status).setHeader('content-type', 'application/json');
    return res.send(await upstream.text());
  } catch {
    // Never echo the upstream URL: it can carry an API key.
    console.error('[rpc] upstream unreachable');
    return res.status(502).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'RPC upstream unreachable' } });
  }
}
