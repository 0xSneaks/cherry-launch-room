// Chained vs unchained simulation on an offline fork (fake RPC: no network).
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { READ_METHODS, rpcReader, simulateChain, type RpcRead } from './fork';

const SYSTEM = '11111111111111111111111111111111';
const payer = Keypair.generate().publicKey;
const fresh = Keypair.generate().publicKey;
const sink = Keypair.generate().publicKey;
const BH = '11111111111111111111111111111111';

/** Mainnet stand-in: only the payer exists (2 SOL). Anything not a READ method throws. */
const fakeRead: RpcRead = async (method, params) => {
  if (!READ_METHODS.has(method)) throw new Error('not a read');
  if (method === 'getSlot') return 300_000_000;
  if (method === 'getBlockTime') return 1_794_500_000;
  if (method === 'getEpochInfo') return { epoch: 700 };
  const keys = params[0] as string[];
  return {
    value: keys.map((k) =>
      k === payer.toBase58() ? { lamports: 2_000_000_000, owner: SYSTEM, data: ['', 'base64'], executable: false } : null,
    ),
  };
};

// tx1 creates `fresh` (funds it); tx2 spends from `fresh`: only valid after tx1.
const tx1 = new Transaction({ feePayer: payer, recentBlockhash: BH }).add(
  SystemProgram.transfer({ fromPubkey: payer, toPubkey: fresh, lamports: 100_000_000 }),
);
const tx2 = new Transaction({ feePayer: payer, recentBlockhash: BH }).add(
  SystemProgram.transfer({ fromPubkey: fresh, toPubkey: sink, lamports: 50_000_000 }),
);

describe('simulateChain', () => {
  it('unchained: tx2 fails because tx1 state is missing (what RPC simulate does)', async () => {
    const [a, b] = await simulateChain(fakeRead, [tx1, tx2], { chained: false });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  it('chained: tx2 sees tx1 state and passes', async () => {
    const [a, b] = await simulateChain(fakeRead, [tx1, tx2]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('chained: a failed tx stops the chain', async () => {
    const [a, b] = await simulateChain(fakeRead, [tx2, tx1]);
    expect(a.ok).toBe(false);
    expect(b.err).toMatch(/NOT_RUN/);
  });

  it('the RPC reader refuses anything but reads (no send path)', async () => {
    const read = rpcReader('https://example.invalid', (() => {
      throw new Error('network must not be touched');
    }) as unknown as typeof fetch);
    await expect(read('sendTransaction', [])).rejects.toThrow(/not allowed/);
    await expect(read('requestAirdrop', [])).rejects.toThrow(/not allowed/);
  });
});

