// Pump.fun pool pairs for the "Select custom pair" sheet: Pump's live QuoteControl whitelist, in
// Pump's own order, with name / ticker / logo / category, plus market cap + liquidity when a price
// source answers. SERVER ONLY (/api/pairs, cached a day at the CDN).
// Sources: chain (always) → token metadata (on-chain, then the metadata JSON's image) → Jupiter
// token API for icon / mcap / liquidity (best effort; the list still works without it).
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export type PairCategory = 'stocks' | 'crypto' | 'memes';

export interface PairInfo {
  mint: string;
  name: string;
  symbol: string;
  icon: string | null;
  category: PairCategory;
  mcap: number | null;
  liquidity: number | null;
}

export interface PairsPayload {
  updatedAt: string;
  sol: PairInfo;
  usdc: PairInfo;
  custom: PairInfo[];
}

const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_METADATA_EXT = 19;

export interface RawMeta {
  name: string;
  symbol: string;
  uri: string;
}

function borshStr(b: Uint8Array, o: number): [string, number] {
  const n = new DataView(b.buffer, b.byteOffset).getUint32(o, true);
  const s = new TextDecoder().decode(b.subarray(o + 4, o + 4 + n)).replace(/\0/g, '').trim();
  return [s, o + 4 + n];
}

/** Metaplex metadata account → name/symbol/uri. */
export function decodeMplMetadata(data: Uint8Array): RawMeta | null {
  try {
    const [name, o1] = borshStr(data, 65);
    const [symbol, o2] = borshStr(data, o1);
    const [uri] = borshStr(data, o2);
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/** Token-2022 mint account with the TokenMetadata extension (type 19) → name/symbol/uri. */
export function decodeToken2022Metadata(data: Uint8Array): RawMeta | null {
  if (data.length <= 166 || data[165] !== 1) return null; // account type 1 = Mint
  const view = new DataView(data.buffer, data.byteOffset);
  let o = 166;
  try {
    while (o + 4 <= data.length) {
      const type = view.getUint16(o, true);
      const len = view.getUint16(o + 2, true);
      if (type === TOKEN_METADATA_EXT) {
        const v = data.subarray(o + 4, o + 4 + len);
        const [name, o1] = borshStr(v, 64); // updateAuthority(32) + mint(32)
        const [symbol, o2] = borshStr(v, o1);
        const [uri] = borshStr(v, o2);
        return { name, symbol, uri };
      }
      if (type === 0) break;
      o += 4 + len;
    }
  } catch {
    /* malformed: fall through */
  }
  return null;
}

/** Pump shows plain asset names ("Bitcoin", "Tesla"), not wrapper names. */
const OVERRIDES: Record<string, { name: string; symbol: string }> = {
  So11111111111111111111111111111111111111112: { name: 'Solana', symbol: 'SOL' },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { name: 'USD Coin', symbol: 'USDC' },
};
const WRAPPED: [RegExp, string][] = [
  [/^Wrapped BTC\b.*/i, 'Bitcoin'],
  [/^Wrapped Ether\b.*/i, 'Ethereum'],
];

export function displayName(name: string, symbol: string): { name: string; symbol: string } {
  let n = name;
  for (const [re, to] of WRAPPED) if (re.test(n)) n = to;
  n = n
    .replace(/\s*\((Wormhole|Portal|Sollet|Allbridge)\)\s*$/i, '')
    .replace(/^Wrapped\s+/i, '')
    .replace(/\s+xStock$/i, '')
    .replace(/\s+-\s+Backpack Securities$/i, '')
    .replace(/\s+PreStocks$/i, '')
    .trim();
  let s = symbol;
  if (/^W(BTC|ETH)$/i.test(s)) s = s.slice(1);
  if (/^w[A-Z]{2,}$/.test(s)) s = s.slice(1); // wXRP → XRP
  if (/^[A-Z.]{1,6}x$/.test(s)) s = s.slice(0, -1); // xStocks: TSLAx → TSLA
  return { name: n || symbol, symbol: s || n };
}

/** Tokenized equities/ETFs: xStocks (Backed), Backpack Securities, PreStocks (pre-IPO). */
const STOCK_ISSUER = /xStock$|-\s*Backpack Securities$|PreStocks$/i;

export function categorize(isPumpCoin: boolean, owner: string, rawName: string, mint: string): PairCategory {
  if (isPumpCoin) return 'memes';
  if (STOCK_ISSUER.test(rawName.trim())) return 'stocks';
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58() && mint.startsWith('Xs')) return 'stocks'; // xStocks vanity mints
  return 'crypto';
}

export type ReadAccounts = (keys: string[]) => Promise<({ owner: string; data: Uint8Array } | null)[]>;

export interface Market {
  icon?: string | null;
  mcap?: number | null;
  liquidity?: number | null;
}

const bondingCurve = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)[0];
const mplPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), MPL.toBuffer(), mint.toBuffer()], MPL)[0];

