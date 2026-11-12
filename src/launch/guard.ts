// Money-path guard: the 5% fee-share recipient must never be the wallet that signs the launch.
// Pump refuses duplicate shareholders, and a launch by PetalDeck's own fee wallet would pay
// itself 100%: either way the 95/5 split is wrong. Block it before anything is built.
import { PublicKey } from '@solana/web3.js';

export class RecipientIsSignerError extends Error {
  constructor() {
    super("The 5% fee recipient can't be the wallet that signs this launch. Use a different wallet to launch.");
    this.name = 'RecipientIsSignerError';
  }
}

export function recipientIsSigner(signer: PublicKey | string, recipient: PublicKey | string): boolean {
  return new PublicKey(signer).equals(new PublicKey(recipient));
}

export function assertRecipientNotSigner(signer: PublicKey | string, recipient: PublicKey | string): void {
  if (recipientIsSigner(signer, recipient)) throw new RecipientIsSignerError();
}
