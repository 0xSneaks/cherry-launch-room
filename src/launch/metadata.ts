import type { CoinDetails } from "../../shared/validation";

export interface UploadedMetadata {
  uri: string;
  imageUrl: string;
}

/** Pins the image and metadata JSON through our server route (the Pinata key stays server-side). */
export async function uploadMetadata(details: CoinDetails, image: File): Promise<UploadedMetadata> {
  const form = new FormData();
  for (const [k, v] of Object.entries(details)) form.append(k, v);
  form.append("image", image, image.name || "image");
  const res = await fetch("/api/metadata", { method: "POST", body: form });
  let body: { uri?: string; imageUrl?: string; error?: string; fields?: Record<string, string> } = {};
  try {
    body = await res.json();
  } catch {
    // fall through to the status check
  }
  if (!res.ok || !body.uri || !body.imageUrl) {
    const fieldMsg = body.fields ? Object.values(body.fields)[0] : undefined;
    throw new Error(fieldMsg ?? body.error ?? `Couldn't upload your coin's image and details (HTTP ${res.status}).`);
  }
  return { uri: body.uri, imageUrl: body.imageUrl };
}
