import type { CoinMeta } from './build.js';

// Spike coin metadata. Realistic lengths (Pinata CIDv1 URI = 80 chars) so byte counts mean something.
// The URI is never fetched: nothing is broadcast.
export const SPIKE_COIN: CoinMeta = {
  name: 'Launch Spike',
  symbol: 'LRSPK',
  uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
};
