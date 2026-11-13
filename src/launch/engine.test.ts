import { getAppReferenceKey } from '@cherrydotfun/miniapp-sdk/solana';
import {
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  type BondingCurve,
  type Global,
  type QuoteControl,
  type ResolvedQuoteMint,
} from '@pump-fun/pump-sdk';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { APP_FEE_WALLET, CHERRY_APP_ID, TX_BYTE_LIMIT } from '../spike/constants';
import {
  LaunchTooLargeError,
  LaunchValidationError,
  buildLaunch,
  createInstructions,
  serializedSize,
  validateLaunch,
  type LaunchContext,
  type LaunchPlan,
  type LaunchRequest,
} from './engine';
import { errorRef, explainLaunchError } from './errors';

const k = () => Keypair.generate().publicKey;
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Shape-only state: amounts don't change instruction bytes. Gates ON so every option can be measured.
const global = {
  initialized: true,
  authority: k(),
  feeRecipient: k(),
  feeRecipients: Array.from({ length: 7 }, k),
  reservedFeeRecipient: k(),
  reservedFeeRecipients: Array.from({ length: 7 }, k),
  buybackFeeRecipients: Array.from({ length: 7 }, k),
  buybackBasisPoints: new BN(0),
  initialVirtualTokenReserves: new BN('1073000000000000'),
  initialVirtualSolReserves: new BN('30000000000'),
  initialVirtualQuoteReserves: new BN('30000000000'),
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
  whitelistPda: k(),
  mayhemModeEnabled: true,
  isCashbackEnabled: false,
  whitelistedQuoteMints: [USDC],
  creatorFeeConfigurable: true,
  maxConfigurableCreatorFeeBps: new BN(300),
  holderRewardClaimAuthority: k(),
  isHolderRewardEnabled: true,
  maxCurveDepth: 2,
} as unknown as Global;

const XSTOCK = k();
const quoteControl: QuoteControl = {
  admin: k(),
  reservesAdmin: k(),
  reserved: [],
  mints: [{ mint: XSTOCK, initialVirtualQuoteReserves: new BN(4_292_000_000) }],
};

const curve = (quoteMint: PublicKey, complete = false): BondingCurve =>
  ({
    virtualTokenReserves: new BN('1073000000000000'),
    virtualQuoteReserves: new BN('30000000000'),
    realTokenReserves: new BN('793100000000000'),
    realQuoteReserves: new BN(0),
    tokenTotalSupply: new BN('1000000000000000'),
    complete,
    creator: k(),
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint,
    creatorFeeBps: new BN(0),
    canEditCreatorFee: false,
    isHolderReward: false,
    depth: 0,
  }) as unknown as BondingCurve;

const pool = () => ({ pool: k(), baseVault: k(), quoteVault: k() });
const poolReserves = () => ({ baseReserves: new BN('200000000000000'), quoteReserves: new BN('85000000000'), virtualQuoteReserves: new BN(0) });

const QUOTES: Record<string, ResolvedQuoteMint | null> = {
  SOL: null,
  USDC: { mint: USDC, source: 'global', initialVirtualQuoteReserves: new BN(4_292_000_000), quoteTokenProgram: TOKEN_PROGRAM_ID, decimals: 6 },
  'QuoteControl Token-2022': {
    mint: XSTOCK,
    source: 'quoteControl',
    initialVirtualQuoteReserves: new BN(4_292_000_000),
    quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
    decimals: 8,
  },
  'pump coin (SOL-quoted, on curve)': (() => {
    const q = k();
    return {
      mint: q,
      source: 'pumpCoin',
      initialVirtualQuoteReserves: new BN('100000000000000'),
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 6,
      pumpQuote: { curve: { mint: q, bondingCurve: curve(PublicKey.default) }, accounts: {}, depth: 1 },
    } as ResolvedQuoteMint;
  })(),
  'pump coin depth 2, both migrated (worst case)': (() => {
    const q = k();
    const root = k();
    return {
      mint: q,
      source: 'pumpCoin',
      initialVirtualQuoteReserves: new BN('100000000000000'),
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 6,
      pumpQuote: {
        curve: { mint: q, bondingCurve: curve(root, true), pool: poolReserves(), chain: [{ mint: root, bondingCurve: curve(PublicKey.default, true), pool: poolReserves() }] },
        accounts: { pool: pool(), chain: [{ mint: root, pool: pool() }] },
        depth: 2,
      },
    } as ResolvedQuoteMint;
  })(),
};

