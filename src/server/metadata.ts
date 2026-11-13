// Coin metadata for Pump.fun: validate the form fields + image, pin both to IPFS (Pinata), return the URI.
// Pure validation is exported for tests; pinning needs PINATA_JWT (server env only, never sent to clients).
import { LIMITS } from '../launch/policy.js';

/** Raw image bytes the API accepts. Vercel caps request bodies at 4.5 MB and base64 adds a third. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export interface MetadataInput {
  name: string;
  symbol: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  image: { type: string; data: string };
}

export interface CleanMetadata {
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  image: { type: string; bytes: Uint8Array };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function link(v: unknown, field: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${field} must be a full https:// link`);
  }
  if (u.protocol !== 'https:' || s.length > 200) throw new Error(`${field} must be a full https:// link`);
  return s;
}

/** Throws a user-readable Error on bad input. */
export function cleanMetadata(body: unknown): CleanMetadata {
  const b = (body ?? {}) as Partial<MetadataInput>;
  const name = str(b.name);
  const symbol = str(b.symbol);
  const description = str(b.description);
  const bytesOf = (v: string) => new TextEncoder().encode(v).length;
  if (!name || bytesOf(name) > LIMITS.name) throw new Error(`Name must be 1–${LIMITS.name} characters`);
  if (!symbol || /\s/.test(symbol) || bytesOf(symbol) > LIMITS.symbol) throw new Error(`Ticker must be 1–${LIMITS.symbol} characters, no spaces`);
  if (description.length > 500) throw new Error('Description is too long');
  const type = str(b.image?.type);
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new Error('Image must be PNG, JPG, GIF or WebP');
  const data = typeof b.image?.data === 'string' ? b.image.data : '';
  if (!data || data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw new Error('Image is too large (max 3 MB)');
  const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image is too large (max 3 MB)');
  return {
    name,
    symbol,
    description,
    website: link(b.website, 'Website'),
    twitter: link(b.twitter, 'X'),
    telegram: link(b.telegram, 'Telegram'),
    image: { type, bytes },
  };
}

/** Pump.fun-style metadata JSON (name, symbol, description, image, showName, socials). */
export function metadataJson(m: CleanMetadata, imageCid: string) {
  return {
    name: m.name,
    symbol: m.symbol,
    description: m.description,
    image: IPFS_GATEWAY + imageCid,
    showName: true,
    ...(m.twitter ? { twitter: m.twitter } : {}),
    ...(m.telegram ? { telegram: m.telegram } : {}),
    ...(m.website ? { website: m.website } : {}),
  };
}

const PINATA = 'https://api.pinata.cloud/pinning';

/** PINATA_JWT as pasted into Vercel → the bare JWT (drops quotes, a "Bearer " prefix, stray whitespace). */
export function pinataJwt(raw: string | undefined): string {
  let s = (raw ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  s = s.replace(/^bearer\s+/i, '');
  return s.replace(/\s+/g, '');
}

/** Non-secret shape of the key, for logs only: does it look like a JWT at all? */
export function jwtShape(jwt: string): string {
  return `parts=${jwt.split('.').length} len=${jwt.length} ${jwt.startsWith('eyJ') ? 'jwt-like' : 'not-jwt'}`;
}

export class PinataAuthError extends Error {
  constructor(status: number) {
    super(`pinata ${status}`);
    this.name = 'PinataAuthError';
  }
}

async function pinataHash(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) throw new PinataAuthError(res.status);
  if (!res.ok) throw new Error(`pinata ${res.status}`);
  const body = (await res.json()) as { IpfsHash?: string };
  if (!body.IpfsHash) throw new Error('pinata: no hash');
  return body.IpfsHash;
}

/** Pins the image, then the metadata JSON. Returns the metadata URI that goes on-chain. */
export async function pinMetadata(m: CleanMetadata, jwt: string, fetchImpl: typeof fetch = fetch): Promise<{ uri: string; image: string }> {
  const auth = { authorization: `Bearer ${jwt}` };
  const ext = m.image.type.split('/')[1].replace('jpeg', 'jpg');
  const fd = new FormData();
  fd.append('file', new Blob([m.image.bytes.slice().buffer as ArrayBuffer], { type: m.image.type }), `${m.symbol}.${ext}`);
  fd.append('pinataMetadata', JSON.stringify({ name: `petaldeck-${m.symbol}-image` }));
  const imageCid = await pinataHash(await fetchImpl(`${PINATA}/pinFileToIPFS`, { method: 'POST', headers: auth, body: fd }));
  const json = metadataJson(m, imageCid);
  const metaCid = await pinataHash(
    await fetchImpl(`${PINATA}/pinJSONToIPFS`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ pinataContent: json, pinataMetadata: { name: `petaldeck-${m.symbol}-metadata` } }),
    }),
  );
  return { uri: IPFS_GATEWAY + metaCid, image: json.image };
}
