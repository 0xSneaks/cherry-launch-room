// PetalDeck's 5% fee-share recipient, from server config. Not shown to users, not editable in the UI.
import { PublicKey } from '@solana/web3.js';
import { APP_FEE_WALLET } from '../spike/constants.js';

/**
 * PETALDECK_FEE_WALLET (raw base58, never a .skr name) when set; else the pinned APP_FEE_WALLET.
 * A set-but-invalid value throws, so launches fail closed instead of silently paying someone else.
 */
export function feeRecipientFromEnv(value: string | undefined): string {
  const v = value?.trim();
  if (!v) return APP_FEE_WALLET;
  let key: PublicKey;
  try {
    key = new PublicKey(v);
  } catch {
    throw new Error('PETALDECK_FEE_WALLET is not a valid Solana address');
  }
  if (key.toBase58() !== v) throw new Error('PETALDECK_FEE_WALLET is not a valid Solana address');
  return v;
}