const coin = {
  name: 'PetalDeck Coin',
  symbol: 'LROOM',
  uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
};
const coinMax = { name: 'N'.repeat(32), symbol: 'S'.repeat(13), uri: 'https://gateway.pinata.cloud/ipfs/' + 'b'.repeat(59) };

const ctx = (): LaunchContext => ({
  global,
  feeConfig: null,
  quoteControl,
  recentBlockhash: k().toBase58(),
  appFeeRecipient: new PublicKey(APP_FEE_WALLET),
});

const req = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  wallet: k(),
  mint: k(),
  coin,
  quote: null,
  devBuy: null,
  mayhemMode: false,
  creatorFeeBps: null,
  holderReward: false,
  ...over,
});

describe('validation: every Pump rule, in plain words', () => {
  const errs = (over: Partial<LaunchRequest>, g: Partial<Global> = {}) =>
    validateLaunch(req(over), { ...ctx(), global: { ...global, ...g } as Global });

  it('accepts a plain SOL launch', () => expect(errs({})).toEqual([]));
  it('enforces name 32 / ticker 13 / uri 200 and https', () => {
    expect(errs({ coin: { ...coin, name: 'x'.repeat(33) } })[0]).toMatch(/Name is too long/);
    expect(errs({ coin: { ...coin, symbol: 'x'.repeat(14) } })[0]).toMatch(/Ticker is too long/);
    expect(errs({ coin: { ...coin, uri: 'https://' + 'x'.repeat(200) } })[0]).toMatch(/too long/);
    expect(errs({ coin: { ...coin, uri: 'http://x' } })[0]).toMatch(/https/);
    expect(errs({ coin: coinMax })).toEqual([]);
  });
  it('mayhem: needs Pump gate; refused on QuoteControl and pump-coin pairs (6071)', () => {
    expect(errs({ mayhemMode: true })).toEqual([]);
    expect(errs({ mayhemMode: true, quote: QUOTES.USDC })).toEqual([]);
    expect(errs({ mayhemMode: true }, { mayhemModeEnabled: false })[0]).toMatch(/switched off/);
    expect(errs({ mayhemMode: true, quote: QUOTES['QuoteControl Token-2022'] })[0]).toMatch(/SOL or USDC/);
    expect(errs({ mayhemMode: true, quote: QUOTES['pump coin (SOL-quoted, on curve)'] })[0]).toMatch(/SOL or USDC/);
  });
  it('custom creator fee: custom pairs only, gate on, 1..max (6077/6078/6091)', () => {
    const qc = QUOTES['QuoteControl Token-2022'];
    expect(errs({ creatorFeeBps: new BN(250), quote: qc })).toEqual([]);
    expect(errs({ creatorFeeBps: new BN(250) })[0]).toMatch(/custom pairs/);
    expect(errs({ creatorFeeBps: new BN(250), quote: QUOTES.USDC })[0]).toMatch(/custom pairs/);
    expect(errs({ creatorFeeBps: new BN(301), quote: qc })[0]).toMatch(/between/);
    expect(errs({ creatorFeeBps: new BN(250), quote: qc }, { creatorFeeConfigurable: false })[0]).toMatch(/switched off/);
  });
  it('holder rewards follow Pump (Sneaks 2026-11-13): allowed while Pump has them on', () => {
    expect(errs({ holderReward: true })).toEqual([]);
    expect(errs({ holderReward: true }, { isHolderRewardEnabled: false })[0]).toMatch(/holder rewards switched off/);
  });
  it('refuses Pump paused, a zero dev buy, and wallet == app recipient', () => {
    expect(errs({}, { createV2Enabled: false })[0]).toMatch(/paused/);
    expect(errs({ devBuy: new BN(0) })[0]).toMatch(/more than 0/);
    expect(validateLaunch(req({ wallet: new PublicKey(APP_FEE_WALLET) }), ctx())[0]).toMatch(/differ/);
  });
  it('buildLaunch throws the same problems', async () => {
    await expect(buildLaunch(req({ devBuy: new BN(0) }), ctx())).rejects.toBeInstanceOf(LaunchValidationError);
  });
  it('a Holders coin has no fee-split tx (nothing to split) and still carries the reference key', async () => {
    const plan = await buildLaunch(req({ holderReward: true, devBuy: new BN(10_000_000) }), ctx());
    expect(plan.steps.some((s) => /creator fees/i.test(s))).toBe(false);
    expect(plan.txs.flatMap((t) => t.instructions).some((ix) => ix.programId.equals(PUMP_FEE_PROGRAM_ID))).toBe(false);
    expect(plan.bytes.every((b) => b <= TX_BYTE_LIMIT)).toBe(true);
  });
});

