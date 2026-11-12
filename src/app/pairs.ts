// Pool pairs in the app: Pump's live list from /api/pairs (cached a day at the edge), filtered and
// searched like pump.fun's "Select custom pair" sheet. The chain still has the last word: a picked
// mint is re-checked with resolveQuoteMint before any launch is built.
import type { PairCategory, PairInfo, PairsPayload } from '../server/pairs';

export type { PairInfo, PairsPayload };
export type PairFilter = 'all' | PairCategory;

export async function fetchPairs(fetchImpl: typeof fetch = fetch): Promise<PairsPayload | null> {
  try {
    const res = await fetchImpl('/api/pairs');
    if (!res.ok) return null;
    const body = (await res.json()) as PairsPayload;
    return Array.isArray(body?.custom) ? body : null;
  } catch {
    return null;
  }
}

/** Pump's order is kept; search matches name, ticker or mint. */
export function filterPairs(pairs: PairInfo[], cat: PairFilter, query: string): PairInfo[] {
  const q = query.trim().toLowerCase().replace(/^\$/, '');
  return pairs.filter(
    (p) => (cat === 'all' || p.category === cat) && (!q || p.name.toLowerCase().includes(q) || p.symbol.toLowerCase().includes(q) || p.mint.toLowerCase() === q),
  );
}

/** $170.38M · $33.34K · $912 */
export function fmtUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [n, u] of units) if (v >= n) return `$${(v / n).toFixed(2)}${u}`;
  return `$${v.toFixed(0)}`;
}

/** Logo <img> with a lettered fallback when the image is missing or fails to load. */
export function logo(p: Pick<PairInfo, 'icon' | 'symbol'> | null, className = 'pair-logo'): HTMLElement {
  const box = document.createElement('span');
  box.className = className;
  const letters = () => (box.textContent = (p?.symbol ?? '?').replace(/^\$/, '').slice(0, 3).toUpperCase());
  if (p?.icon) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = p.icon;
    img.onerror = () => {
      img.remove();
      letters();
    };
    box.append(img);
  } else letters();
  return box;
}
