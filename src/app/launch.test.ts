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
    await expect(buildLaunch(form)).rejects.toBeInstanceOf(FeeWalletIsSignerError);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(signer.signAllTransactions).not.toHaveBeenCalled();
  });
});