const ref = getAppReferenceKey(CHERRY_APP_ID);
const signersOf = (tx: Transaction) => {
  const m = tx.compileMessage();
  return m.accountKeys.slice(0, m.header.numRequiredSignatures).map(String);
};
const isCreate = (tx: Transaction) => tx.instructions.some((ix) => ix.programId.equals(PUMP_PROGRAM_ID) && ix.keys.length > 12 && ix.keys[0].isSigner);

/** Shape checks that hold for every plan. */
function checkPlan(plan: LaunchPlan, wallet: PublicKey, mint: PublicKey) {
  expect(plan.bytes.every((b) => b <= TX_BYTE_LIMIT)).toBe(true);
  plan.txs.forEach((tx, i) => {
    // Wallet pays every tx; the mint co-signs only the create (always tx 0).
    expect(signersOf(tx)).toEqual((i === 0 ? [wallet, mint] : [wallet]).map(String));
    const carriers = tx.instructions.filter((ix) => ix.keys.some((m) => m.pubkey.equals(ref)));
    const last = i === plan.txs.length - 1;
    expect(carriers).toHaveLength(last && plan.feeSplit ? 1 : 0);
    for (const c of carriers) {
      expect(c.programId.equals(SystemProgram.programId)).toBe(true);
      const meta = c.keys.find((m) => m.pubkey.equals(ref))!;
      expect([meta.isSigner, meta.isWritable]).toEqual([false, false]);
    }
  });
  expect(isCreate(plan.txs[0])).toBe(true);
  if (plan.feeSplit) {
    const split = plan.txs[plan.txs.length - 1];
    expect(split.instructions.filter((ix) => ix.programId.equals(PUMP_FEE_PROGRAM_ID))).toHaveLength(2);
    expect(plan.steps[plan.steps.length - 1]).toMatch(/95%.*5%.*permanent/);
  }
}

describe.each(Object.keys(QUOTES))('pair %s', (pairName) => {
  const quote = QUOTES[pairName];
  const exotic = quote?.source === 'quoteControl' || quote?.source === 'pumpCoin';
  const worst = pairName.includes('worst case');

  it.each([
    ['create only', null],
    ['create + dev buy', new BN(10_000_000)],
  ] as const)('%s: one approval, every tx fits, 95/5 split last', async (label, devBuy) => {
    const wallet = k();
    const mint = k();
    const r = req({ wallet, mint, quote, devBuy, creatorFeeBps: exotic ? new BN(250) : null });
    const run = (c = coin) => buildLaunch({ ...r, coin: c }, ctx());
    const fmt = (p: Promise<LaunchPlan>) => p.then((x) => `${x.txs.length} tx: ${x.bytes.join(' + ')} B`).catch((e: Error) => `REFUSED (${e.name})`);
    console.log(`[bytes] ${pairName} · ${label}: ${await fmt(run())} · max metadata ${await fmt(run(coinMax))}`);
    if (worst) {
      // Refused before anything is signed: too large, or the SDK's own chain check.
      const err = await run().then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(explainLaunchError(err)).not.toMatch(/Something went wrong/);
      return;
    }
    checkPlan(await run(), wallet, mint);
    checkPlan(await run(coinMax), wallet, mint);
  });
});

