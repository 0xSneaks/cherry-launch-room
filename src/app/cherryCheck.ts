// Owner-only "Cherry check": which launch step does the Cherry Wallet's safety scan refuse?
// Builds a real SOL launch (0.01 SOL first buy, 95/5 split), splits it into one probe per step,
// and asks Cherry to sign each probe ON ITS OWN. SIGN-ONLY: signed bytes are zeroed and dropped,
// nothing is ever sent. If Cherry shows its approve screen, the scan passed; the owner taps Cancel.
import { getBridgeError } from '@cherrydotfun/miniapp-sdk';
import { PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, type OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { Keypair, SystemProgram, Transaction, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { buildLaunch } from '../launch/engine';
import type { CherrySigner } from './launch';
import { DRY_RUN_METADATA_URI } from './config';

export interface Probe {
  name: string;
  ixs: TransactionInstruction[];
}

export interface ProbeResult {
  name: string;
  /** passed = Cherry's scan let it through (approve screen shown; signed or cancelled). */
  verdict: 'passed' | 'REFUSED' | 'error';
  detail: string;
}

const is = (ix: TransactionInstruction, p: PublicKey) => ix.programId.equals(p);
const isRef = (ix: TransactionInstruction) => is(ix, SystemProgram.programId);

/** One probe per launch step, from the txs the app really sends. Pure: unit-tested. */
export function probesFrom(txs: Transaction[]): Probe[] {
  const [first, split] = txs;
  const a = first.instructions;
  const createAt = a.findIndex((ix) => is(ix, PUMP_PROGRAM_ID));
  const probes: Probe[] = [
    { name: 'Create only', ixs: a.slice(0, createAt + 1) },
    { name: 'First buy only', ixs: a.slice(createAt + 1).filter((ix) => !isRef(ix)) },
  ];
  if (split) {
    const b = split.instructions;
    const fee = b.filter((ix) => is(ix, PUMP_FEE_PROGRAM_ID));
    probes.push(
      { name: 'Fee-split setup only', ixs: [fee[0]] },
      { name: 'Fee-split 95/5 update only', ixs: b.filter((ix) => !isRef(ix) && ix !== fee[0]) },
      { name: 'App reference only', ixs: b.filter(isRef) },
      { name: 'Step 2 as launched (split + ref)', ixs: b },
    );
  }
  probes.push({ name: 'Step 1 as launched (create + buy)', ixs: a });
  return probes.filter((p) => p.ixs.length > 0);
}

export interface CheckDeps {
  connection: Connection;
  pump: OnlinePumpSdk;
  signer: CherrySigner;
  wallet: PublicKey;
  feeRecipient: PublicKey;
}

export async function runCherryCheck(deps: CheckDeps, onResult: (r: ProbeResult, i: number, n: number) => void): Promise<ProbeResult[]> {
  const { connection, pump, signer, wallet, feeRecipient } = deps;
  const [global, feeConfig, quoteControl, { blockhash }] = await Promise.all([
    pump.fetchGlobal(),
    pump.fetchFeeConfig().catch(() => null),
    pump.fetchQuoteControl().catch(() => null),
    connection.getLatestBlockhash('confirmed'),
  ]);
  const mint = Keypair.generate(); // memory only, dropped at the end
  const plan = await buildLaunch(
    {
      wallet,
      mint: mint.publicKey,
      coin: { name: 'PetalDeck check', symbol: 'CHECK', uri: DRY_RUN_METADATA_URI },
      quote: null,
      devBuy: new BN(10_000_000), // 0.01 SOL
      mayhemMode: false,
      creatorFeeBps: null,
      holderReward: false,
    },
    { global, feeConfig, quoteControl, quoteTransferFee: null, recentBlockhash: blockhash, appFeeRecipient: feeRecipient },
  );
  const probes = probesFrom(plan.txs);
  const results: ProbeResult[] = [];
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const tx = new Transaction({ feePayer: wallet, recentBlockhash: blockhash }).add(...p.ixs);
    if (tx.compileMessage().accountKeys.some((k, j) => j < tx.compileMessage().header.numRequiredSignatures && k.equals(mint.publicKey))) {
      tx.partialSign(mint);
    }
    let r: ProbeResult;
    try {
      const signed = await signer.signTransaction(tx, { label: `Safety check ${i + 1}/${probes.length}: tap Cancel. Not sent.` });
      signed.fill(0); // never sent
      r = { name: p.name, verdict: 'passed', detail: 'signed (discarded)' };
    } catch (err) {
      const be = getBridgeError(err);
      if (be?.code === 'USER_REJECTED') r = { name: p.name, verdict: 'passed', detail: 'approve screen shown' };
      else if (be) {
        const data = Object.keys(be.data).length ? ` ${JSON.stringify(be.data)}` : '';
        r = { name: p.name, verdict: 'REFUSED', detail: `${be.code}${be.policyCode ? '/' + be.policyCode : ''}: ${be.message}${data}`.slice(0, 240) };
      } else r = { name: p.name, verdict: 'error', detail: (err as Error)?.name ?? 'error' };
    }
    results.push(r);
    onResult(r, i, probes.length);
  }
  return results;
}