async function readAll(read: ReadAccounts, keys: string[]) {
  const out: Awaited<ReturnType<ReadAccounts>> = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await read(keys.slice(i, i + 100))));
  return out;
}

/** Everything the chain says about the pairs: names, tickers, metadata URIs, categories. */
export async function pairsFromChain(mints: PublicKey[], read: ReadAccounts) {
  const ids = mints.map((m) => m.toBase58());
  const [mintAccs, mplAccs, curves] = await Promise.all([
    readAll(read, ids),
    readAll(read, mints.map((m) => mplPda(m).toBase58())),
    readAll(read, mints.map((m) => bondingCurve(m).toBase58())),
  ]);
  return mints.map((m, i) => {
    const id = ids[i];
    const acc = mintAccs[i];
    const meta = (acc && decodeToken2022Metadata(acc.data)) ?? (mplAccs[i] && decodeMplMetadata(mplAccs[i]!.data)) ?? null;
    const shown = OVERRIDES[id] ?? displayName(meta?.name ?? '', meta?.symbol ?? '');
    return {
      mint: id,
      name: shown.name || `${id.slice(0, 4)}…${id.slice(-4)}`,
      symbol: shown.symbol || id.slice(0, 4),
      uri: meta?.uri ?? '',
      category: categorize(!!curves[i] && curves[i]!.owner === PUMP.toBase58(), acc?.owner ?? '', meta?.name ?? '', id),
    };
  });
}

const fmtNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Jupiter token API: icon, market cap, liquidity for up to 100 mints per call. Best effort. */
export async function marketData(ids: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, Market>> {
  const out = new Map<string, Market>();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const res = await fetchImpl(`https://lite-api.jup.ag/tokens/v2/search?query=${ids.slice(i, i + 100).join(',')}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const rows = (await res.json()) as { id?: string; icon?: string; mcap?: number; liquidity?: number }[];
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.id) out.set(r.id, { icon: typeof r.icon === 'string' && r.icon.startsWith('https://') ? r.icon : null, mcap: fmtNum(r.mcap), liquidity: fmtNum(r.liquidity) });
      }
    } catch {
      /* price source down: list still works */
    }
  }
  return out;
}

/** The metadata JSON's https image, for tokens Jupiter has no icon for. */
export async function imageFromUri(uri: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!/^https:\/\//.test(uri)) return null;
  try {
    const res = await fetchImpl(uri, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { image?: unknown };
    return typeof j.image === 'string' && /^https:\/\//.test(j.image) ? j.image : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function buildPairs(
  supported: { mint: PublicKey; source: string }[],
  read: ReadAccounts,
  fetchImpl: typeof fetch = fetch,
): Promise<PairsPayload> {
  const mints = supported.map((s) => s.mint);
  const chain = await pairsFromChain(mints, read);
  const market = await marketData(chain.map((c) => c.mint), fetchImpl);
  const rows: PairInfo[] = await mapLimit(chain, 16, async (c) => {
    const m = market.get(c.mint);
    return {
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      icon: m?.icon ?? (await imageFromUri(c.uri, fetchImpl)),
      category: c.category,
      mcap: m?.mcap ?? null,
      liquidity: m?.liquidity ?? null,
    };
  });
  const solIdx = supported.findIndex((s) => s.mint.equals(NATIVE_MINT));
  const usdcIdx = supported.findIndex((s) => s.source === 'global');
  return {
    updatedAt: new Date().toISOString(),
    sol: rows[solIdx],
    usdc: rows[usdcIdx],
    custom: rows.filter((_, i) => supported[i].source === 'quoteControl'),
  };
}
