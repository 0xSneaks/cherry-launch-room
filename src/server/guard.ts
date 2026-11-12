// Small request guards shared by the write endpoints (/api/metadata, /api/send).

/** Browser requests from another site are refused. Requests with no Origin (same-origin GETs, curl) pass the check. */
export function sameOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  if (!origin || Array.isArray(origin)) return !origin;
  try {
    return new URL(origin).host === String(host ?? '');
  } catch {
    return false;
  }
}

// Per-instance sliding window. Best effort: serverless instances don't share it.
const hits = new Map<string, number[]>();
export function allow(key: string, now = Date.now(), perMinute = 10): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
}
