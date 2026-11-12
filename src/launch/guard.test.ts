import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { APP_FEE_WALLET } from '../spike/constants';
import { feeShareholders } from './engine';
import { RecipientIsSignerError, assertRecipientNotSigner, recipientIsSigner } from './guard';

const fee = new PublicKey(APP_FEE_WALLET);
const user = Keypair.generate().publicKey;

describe('5% recipient guard', () => {
  it('flags the fee wallet signing its own launch (the Ftui…3GYp case)', () => {
    expect(recipientIsSigner(fee, APP_FEE_WALLET)).toBe(true);
    expect(() => assertRecipientNotSigner(fee, fee)).toThrow(RecipientIsSignerError);
  });

  it('passes a normal user', () => {
    expect(recipientIsSigner(user, fee)).toBe(false);
    expect(() => assertRecipientNotSigner(user, fee)).not.toThrow();
  });

  it('the engine refuses to build a split where recipient = signer', () => {
    expect(() => feeShareholders(fee, fee)).toThrow(RecipientIsSignerError);
    expect(feeShareholders(user, fee).map((s) => s.shareBps)).toEqual([9500, 500]);
  });
});

describe('test page: which variants use the 5% recipient', async () => {
  const { hasFeeShare, ALL_VARIANTS } = await import('../spike/variants');
  it('A, B, C, E never set a split; D, F, G, H, P do', () => {
    expect(ALL_VARIANTS.filter(hasFeeShare)).toEqual(['D', 'E', 'F', 'G', 'H', 'P']);
  });
});
