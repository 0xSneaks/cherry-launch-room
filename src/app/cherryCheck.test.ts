import { PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction, TransactionInstruction, type PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { probesFrom } from './cherryCheck';

const ix = (programId: PublicKey, tag: number) => new TransactionInstruction({ programId, keys: [], data: Buffer.from([tag]) });

describe('probesFrom (Cherry check)', () => {
  const w = Keypair.generate().publicKey;
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1 });
  const create = ix(PUMP_PROGRAM_ID, 1);
  const buy = ix(PUMP_PROGRAM_ID, 2);
  const config = ix(PUMP_FEE_PROGRAM_ID, 3);
  const update = ix(PUMP_FEE_PROGRAM_ID, 4);
  const ref = SystemProgram.transfer({ fromPubkey: w, toPubkey: w, lamports: 0 });
  const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

  it('isolates every launch step, plus each tx as launched', () => {
    const probes = probesFrom([tx(cu, create, buy), tx(config, update, ref)]);
    const by = Object.fromEntries(probes.map((p) => [p.name, p.ixs]));
    expect(by['Create only']).toEqual([cu, create]);
    expect(by['First buy only']).toEqual([buy]);
    expect(by['Fee-split setup only']).toEqual([config]);
    expect(by['Fee-split 95/5 update only']).toEqual([update]);
    expect(by['App reference only']).toEqual([ref]);
    expect(by['Step 2 as launched (split + ref)']).toEqual([config, update, ref]);
    expect(by['Step 1 as launched (create + buy)']).toEqual([cu, create, buy]);
  });

  it('holder coins (one tx) still get create / buy / as-launched probes', () => {
    expect(probesFrom([tx(cu, create, buy, ref)]).map((p) => p.name)).toEqual(['Create only', 'First buy only', 'Step 1 as launched (create + buy)']);
  });
});
