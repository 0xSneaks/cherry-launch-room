import { Connection, Keypair } from '@solana/web3.js';
import type { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { describe, expect, it, vi } from 'vitest';
import { emptyForm } from './form';
import { FeeWalletIsSignerError, createLauncher } from './launch';

describe('buildLaunch(formData)', () => {
  it('blocks the launch when the signer IS the 5% fee recipient, before any RPC or signing', async () => {
    const wallet = Keypair.generate().publicKey;
    const pump = new Proxy({}, { get: () => vi.fn(() => { throw new Error('no RPC expected'); }) }) as unknown as OnlinePumpSdk;
    const signer = { signTransaction: vi.fn(), signAllTransactions: vi.fn() };
    const { buildLaunch } = createLauncher({ connection: new Connection('http://127.0.0.1:1'), pump, signer, wallet, feeRecipient: wallet });
    const form = { ...emptyForm(), name: 'Cherry', ticker: 'PETAL', media: { type: 'image/png', size: 1 } };
    await expect(buildLaunch(form, 'https://ipfs.io/ipfs/x')).rejects.toBeInstanceOf(FeeWalletIsSignerError);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(signer.signAllTransactions).not.toHaveBeenCalled();
  });
});

describe('live send helpers', async () => {
  const { confirmSignature, sendSigned, LaunchSendError } = await import('./launch');
  const { Transaction: Tx, SystemProgram } = await import('@solana/web3.js');
  const kp = Keypair.generate();
  const tx = new Tx({ feePayer: kp.publicKey, recentBlockhash: '11111111111111111111111111111111' }).add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 }),
  );
  tx.sign(kp);

  it('sendSigned returns the signature, or throws the server message', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ signature: 'SIG' })));
    expect(await sendSigned(tx, ok as unknown as typeof fetch)).toBe('SIG');
    const bad = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'SEND_FAILED', message: 'insufficient lamports' }), { status: 422 }));
    await expect(sendSigned(tx, bad as unknown as typeof fetch)).rejects.toBeInstanceOf(LaunchSendError);
  });

  it('confirmSignature waits for confirmed and surfaces on-chain errors', async () => {
    let n = 0;
    const conn = { getSignatureStatuses: vi.fn(async () => ({ value: [n++ < 1 ? null : { confirmationStatus: 'confirmed', err: null }] })) } as unknown as Connection;
    await expect(confirmSignature(conn, 'SIG', 5000, 1)).resolves.toBeUndefined();
    const failed = { getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6024 }] } }] })) } as unknown as Connection;
    await expect(confirmSignature(failed, 'SIG', 5000, 1)).rejects.toBeInstanceOf(LaunchSendError);
  });
});

describe('mint pre-sign (Cherry Wallet sees the create with the mint signature already on it)', () => {
  it('a mint signature added before the wallet survives the wallet round-trip and verifies', async () => {
    const { Transaction: Tx, SystemProgram } = await import('@solana/web3.js');
    const wallet = Keypair.generate();
    const mint = Keypair.generate();
    const tx = new Tx({ feePayer: wallet.publicKey, recentBlockhash: '11111111111111111111111111111111' }).add(
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
    );
    tx.partialSign(mint); // what run() now does before Cherry
    // Host side: receives the bytes, adds the wallet signature, returns bytes.
    const atHost = Tx.from(tx.serialize({ requireAllSignatures: false }));
    expect(atHost.signatures.find((s) => s.publicKey.equals(mint.publicKey))?.signature).not.toBeNull();
    atHost.partialSign(wallet);
    const back = Tx.from(atHost.serialize());
    back.partialSign(mint); // run() re-signs after Cherry; must stay valid
    expect(back.verifySignatures(true)).toBe(true);
  });
});
