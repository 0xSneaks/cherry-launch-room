// Sign-only spike transaction builders (Pump.fun create_v2 via @pump-fun/pump-sdk 4.3.1).
// Pure: no RPC, no signing, no sending. Callers supply blockhash and (for buys) Global.
import { getAppReferenceKey, withAppReference } from '@cherrydotfun/miniapp-sdk/solana';
import {
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { APP_SHARE_BPS, CHERRY_APP_ID, SPIKE_BUY_LAMPORTS, TX_BYTE_LIMIT, USER_SHARE_BPS } from './constants';

export type Variant = 'A' | 'B' | 'C' | 'D' | 'E';

/** One transaction's contents. */
export interface TxShape {
  reference: boolean;
  buy: boolean;
  create: boolean;
  feeShare: boolean;
}

const create = { create: true, buy: false, feeShare: false, reference: false };

// Byte budget (VERIFIED offline, build.test.ts): create+buy+reference = 1253 B and
// create+fee-share+reference = 1354 B with realistic metadata — over 1232. So C drops the
// reference ix, D splits into two txs under one signAllTransactions approval, and E (the full
// launch shape) is measured only, never signed.
export const VARIANTS: Record<Variant, { title: string; txs: TxShape[]; signable: boolean }> = {
  A: { title: 'create_v2 only', txs: [create], signable: true },
  B: { title: 'create_v2 + reference key (0-lamport self transfer)', txs: [{ ...create, reference: true }], signable: true },
  C: { title: 'create_v2 + 0.01 SOL first buy (no reference: does not fit)', txs: [{ ...create, buy: true }], signable: true },
  D: {
    title: 'signAll: [create + ref] + [fee share 95/5 + ref]',
    txs: [
      { ...create, reference: true },
      { create: false, buy: false, feeShare: true, reference: true },
    ],
    signable: true,
  },
  E: {
    title: 'create + buy + fee share + ref in one tx (measure only)',
    txs: [{ create: true, buy: true, feeShare: true, reference: true }],
    signable: false,
  },
};

export interface CoinMeta {
  name: string;
  symbol: string;
  uri: string;
}

export interface BuildInput {
  shape: TxShape;
  /** Cherry wallet: creator, fee payer and only wallet signer. */
  wallet: PublicKey;
  /** Fresh per-launch mint (keypair lives in memory only). */
  mint: PublicKey;
  recentBlockhash: string;
  coin: CoinMeta;
  /** Needed for variants with a buy. */
  global?: Global;
  feeConfig?: FeeConfig | null;
  buyLamports?: number;
  /** 5% recipient. Must differ from `wallet` (Pump rejects duplicate shareholders). */
  appFeeRecipient?: PublicKey;
}

/** 0-lamport wallet→wallet System transfer carrying the Cherry app reference key. Never touches the Pump ix. */
export function referenceInstruction(wallet: PublicKey, appId = CHERRY_APP_ID): TransactionInstruction {
  return withAppReference(
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 0 }),
    appId,
  );
}

export function feeShareholders(wallet: PublicKey, appFeeRecipient: PublicKey) {
  if (wallet.equals(appFeeRecipient)) {
    throw new Error('Fee-share recipient must differ from the creator wallet.');
  }
  return [
    { address: wallet, shareBps: USER_SHARE_BPS },
    { address: appFeeRecipient, shareBps: APP_SHARE_BPS },
  ];
}

/** create_fee_sharing_config + update_fee_shares for a fresh (live-curve) SOL coin. */
export async function feeShareInstructions(
  wallet: PublicKey,
  mint: PublicKey,
  appFeeRecipient: PublicKey,
): Promise<TransactionInstruction[]> {
  return [
    await PUMP_SDK.createFeeSharingConfig({ creator: wallet, mint, pool: null }),
    await PUMP_SDK.updateFeeShares({
      authority: wallet,
      mint,
      // INFERENCE: a new config starts with the creator as sole shareholder.
      currentShareholders: [wallet],
      newShareholders: feeShareholders(wallet, appFeeRecipient),
      bondingCurveComplete: false,
    }),
  ];
}

export async function buildInstructions(input: BuildInput): Promise<TransactionInstruction[]> {
  const { shape, wallet, mint, coin } = input;
  const ixs: TransactionInstruction[] = [];

  if (shape.create && shape.buy) {
    if (!input.global) throw new Error('Global state is required for a buy.');
    const solAmount = new BN(input.buyLamports ?? SPIKE_BUY_LAMPORTS);
    const amount = getBuyTokenAmountFromSolAmount({
      global: input.global,
      feeConfig: input.feeConfig ?? null,
      mintSupply: null,
      bondingCurve: null,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
    ixs.push(
      ...(await PUMP_SDK.createV2AndBuyInstructions({
        global: input.global,
        mint,
        ...coin,
        creator: wallet,
        user: wallet,
        amount,
        solAmount,
        mayhemMode: false,
      })),
    );
  } else if (shape.create) {
    ixs.push(
      await PUMP_SDK.createV2Instruction({ mint, ...coin, creator: wallet, user: wallet, mayhemMode: false }),
    );
  } else if (shape.buy) {
    throw new Error('A buy without create is out of scope for the spike.');
  }

  if (shape.feeShare) {
    if (!input.appFeeRecipient) throw new Error('Fee-share recipient is required.');
    ixs.push(...(await feeShareInstructions(wallet, mint, input.appFeeRecipient)));
  }

  if (shape.reference) ixs.push(referenceInstruction(wallet));
  return ixs;
}

export async function buildTransaction(input: BuildInput): Promise<Transaction> {
  const tx = new Transaction({ feePayer: input.wallet, recentBlockhash: input.recentBlockhash });
  tx.add(...(await buildInstructions(input)));
  return tx;
}

/** Every tx of a variant, in signing order. */
export async function buildVariant(
  variant: Variant,
  input: Omit<BuildInput, 'shape'>,
): Promise<Transaction[]> {
  return Promise.all(VARIANTS[variant].txs.map((shape) => buildTransaction({ ...input, shape })));
}

/** Wire size once every required signature slot is filled (64 B each). */
export function serializedSize(tx: Transaction): number {
  const message = tx.serializeMessage();
  const sigCount = message[0]; // numRequiredSignatures (header byte 0)
  return 1 /* compact-u16 sig count, <128 */ + sigCount * 64 + message.length;
}

export const fitsLegacy = (tx: Transaction) => serializedSize(tx) <= TX_BYTE_LIMIT;

/** Signers the message requires, in order. */
export function requiredSigners(tx: Transaction): PublicKey[] {
  const msg = tx.compileMessage();
  return msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
}

export const appReferenceKey = () => getAppReferenceKey(CHERRY_APP_ID);