it('SOL + dev buy stays atomic (one create+buy tx) with normal metadata', async () => {
  const plan = await buildLaunch(req({ devBuy: new BN(10_000_000) }), ctx());
  expect(plan.steps).toEqual(['Create coin + first buy', 'Set creator fees: you 95% / PetalDeck 5% (permanent)']);
});

it('token pair + dev buy splits the buy into its own tx, after the create', async () => {
  const plan = await buildLaunch(req({ quote: QUOTES.USDC, devBuy: new BN(10_000_000) }), ctx());
  expect(plan.steps.map((s) => s.split(' (')[0])).toEqual(['Create coin', 'First buy', 'Set creator fees: you 95% / PetalDeck 5%']);
});

it('create_v2 bytes are identical whether built alone or by the SDK create-and-buy helper', async () => {
  const r = req({ quote: QUOTES.USDC, devBuy: new BN(10_000_000) });
  const parts = await createInstructions(r, ctx());
  const alone = await createInstructions({ ...r, devBuy: null }, ctx());
  expect(parts.create.data.equals(alone.create.data)).toBe(true);
});

it('mayhem SOL launch with dev buy fits', async () => {
  const plan = await buildLaunch(req({ mayhemMode: true, devBuy: new BN(10_000_000) }), ctx());
  console.log(`[bytes] SOL mayhem + buy: ${plan.bytes.join(' + ')} B`);
  expect(plan.bytes.every((b) => b <= TX_BYTE_LIMIT)).toBe(true);
});

it('serializedSize counts every signature slot', async () => {
  const plan = await buildLaunch(req(), ctx());
  expect(serializedSize(plan.txs[0])).toBe(1 + 2 * 64 + plan.txs[0].serializeMessage().length);
});

describe('token programs (F IncorrectProgramId)', () => {
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  // ATA create keys: [payer, ata, owner, mint, system, tokenProgram].
  const ataCreates = (tx: Transaction) =>
    tx.instructions.filter((ix) => ix.programId.equals(ATA_PROGRAM)).map((ix) => ({ mint: ix.keys[3].pubkey, program: ix.keys[5].pubkey }));

  it('USDC pair: new pump mint ATA uses Token-2022, USDC ATAs use SPL Token', async () => {
    const r = req({ quote: QUOTES.USDC, devBuy: new BN(1_000_000) });
    const plan = await buildLaunch(r, ctx());
    const all = plan.txs.flatMap(ataCreates);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      if (a.mint.equals(r.mint)) expect(a.program.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      else if (a.mint.equals(USDC)) expect(a.program.equals(TOKEN_PROGRAM_ID)).toBe(true);
      else throw new Error(`unexpected ATA mint ${a.mint.toBase58()}`);
    }
    expect(all.some((a) => a.mint.equals(r.mint))).toBe(true);
  });

  it('token pair: fee-share tx creates the sharing vault quote ATA before update_fee_shares_v2', async () => {
    const plan = await buildLaunch(req({ quote: QUOTES.USDC }), ctx());
    const fee = plan.txs[plan.txs.length - 1];
    const programs = fee.instructions.map((ix) => ix.programId.toBase58());
    expect(programs).toEqual([PUMP_FEE_PROGRAM_ID.toBase58(), ATA_PROGRAM.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58()]);
    expect(ataCreates(fee)[0]).toEqual({ mint: USDC, program: TOKEN_PROGRAM_ID });
    expect(serializedSize(fee)).toBeLessThanOrEqual(TX_BYTE_LIMIT);
  });

  it('SOL pair: fee-share tx has no ATA create', async () => {
    const plan = await buildLaunch(req(), ctx());
    expect(ataCreates(plan.txs[plan.txs.length - 1])).toEqual([]);
  });
});

describe('errorRef', () => {
  it('is stage + error class, never the raw message', () => {
    const e = new TypeError('secret https://rpc.example/?api-key=abc');
    expect(errorRef('prep', e)).toBe('prep-TypeError');
    expect(errorRef('sign', 'boom')).toBe('sign-string');
  });
});
