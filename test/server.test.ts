import { describe, expect, it, vi } from "vitest";
import { handleMetadata } from "../server/metadata";
import { ALLOWED_METHODS, handleRpc } from "../server/rpc";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const CID_IMG = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_META = "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";

function form(fields: Record<string, string>, image?: Uint8Array, type = "image/png") {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (image) f.append("image", new Blob([image as BlobPart], { type }), "x.png");
  return new Request("http://localhost/api/metadata", { method: "POST", body: f });
}

function pinataMock() {
  const calls: { body: FormData; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push({ body: init!.body as FormData, auth: new Headers(init!.headers).get("authorization") });
    const cid = calls.length === 1 ? CID_IMG : CID_META;
    return new Response(JSON.stringify({ data: { cid } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const env = { PINATA_JWT: "test-jwt" };
const good = { name: "Deck Coin", symbol: "DECK", description: "gm", twitter: "https://x.com/deck", telegram: "", website: "" };

describe("POST /api/metadata", () => {
  it("pins the image then the metadata JSON and returns the URI", async () => {
    const { fetchImpl, calls } = pinataMock();
    const res = await handleMetadata(form(good, PNG), env, fetchImpl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ uri: `https://ipfs.io/ipfs/${CID_META}`, imageUrl: `https://ipfs.io/ipfs/${CID_IMG}` });

    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe("Bearer test-jwt");
    expect(calls[0].body.get("network")).toBe("public");
    expect(calls[0].body.get("cid_version")).toBe("v0");
    // The stored type comes from the file's bytes, not the client.
    expect((calls[0].body.get("file") as File).type).toBe("image/png");

    const meta = JSON.parse(await (calls[1].body.get("file") as File).text());
    expect(meta).toEqual({
      name: "Deck Coin",
      symbol: "DECK",
      description: "gm",
      image: `https://ipfs.io/ipfs/${CID_IMG}`,
      showName: true,
      twitter: "https://x.com/deck",
    });
  });

  it("rejects bad fields without calling Pinata", async () => {
    const { fetchImpl } = pinataMock();
    const res = await handleMetadata(
      form({ ...good, name: "x".repeat(33), symbol: "TWO WORDS", website: "javascript:alert(1)" }, PNG),
      env,
      fetchImpl,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.fields).sort()).toEqual(["name", "symbol", "website"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects files that aren't images even when labelled as one", async () => {
    const { fetchImpl } = pinataMock();
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const res = await handleMetadata(form(good, html, "image/png"), env, fetchImpl);
    expect(res.status).toBe(422);
    expect((await res.json()).fields.image).toMatch(/PNG/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing image and oversized images", async () => {
    const { fetchImpl } = pinataMock();
    expect((await handleMetadata(form(good), env, fetchImpl)).status).toBe(422);
    const big = new Uint8Array(4_000_001);
    big.set(PNG);
    expect((await handleMetadata(form(good, big), env, fetchImpl)).status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses requests whose declared size is too large", async () => {
    const req = new Request("http://localhost/api/metadata", {
      method: "POST",
      headers: { "content-length": String(10_000_000), "content-type": "multipart/form-data; boundary=x" },
      body: "x",
    });
    expect((await handleMetadata(req, env)).status).toBe(413);
  });

  it("returns 503 when Pinata isn't configured, and hides upstream errors", async () => {
    expect((await handleMetadata(form(good, PNG), {})).status).toBe(503);
    const failing = vi.fn(async () => new Response("secret upstream detail", { status: 500 })) as unknown as typeof fetch;
    const res = await handleMetadata(form(good, PNG), env, failing);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret upstream detail");
  });

  it("only accepts POST", async () => {
    expect((await handleMetadata(new Request("http://localhost/api/metadata"), env)).status).toBe(405);
  });
});

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/rpc", () => {
  const rpcEnv = { SOLANA_RPC_URL: "https://rpc.example/?api-key=secret" };

  it("forwards allowed methods, stripping unknown fields", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":42}', { status: 200 })) as unknown as typeof fetch;
    const res = await handleRpc(rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"], extra: "nope" }), rpcEnv, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: 42 });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(rpcEnv.SOLANA_RPC_URL);
    expect(JSON.parse(init.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] });
  });

  it("refuses methods outside the allowlist", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const method of ["getProgramAccounts", "requestAirdrop", "getSignaturesForAddress", "getTokenLargestAccounts"]) {
      expect(ALLOWED_METHODS.has(method)).toBe(false);
      const res = await handleRpc(rpc({ jsonrpc: "2.0", id: 1, method, params: [] }), rpcEnv, fetchImpl);
      expect(res.status).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses batches, bad JSON and oversized bodies", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await handleRpc(rpc([{ jsonrpc: "2.0", id: 1, method: "getBalance" }]), rpcEnv, fetchImpl)).status).toBe(400);
    expect((await handleRpc(rpc("{not json"), rpcEnv, fetchImpl)).status).toBe(400);
    expect((await handleRpc(rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: "x".repeat(70_000) }), rpcEnv, fetchImpl)).status).toBe(413);
    expect((await handleRpc(rpc({ jsonrpc: "2.0", id: 1, method: "getBalance", params: {} }), rpcEnv, fetchImpl)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces ALLOWED_ORIGINS when set", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const env2 = { ...rpcEnv, ALLOWED_ORIGINS: "https://pumpdeck.app" };
    const body = { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] };
    expect((await handleRpc(rpc(body, { origin: "https://evil.example" }), env2, fetchImpl)).status).toBe(403);
    expect((await handleRpc(rpc(body), env2, fetchImpl)).status).toBe(403);
    expect((await handleRpc(rpc(body, { origin: "https://pumpdeck.app" }), env2, fetchImpl)).status).toBe(200);
  });

  it("never leaks the upstream URL", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED https://rpc.example/?api-key=secret");
    }) as unknown as typeof fetch;
    const res = await handleRpc(rpc({ jsonrpc: "2.0", id: 7, method: "getBalance", params: [] }), rpcEnv, failing);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret");
    expect((await handleRpc(rpc({ jsonrpc: "2.0", id: 1, method: "getBalance" }), {})).status).toBe(503);
  });
});
