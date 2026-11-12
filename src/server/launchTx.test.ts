import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { referenceInstruction } from '../spike/build';
import { checkLaunchTx } from './launchTx';

const BH = '11111111111111111111111111111111';
const wallet = Keypair.generate();
const mint = Keypair.generate().publicKey;
const app = Keypair.generate().publicKey;

async function feeTx() {
  return new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BH }).add(
    await PUMP_SDK.createFeeSharingConfig({ creator: wallet.publicKey, mint, pool: null }),
    await PUMP_SDK.updateFeeShares({
      authority: wallet.publicKey,
      mint,
      currentShareholders: [wallet.publicKey],
      newShareholders: [{ address: wallet.publicKey, shareBps: 9500 }, { address: app, shareBps: 500 }],
      bondingCurveComplete: false,
    }),
    referenceInstruction(wallet.publicKey),
  );
}
const b64 = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

describe('/api/send gate', () => {
  it('relays a fully signed PetalDeck fee-share tx', async () => {
    const tx = await feeTx();
    tx.sign(wallet);
    expect(checkLaunchTx(b64(tx)).ok).toBe(true);
  });
  it('refuses an unsigned tx', async () => {
    expect(checkLaunchTx(b64(await feeTx()))).toEqual({ ok: false, error: 'missing or invalid signature' });
  });
  it('refuses a SOL transfer to someone else (not an open relay)', () => {
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BH }).add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: app, lamports: 1 }),
    );
    tx.sign(wallet);
    expect(checkLaunchTx(b64(tx)).ok).toBe(false);
  });
  it('refuses a tx with no Pump instruction', () => {
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BH }).add(referenceInstruction(wallet.publicKey));
    tx.sign(wallet);
    expect(checkLaunchTx(b64(tx))).toEqual({ ok: false, error: 'not a launch transaction' });
  });
  it('refuses junk', () => {
    expect(checkLaunchTx('not base64!').ok).toBe(false);
    expect(checkLaunchTx(42).ok).toBe(false);
  });
});
