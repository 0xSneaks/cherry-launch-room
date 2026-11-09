// Limits shared by the browser and the server routes.
// create_v2 argument limits come from pump-public-docs, docs/instructions/COIN_CREATION.md
// (name ≤ 32, symbol ≤ 13, uri ≤ 200). We enforce them as UTF-8 byte lengths, which is
// the stricter reading (Rust's String::len() counts bytes).
export const NAME_MAX_BYTES = 32;
export const SYMBOL_MAX_BYTES = 13;
export const URI_MAX_BYTES = 200;

// App-level limits (our choice, not Pump.fun's).
export const DESCRIPTION_MAX_CHARS = 500;
export const SOCIAL_URL_MAX_CHARS = 200;
// Vercel caps request bodies at 4.5 MB; leave room for the text fields.
export const IMAGE_MAX_BYTES = 4_000_000;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export const LAMPORTS_PER_SOL = 1_000_000_000n;
