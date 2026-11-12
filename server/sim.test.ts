import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { allow, parseTxs } from './sim';

const payer = Keypair.generate().publicKey;
const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' }).add(
  SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 }),
);
const b64 = (t: Transaction) => t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

describe('/api/sim input checks', () => {
  it('accepts 1..4 unsigned legacy txs', () => {
    const out = parseTxs({ txs: [b64(tx), b64(tx)] });
    expect(Array.isArray(out) && out.length).toBe(2);
  });

  it('rejects empty, too many, junk', () => {
    expect(parseTxs({ txs: [] })).toMatch(/1\.\.4/);
    expect(parseTxs({ txs: Array(5).fill(b64(tx)) })).toMatch(/1\.\.4/);
    expect(parseTxs({ txs: ['not base64 tx'] })).toBe('not a legacy transaction');
    expect(parseTxs({})).toMatch(/1\.\.4/);
  });

  it('rate-limits per IP', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(allow('1.2.3.4', now, 3)).toBe(true);
    expect(allow('1.2.3.4', now, 3)).toBe(false);
    expect(allow('1.2.3.4', now + 61_000, 3)).toBe(true);
  });
});
