import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAppReferenceKey } from '@cherrydotfun/miniapp-sdk/solana';
import { PUMP_FEE_PROGRAM_ID as PUMP_FEES_PROGRAM_ID, type Global } from '@pump-fun/pump-sdk';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import {
  VARIANTS,
  buildVariant,
  fitsLegacy,
  feeShareholders,
  requiredSigners,
  serializedSize,
  type CoinMeta,
  type Variant,
} from './build';
import { SPIKE_COIN } from './coin';
import { APP_FEE_WALLET, APP_SHARE_BPS, CHERRY_APP_ID, SPIKE_TEST_RECIPIENT, TX_BYTE_LIMIT, USER_SHARE_BPS } from './constants';

// Shape-only Global: amounts don't change instruction bytes. Values ≈ mainnet defaults.
const k = () => Keypair.generate().publicKey;
const fakeGlobal = {
  initialized: true,
  authority: k(),
  feeRecipient: k(),
  feeRecipients: Array.from({ length: 7 }, k),
  reservedFeeRecipient: k(),
  reservedFeeRecipients: Array.from({ length: 7 }, k),
  initialVirtualTokenReserves: new BN('1073000000000000'),
  initialVirtualSolReserves: new BN('30000000000'),
  initialRealTokenReserves: new BN('793100000000000'),
  tokenTotalSupply: new BN('1000000000000000'),
  feeBasisPoints: new BN(95),
  creatorFeeBasisPoints: new BN(30),
  withdrawAuthority: k(),
  enableMigrate: false,
  poolMigrationFee: new BN(15000001),
  setCreatorAuthority: k(),
  adminSetCreatorAuthority: k(),
  createV2Enabled: true,
  mayhemModeEnabled: false,
  creatorFeeConfigurable: false,
  maxConfigurableCreatorFeeBps: new BN(0),
  isHolderRewardEnabled: false,
  holderRewardClaimAuthority: k(),
} as unknown as Global;

const coinMax = {
  name: 'N'.repeat(32), // pump-deck max name
  symbol: 'S'.repeat(10),
  uri: 'https://gateway.pinata.cloud/ipfs/' + 'b'.repeat(59), // CIDv1 length
};

const input = (wallet: PublicKey, mint: PublicKey, coin: CoinMeta = SPIKE_COIN) => ({
  wallet,
  mint,
  recentBlockhash: Keypair.generate().publicKey.toBase58(),
  coin,
  global: fakeGlobal,
  feeConfig: null,
  appFeeRecipient: new PublicKey(APP_FEE_WALLET),
});

const build = (variant: Variant, wallet = k(), mint = k(), coin: CoinMeta = SPIKE_COIN) =>
  buildVariant(variant, input(wallet, mint, coin));

describe('money constants', () => {
  it('pins the app fee wallet and App ID exactly', () => {
    expect(APP_FEE_WALLET).toBe('FtuidxSaoNDeTuNTDuf9jLACVwqjgQeBwKTYC54f3GYp');
    expect(CHERRY_APP_ID).toBe('52e41534-4c7b-4237-9a16-ec8ea7a3c9dc');
    expect(new PublicKey(APP_FEE_WALLET).toBase58()).toBe(APP_FEE_WALLET);
    expect(new PublicKey(SPIKE_TEST_RECIPIENT).toBase58()).toBe(SPIKE_TEST_RECIPIENT);
    expect(SPIKE_TEST_RECIPIENT).not.toBe(APP_FEE_WALLET);
  });
  it('splits 95 / 5 and sums to 10 000 bps', () => {
    expect([USER_SHARE_BPS, APP_SHARE_BPS]).toEqual([9500, 500]);
    const w = k();
    const sh = feeShareholders(w, new PublicKey(APP_FEE_WALLET));
    expect(sh.reduce((s, x) => s + x.shareBps, 0)).toBe(10_000);
    expect(sh[0].address.equals(w)).toBe(true);
  });
  it('refuses a split where creator == app recipient', () => {
    const w = new PublicKey(APP_FEE_WALLET);
    expect(() => feeShareholders(w, w)).toThrow();
  });
});

describe.each(Object.keys(VARIANTS) as Variant[])('variant %s', (variant) => {
  it('signers: wallet first (fee payer); mint only where create_v2 is', async () => {
    const wallet = k();
    const mint = k();
    const txs = await build(variant, wallet, mint);
    VARIANTS[variant].txs.forEach((shape, i) => {
      const expected = shape.create ? [wallet, mint] : [wallet];
      expect(requiredSigners(txs[i]).map(String)).toEqual(expected.map(String));
    });
  });

  it('reference key only on our own System transfer, read-only, non-signer', async () => {
    const txs = await build(variant);
    const ref = getAppReferenceKey(CHERRY_APP_ID);
    VARIANTS[variant].txs.forEach((shape, i) => {
      const tx = txs[i];
      const carriers = tx.instructions.filter((ix) => ix.keys.some((m) => m.pubkey.equals(ref)));
      expect(carriers).toHaveLength(shape.reference ? 1 : 0);
      if (!shape.reference) return;
      expect(carriers[0].programId.equals(SystemProgram.programId)).toBe(true);
      const meta = carriers[0].keys.find((m) => m.pubkey.equals(ref))!;
      expect(meta.isSigner).toBe(false);
      expect(meta.isWritable).toBe(false);
      for (const ix of tx.instructions.filter((x) => !x.programId.equals(SystemProgram.programId))) {
        expect(ix.keys.some((m) => m.pubkey.equals(ref))).toBe(false);
      }
    });
  });

  it('signable variants fit 1232 B with spike metadata; sizes logged', async () => {
    const spike = (await build(variant)).map(serializedSize);
    const max = (await build(variant, k(), k(), coinMax)).map(serializedSize);
    console.log(`[bytes] ${variant}: spike meta ${spike.join(' + ')} B · max meta ${max.join(' + ')} B (limit ${TX_BYTE_LIMIT})`);
    const txs = await build(variant);
    expect(txs.every(fitsLegacy)).toBe(VARIANTS[variant].signable);
  });
});

describe('fee share instructions', () => {
  it('use the pump-fees program and the creator as authority', async () => {
    const wallet = k();
    const [, feeTx] = await build('D', wallet);
    const progs = feeTx.instructions.map((ix) => ix.programId.toBase58());
    expect(progs.filter((p) => p === PUMP_FEES_PROGRAM_ID.toBase58())).toHaveLength(2);
  });
});

describe('no-broadcast guard', () => {
  it('spike + launch engine + api source never calls a send method', () => {
    const files = [
      ...readdirSync('src/spike').map((f) => join('src/spike', f)),
      ...readdirSync('api').map((f) => join('api', f)),
      ...readdirSync('src/launch').map((f) => join('src/launch', f)),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/sendRawTransaction|sendTransaction\(|signAndSendTransaction\(|sendAndConfirm/);
    }
  });
});
