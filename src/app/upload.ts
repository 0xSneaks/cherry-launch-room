// Coin image → /api/metadata → on-chain metadata URI. Large still images are scaled down in the
// browser first (the API takes up to 3 MB; Pump shows coin images square, 1000 px is plenty).
/** Same cap as src/server/metadata.ts MAX_IMAGE_BYTES (Vercel's 4.5 MB body limit after base64). */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

const MAX_SIDE = 1000;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decode with createImageBitmap, or an <img> where an in-app webview lacks or fails it. */
async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise<void>((ok, bad) => {
        img.onload = () => ok();
        img.onerror = () => bad(new Error('decode'));
        img.src = url;
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }
}

async function shrink(file: File): Promise<Blob> {
  const pic = await decode(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(pic.w, pic.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(pic.w * scale));
  canvas.height = Math.max(1, Math.round(pic.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(pic.src, 0, 0, canvas.width, canvas.height);
  pic.done();
  for (const [type, q] of [['image/webp', 0.9], ['image/jpeg', 0.85]] as const) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    if (blob && blob.type === type && blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new UploadError('That image is too large. Try a smaller one.');
}

const SENDABLE = ['image/png', 'image/jpeg', 'image/webp'];

/** The image as the API wants it. Videos aren't live yet; GIFs keep their animation (so they must be ≤ 3 MB). */
export async function prepareImage(file: File): Promise<{ type: string; data: string }> {
  if (file.type.startsWith('video/')) throw new UploadError('Video coins are coming soon. Pick an image for now.');
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new UploadError('GIFs can be up to 3 MB for now.');
    return { type: file.type, data: toBase64(await file.arrayBuffer()) };
  }
  let blob: Blob = file;
  if (file.size > 1_500_000) {
    try {
      blob = await shrink(file);
    } catch (e) {
      if (e instanceof UploadError && file.size > MAX_IMAGE_BYTES) throw e;
      // Resizing failed in this webview: the original still fits, send it as is.
      if (file.size > MAX_IMAGE_BYTES || !SENDABLE.includes(file.type)) {
        throw new UploadError("Couldn't read that image. Try a PNG or JPG under 3 MB.");
      }
    }
  }
  if (!SENDABLE.includes(blob.type)) throw new UploadError("Couldn't read that image. Try a PNG or JPG under 3 MB.");
  return { type: blob.type, data: toBase64(await blob.arrayBuffer()) };
}

export interface MetadataFields {
  name: string;
  ticker: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
}

/** Pins image + metadata. Returns the URI the create tx carries. */
export async function uploadMetadata(f: MetadataFields, image: File, fetchImpl: typeof fetch = fetch): Promise<string> {
  let img: { type: string; data: string };
  try {
    img = await prepareImage(image);
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError("Couldn't read that image. Try a PNG or JPG under 3 MB.");
  }
  let res: Response;
  try {
    res = await fetchImpl('/api/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: f.name.trim(),
        symbol: f.ticker,
        description: f.description.trim(),
        website: f.website.trim(),
        twitter: f.x.trim(),
        telegram: f.telegram.trim(),
        image: img,
      }),
    });
  } catch {
    throw new UploadError("Couldn't reach PetalDeck to upload your image. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { uri?: string; error?: string; message?: string };
  if (res.ok && body.uri) return body.uri;
  if (body.error === 'UPLOADS_NOT_CONFIGURED') throw new UploadError("Image upload isn't set up yet. Try again later.");
  if (body.error === 'BAD_INPUT' && body.message) throw new UploadError(body.message);
  if (res.status === 429) throw new UploadError('Too many uploads. Wait a minute and try again.');
  throw new UploadError("Couldn't upload your image. Try again.");
}
