export type Cluster = "mainnet-beta" | "devnet";

export const CLUSTER: Cluster = import.meta.env.VITE_SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";

const clusterQuery = (c: Cluster) => (c === "devnet" ? "?cluster=devnet" : "");

export const pumpFunCoinUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
export const solscanTxUrl = (sig: string, c: Cluster = CLUSTER) => `https://solscan.io/tx/${sig}${clusterQuery(c)}`;
export const solscanTokenUrl = (mint: string, c: Cluster = CLUSTER) => `https://solscan.io/token/${mint}${clusterQuery(c)}`;

export function shareText(name: string, symbol: string, mint: string): string {
  return `I just launched $${symbol} (${name}) on Pump.fun.\n\nCA: ${mint}\n${pumpFunCoinUrl(mint)}`;
}

export const xIntentUrl = (text: string) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;

/** Open this site inside a wallet's in-app browser (documented browse deeplinks). */
export function walletBrowseLinks(pageUrl: string, refUrl: string) {
  const url = encodeURIComponent(pageUrl);
  const ref = encodeURIComponent(refUrl);
  return [
    { name: "Phantom", href: `https://phantom.com/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export const shortAddress = (a: string, n = 4) => (a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
