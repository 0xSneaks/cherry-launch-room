// POST /api/metadata — validates the coin details and image, pins both to IPFS via Pinata,
// and returns the metadata URI used as create_v2's `uri`.
// Pinata API (docs.pinata.cloud, "Upload a file"): POST https://uploads.pinata.cloud/v3/files,
// Bearer JWT, multipart `file` + `network=public`, CID at `data.cid`.
import { IMAGE_MAX_BYTES, URI_MAX_BYTES } from "../shared/limits";
import {
  byteLength,
  normalizeDetails,
  sniffImageMime,
  validateDetails,
  validateImage,
  type CoinDetails,
} from "../shared/validation";
import { json } from "./http";

export interface MetadataEnv {
  PINATA_JWT?: string;
  IPFS_GATEWAY?: string;
}

const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const DEFAULT_GATEWAY = "https://ipfs.io/ipfs/";
// Whole request: image + text fields. Vercel's own cap is 4.5 MB.
const MAX_BODY_BYTES = IMAGE_MAX_BYTES + 64 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function gatewayBase(env: MetadataEnv): string {
  const g = (env.IPFS_GATEWAY || DEFAULT_GATEWAY).trim();
  const url = new URL(g); // throws on a malformed config
  if (url.protocol !== "https:") throw new Error("IPFS_GATEWAY must be https");
  return g.endsWith("/") ? g : `${g}/`;
}

/** Metadata JSON in the shape Pump.fun coins commonly use (see docs/PUMPFUN_INTEGRATION.md). */
export function buildMetadataJson(d: CoinDetails, imageUrl: string) {
  const out: Record<string, string | boolean> = {
    name: d.name,
    symbol: d.symbol,
    description: d.description,
    image: imageUrl,
    showName: true,
  };
  if (d.twitter) out.twitter = d.twitter;
  if (d.telegram) out.telegram = d.telegram;
  if (d.website) out.website = d.website;
  return out;
}

async function pinFile(
  fetchImpl: typeof fetch,
  jwt: string,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: contentType }), filename);
  form.append("network", "public");
  form.append("name", filename);
  // CIDv0 links are 13 bytes shorter than CIDv1, which matters for fitting create + buy in one transaction.
  form.append("cid_version", "v0");
  const res = await fetchImpl(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Pinata upload failed with HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { cid?: string } };
  const cid = body.data?.cid;
  if (!cid || !/^[A-Za-z0-9]{46,100}$/.test(cid)) throw new Error("Pinata returned no CID");
  return cid;
}

export async function handleMetadata(req: Request, env: MetadataEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (!env.PINATA_JWT) return json({ error: "Uploads aren't configured on this server." }, 503);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "Upload is too large." }, 413);
  if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data"))
    return json({ error: "Expected a multipart form." }, 415);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Couldn't read the upload." }, 400);
  }

  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const details = normalizeDetails({
    name: text("name"),
    symbol: text("symbol"),
    description: text("description"),
    twitter: text("twitter"),
    telegram: text("telegram"),
    website: text("website"),
  });
  const fields = validateDetails(details);

  const file = form.get("image");
  const bytes = file && typeof file !== "string" ? new Uint8Array(await file.arrayBuffer()) : null;
  const imageError = validateImage(bytes);
  if (imageError) fields.image = imageError;
  if (Object.keys(fields).length > 0) return json({ error: "Some details need fixing.", fields }, 422);

  let gateway: string;
  try {
    gateway = gatewayBase(env);
  } catch {
    return json({ error: "Uploads are misconfigured on this server." }, 503);
  }

  try {
    const mime = sniffImageMime(bytes!)!; // validated above; never trust the client's type
    const imageCid = await pinFile(fetchImpl, env.PINATA_JWT, bytes!, `image.${EXT[mime]}`, mime);
    const imageUrl = gateway + imageCid;
    const metadata = buildMetadataJson(details, imageUrl);
    const metaCid = await pinFile(
      fetchImpl,
      env.PINATA_JWT,
      new TextEncoder().encode(JSON.stringify(metadata)),
      "metadata.json",
      "application/json",
    );
    const uri = gateway + metaCid;
    if (byteLength(uri) > URI_MAX_BYTES) return json({ error: "Metadata link is too long. Check IPFS_GATEWAY." }, 500);
    return json({ uri, imageUrl }, 200);
  } catch (e) {
    // Don't echo upstream details to the client.
    console.error("metadata upload failed:", (e as Error).message);
    return json({ error: "Couldn't pin your coin's image and details. Try again." }, 502);
  }
}
