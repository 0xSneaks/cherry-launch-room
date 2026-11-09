// POST /api/rpc — a narrow JSON-RPC proxy so the RPC provider key stays server-side.
// Only the methods the launch flow uses are forwarded; batches are refused.
import { json, readCapped } from "./http";

export interface RpcEnv {
  SOLANA_RPC_URL?: string;
  /** Optional comma-separated list of allowed browser origins, e.g. "https://pumpdeck.app". */
  ALLOWED_ORIGINS?: string;
}

export const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getRecentPrioritizationFees",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "simulateTransaction",
  "sendTransaction",
]);

const MAX_BODY_BYTES = 64 * 1024;

function originAllowed(req: Request, env: RpcEnv): boolean {
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  const origin = req.headers.get("origin");
  return !!origin && list.includes(origin);
}

const rpcError = (id: unknown, code: number, message: string, status: number) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

export async function handleRpc(req: Request, env: RpcEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (!env.SOLANA_RPC_URL) return rpcError(null, -32000, "RPC isn't configured on this server.", 503);
  if (!originAllowed(req, env)) return rpcError(null, -32000, "Origin not allowed.", 403);

  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (!raw) return rpcError(null, -32600, "Request too large.", 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return rpcError(null, -32700, "Parse error.", 400);
  }
  if (Array.isArray(body)) return rpcError(null, -32600, "Batch requests aren't supported.", 400);
  if (!body || typeof body !== "object") return rpcError(null, -32600, "Invalid request.", 400);

  const { jsonrpc, id, method, params } = body as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") return rpcError(id, -32600, "Invalid request.", 400);
  if (!ALLOWED_METHODS.has(method)) return rpcError(id, -32601, `Method not allowed: ${method.slice(0, 64)}`, 403);
  if (params !== undefined && !Array.isArray(params)) return rpcError(id, -32602, "Invalid params.", 400);

  try {
    const upstream = await fetchImpl(env.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return rpcError(id, -32000, "Upstream RPC unavailable.", 502);
  }
}
