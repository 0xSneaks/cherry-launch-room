import {
  DESCRIPTION_MAX_CHARS,
  IMAGE_MAX_BYTES,
  type ImageMimeType,
  LAMPORTS_PER_SOL,
  NAME_MAX_BYTES,
  SOCIAL_URL_MAX_CHARS,
  SYMBOL_MAX_BYTES,
} from "./limits";

export interface CoinDetails {
  name: string;
  symbol: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
}

export type CoinField = keyof CoinDetails | "image" | "initialBuy";
export type FieldErrors = Partial<Record<CoinField, string>>;

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

// C0/C1 control characters (newline allowed only where noted).
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F-\u009F]/;

export const SOCIAL_FIELDS = ["twitter", "telegram", "website"] as const;

export function normalizeDetails(input: Partial<CoinDetails>): CoinDetails {
  return {
    name: (input.name ?? "").trim(),
    symbol: (input.symbol ?? "").trim(),
    description: (input.description ?? "").trim(),
    twitter: (input.twitter ?? "").trim(),
    telegram: (input.telegram ?? "").trim(),
    website: (input.website ?? "").trim(),
  };
}

export function isHttpUrl(value: string): boolean {
  if (value.length > SOCIAL_URL_MAX_CHARS) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/** Validates already-normalized coin details. Returns an empty object when valid. */
export function validateDetails(d: CoinDetails): FieldErrors {
  const errors: FieldErrors = {};

  if (!d.name) errors.name = "Give your coin a name.";
  else if (CONTROL_OR_NEWLINE.test(d.name)) errors.name = "Name can't contain line breaks or control characters.";
  else if (byteLength(d.name) > NAME_MAX_BYTES) errors.name = `Name is too long (max ${NAME_MAX_BYTES} bytes).`;

  if (!d.symbol) errors.symbol = "Add a ticker.";
  else if (/\s/.test(d.symbol) || CONTROL.test(d.symbol)) errors.symbol = "Ticker can't contain spaces.";
  else if (byteLength(d.symbol) > SYMBOL_MAX_BYTES) errors.symbol = `Ticker is too long (max ${SYMBOL_MAX_BYTES} bytes).`;

  if (d.description.length > DESCRIPTION_MAX_CHARS)
    errors.description = `Keep the description under ${DESCRIPTION_MAX_CHARS} characters.`;
  else if (CONTROL.test(d.description)) errors.description = "Description contains unsupported characters.";

  for (const field of SOCIAL_FIELDS) {
    const value = d[field];
    if (value && !isHttpUrl(value)) errors[field] = "Use a full link starting with https://";
  }
  return errors;
}

export function sniffImageMime(bytes: Uint8Array): ImageMimeType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61)
    return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return null;
}

export function validateImage(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length === 0) return "Add an image for your coin.";
  if (bytes.length > IMAGE_MAX_BYTES) return `Image is too large (max ${(IMAGE_MAX_BYTES / 1_000_000).toFixed(0)} MB).`;
  if (!sniffImageMime(bytes)) return "Use a PNG, JPG, GIF or WebP image.";
  return null;
}

/**
 * Parses a decimal SOL amount ("0.5", "1", ".25") into lamports without floating point.
 * Returns null for anything that isn't a plain non-negative decimal with ≤ 9 fraction digits.
 */
export function parseSolToLamports(input: string): bigint | null {
  const s = input.trim();
  if (s === "") return 0n;
  if (!/^(\d+)?(\.\d{0,9})?$/.test(s) || s === ".") return null;
  const [whole = "", frac = ""] = s.split(".");
  const lamports = BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt((frac + "000000000").slice(0, 9));
  return lamports;
}

export function formatLamports(lamports: bigint, maxFractionDigits = 4): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  let shown = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  // Never show a non-zero amount as 0.
  if (!shown && whole === 0n && abs > 0n) return `${negative ? "-" : ""}<0.${"0".repeat(maxFractionDigits - 1)}1`;
  return `${negative ? "-" : ""}${whole.toString()}${shown ? "." + shown : ""}`;
}
