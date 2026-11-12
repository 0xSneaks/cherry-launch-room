import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { buildPairs, categorize, decodeMplMetadata, decodeToken2022Metadata, displayName, type ReadAccounts } from './pairs';

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};
function t22Mint(name: string, symbol: string, uri: string): Uint8Array {
  const base = Buffer.alloc(166);
  base[165] = 1; // Mint
  const pointer = Buffer.concat([Buffer.from([18, 0, 64, 0]), Buffer.alloc(64)]); // MetadataPointer
  const value = Buffer.concat([Buffer.alloc(64), str(name), str(symbol), str(uri), Buffer.alloc(4)]);
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(value.length, 2);
  return Uint8Array.from(Buffer.concat([base, pointer, tlv, value]));
}
const mplAccount = (name: string, symbol: string, uri: string) => Uint8Array.from(Buffer.concat([Buffer.alloc(65), str(name), str(symbol), str(uri)]));

describe('pair metadata', () => {
  it('reads Token-2022 inline metadata (stocks)', () => {
    expect(decodeToken2022Metadata(t22Mint('Tesla xStock', 'TSLAx', 'https://x/t.json'))).toEqual({ name: 'Tesla xStock', symbol: 'TSLAx', uri: 'https://x/t.json' });
    expect(decodeToken2022Metadata(new Uint8Array(82))).toBeNull();
  });
  it('reads Metaplex metadata (crypto)', () => {
    expect(decodeMplMetadata(mplAccount('Wrapped BTC (Wormhole)', 'WBTC', ''))).toEqual({ name: 'Wrapped BTC (Wormhole)', symbol: 'WBTC', uri: '' });
  });
  it.each([
    ['Wrapped BTC (Wormhole)', 'WBTC', 'Bitcoin', 'BTC'],
    ['Wrapped Ether (Wormhole)', 'WETH', 'Ethereum', 'ETH'],
    ['Wrapped XRP', 'wXRP', 'XRP', 'XRP'],
    ['Tesla xStock', 'TSLAx', 'Tesla', 'TSLA'],
    ['NIKE - Backpack Securities', 'NKE', 'NIKE', 'NKE'],
    ['OpenAI PreStocks', 'OPENAI', 'OpenAI', 'OPENAI'],
    ['dogwifhat', '$WIF', 'dogwifhat', '$WIF'],
  ])('shows %s as Pump does', (raw, sym, name, symbol) => {
    expect(displayName(raw, sym)).toEqual({ name, symbol });
  });
  it('sorts into Stocks / Crypto / Memes', () => {
    const t22 = TOKEN_2022_PROGRAM_ID.toBase58();
    expect(categorize(true, TOKEN_PROGRAM_ID.toBase58(), 'Fartcoin', 'x')).toBe('memes');
    expect(categorize(false, t22, 'NIKE - Backpack Securities', 'NKEx')).toBe('stocks');
    expect(categorize(false, t22, 'Tesla', 'XsDoVf')).toBe('stocks');
    expect(categorize(false, t22, 'Pump', 'pumpCmX')).toBe('crypto');
    expect(categorize(false, TOKEN_PROGRAM_ID.toBase58(), 'Bittensor', 'tao')).toBe('crypto');
  });
});

describe('buildPairs', () => {
  it('keeps Pump order, splits SOL/USDC from custom, and works when the price API is down', async () => {
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const tsla = Keypair.generate().publicKey;
    const btc = Keypair.generate().publicKey;
    const supported = [
      { mint: NATIVE_MINT, source: 'sol' },
      { mint: usdc, source: 'global' },
      { mint: btc, source: 'quoteControl' },
      { mint: tsla, source: 'quoteControl' },
    ];
    const t22 = TOKEN_2022_PROGRAM_ID.toBase58();
    const read: ReadAccounts = async (keys) =>
      keys.map((k) => {
        if (k === tsla.toBase58()) return { owner: t22, data: t22Mint('Tesla xStock', 'TSLAx', '') };
        return null;
      });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const out = await buildPairs(supported, read, fetchImpl);
    expect(out.sol.symbol).toBe('SOL');
    expect(out.usdc.symbol).toBe('USDC');
    expect(out.custom.map((p) => p.mint)).toEqual([btc.toBase58(), tsla.toBase58()]);
    expect(out.custom[1]).toMatchObject({ name: 'Tesla', symbol: 'TSLA', category: 'stocks', mcap: null, icon: null });
  });
});
