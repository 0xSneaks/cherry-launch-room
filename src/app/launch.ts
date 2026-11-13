// The ONE function the form calls: buildLaunch(formData, metadataUri) → a prepared launch the confirm
// sheet shows and signs. Wraps the launch engine (src/launch/engine.ts). Live mode: one Cherry approval,
// the app co-signs the mint, then /api/send relays each tx IN ORDER, waiting for on-chain confirmation
// before the next (tx 2 needs tx 1's coin). Dry-run mode: signed bytes are dropped, nothing is sent.
import type { OnlinePumpSdk, ResolvedQuoteMint } from '@pump-fun/pump-sdk';
import { Keypair, PublicKey, Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';
import { buildLaunch as buildLaunchTxs, type LaunchRequest } from '../launch/engine';
import { explainLaunchError } from '../launch/errors';
import { DRY_RUN_LABEL, FEE_SPLIT_SHORT, HOLDERS_SHORT, LAUNCH_MODE, ROUTES, USDC_MINT, launchLabel, type HarnessVariant } from './config';
import { buyError, hasErrors, parseAmount, unitOf, validateForm, type FieldErrors, type LaunchForm, type PumpLimits } from './form';

/** The slice of the Cherry SDK we use (CherryMiniApp.wallet). */
export interface CherrySigner {
  signTransaction(tx: Transaction, opts: { label: string }): Promise<Uint8Array>;
  signAllTransactions(txs: Transaction[], opts: { label: string }): Promise<Uint8Array[]>;
}

export interface LauncherDeps {
  connection: Connection;
  pump: OnlinePumpSdk;
  signer: CherrySigner;
  /** Server-verified Cherry wallet: creator, fee payer, only wallet signer. */
  wallet: PublicKey;
  /** PetalDeck's 5% recipient, from server config (/api/config). */
  feeRecipient: PublicKey;
}

export interface LaunchSummary {
  name: string;
  ticker: string;
  pair: string;
  initialBuy: string;
  /** Lamports the wallet spends on create (+ SOL buy) + network fees. null = could not simulate. */
  costLamports: number | null;
  costNote: string | null;
  feeSplit: string;
  steps: string[];
  approvals: 1;
  dryRun: boolean;
  /** Harness variants this launch's shape matches (see ROUTES). */
  variants: readonly HarnessVariant[];
}

export interface SignResult {
  signedTxs: number;
  /** Mint co-signed after Cherry and every signature verified. */
  verified: boolean;
}

/** Where a live launch got to. `landed` txs are confirmed on-chain, in order. */
export interface LaunchOutcome {
  mint: string;
  steps: string[];
  signatures: string[];
  landed: number;
  total: number;
  /** Plain sentence when a tx after the create failed (the coin exists; retry() finishes the rest). */
  error?: string;
}

export type Progress = (text: string) => void;

export interface PreparedLaunch {
  summary: LaunchSummary;
  /** Dry-run: sign and drop. */
  sign(): Promise<SignResult>;
  /** Live: sign once in Cherry, send + confirm every tx in order. Throws if the create itself fails. */
  launch(progress: Progress): Promise<LaunchOutcome>;
  /** Live: re-sign and send the txs that didn't land (after a partial launch). */
  retry(progress: Progress): Promise<LaunchOutcome>;
}

export class LaunchSendError extends Error {
  constructor(message: string, public readonly detail: unknown = null) {
    super(message);
    this.name = 'LaunchSendError';
  }
}

/** POST one fully signed tx to /api/send. Returns its signature. */
export async function sendSigned(tx: Transaction, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl('/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: tx.serialize().toString('base64') }),
  });
  const body = (await res.json().catch(() => ({}))) as { signature?: string; message?: string; data?: unknown; error?: string };
  if (!res.ok || !body.signature) throw new LaunchSendError(body.message ?? body.error ?? `send failed (${res.status})`, body.data ?? null);
  return body.signature;
}

/** Poll until `confirmed`, an on-chain error, or the timeout. */
export async function confirmSignature(conn: Connection, signature: string, timeoutMs = 75_000, everyMs = 1200): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw new LaunchSendError('Transaction failed on-chain', st.err);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new LaunchSendError('Not confirmed in time. Check Solscan before trying again.');
}

export class FormInvalidError extends Error {
  constructor(public readonly fields: FieldErrors) {
    super('Fix the highlighted fields.');
    this.name = 'FormInvalidError';
  }
}

export class FeeWalletIsSignerError extends Error {
  constructor() {
    super("You're signed in with PetalDeck's fee wallet, which can't pay itself the 5%. In Cherry, switch the wallet this app pays with, then try again.");
    this.name = 'FeeWalletIsSignerError';
  }
}

/** Harness variants a form maps to. Mayhem wins (G), then the pair. */
export function routeFor(form: Pick<LaunchForm, 'pair' | 'mayhem'>): readonly HarnessVariant[] {
  if (form.mayhem) return ROUTES.MAYHEM;
  return ROUTES[form.pair];
}

export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

const FEE_PER_SIGNATURE = 5000;

function pairLabel(form: LaunchForm): string {
  return form.pair === 'CUSTOM' ? `Custom (${shortKey(form.customMint.trim())})` : form.pair;
}

/** Wallet lamports spent by the first tx (create, + SOL buy), from simulation; later txs add network fees. */
async function estimateCost(conn: Connection, wallet: PublicKey, txs: Transaction[]): Promise<{ lamports: number | null; note: string | null }> {
  try {
    const pre = await conn.getBalance(wallet, 'confirmed');
    const sim = await conn.simulateTransaction(new VersionedTransaction(txs[0].compileMessage()), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [wallet.toBase58()] },
    });
    if (sim.value.err) {
      const detail = `${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).join(' ')}`;
      return { lamports: null, note: explainLaunchError(new Error(detail)) };
    }
    const post = sim.value.accounts?.[0]?.lamports;
    if (typeof post !== 'number') return { lamports: null, note: 'Cost estimate unavailable right now.' };
    const laterFees = txs.slice(1).reduce((sum, tx) => sum + tx.compileMessage().header.numRequiredSignatures * FEE_PER_SIGNATURE, 0);
    return { lamports: pre - post + laterFees, note: txs.length > 1 ? 'Plus a small one-time fee-split account rent.' : null };
  } catch {
    return { lamports: null, note: 'Cost estimate unavailable right now.' };
  }
}

export function createLauncher(deps: LauncherDeps) {
  const { connection, pump, signer, wallet, feeRecipient } = deps;

  async function buildLaunch(form: LaunchForm, metadataUri: string): Promise<PreparedLaunch> {
    // Never launch with the fee wallet as signer: the 95/5 split would name the same wallet twice.
    if (feeRecipient.equals(wallet)) throw new FeeWalletIsSignerError();

    const [global, feeConfig, quoteControl, { blockhash }] = await Promise.all([
      pump.fetchGlobal(),
      pump.fetchFeeConfig().catch(() => null),
      pump.fetchQuoteControl().catch(() => null),
      connection.getLatestBlockhash('confirmed'),
    ]);
    const limits: PumpLimits = { mayhemEnabled: global.mayhemModeEnabled, holdersEnabled: global.isHolderRewardEnabled };

    let quote: ResolvedQuoteMint | null = null;
    if (form.pair === 'USDC') quote = await pump.resolveQuoteMint(new PublicKey(USDC_MINT));
    if (form.pair === 'CUSTOM') quote = await pump.resolveQuoteMint(new PublicKey(form.customMint.trim()));
    const decimals = quote?.decimals ?? 9;

    const errs = validateForm(form, limits);
    const buyErr = buyError(form.initialBuy, decimals);
    if (buyErr) errs.initialBuy = buyErr;
    if (hasErrors(errs)) throw new FormInvalidError(errs);

    const devBuy = form.initialBuy.trim() ? parseAmount(form.initialBuy, decimals) : null;
    let mint: Keypair | null = Keypair.generate(); // memory only, dropped after signing

    const req: LaunchRequest = {
      wallet,
      mint: mint.publicKey,
      coin: { name: form.name.trim(), symbol: form.ticker, uri: metadataUri },
      quote,
      devBuy,
      mayhemMode: form.mayhem,
      creatorFeeBps: null, // H without a custom fee: this form has no creator-fee field
      holderReward: form.rewards === 'holders', // creator fees go to holders: no 95/5 split tx
    };
    const quoteTransferFee = quote && quote.source !== 'sol' ? await pump.fetchQuoteTransferFee(quote.mint).catch(() => null) : null;
    const plan = await buildLaunchTxs(req, { global, feeConfig, quoteControl, quoteTransferFee, recentBlockhash: blockhash, appFeeRecipient: feeRecipient });
    const cost = await estimateCost(connection, wallet, plan.txs);

    const summary: LaunchSummary = {
      name: req.coin.name,
      ticker: req.coin.symbol,
      pair: pairLabel(form),
      initialBuy: devBuy ? `${form.initialBuy.trim()} ${unitOf(form.pair)}` : 'None',
      costLamports: cost.lamports,
      costNote: cost.note,
      feeSplit: form.rewards === 'holders' ? HOLDERS_SHORT : FEE_SPLIT_SHORT,
      steps: plan.steps,
      approvals: 1,
      dryRun: LAUNCH_MODE === 'dry-run',
      variants: routeFor(form),
    };

    async function sign(): Promise<SignResult> {
      if (!mint) throw new Error('This launch was already signed. Start again.');
      if (LAUNCH_MODE !== 'dry-run') throw new Error('Dry-run is off.');
      try {
        const signed =
          plan.txs.length === 1
            ? [await signer.signTransaction(plan.txs[0], { label: DRY_RUN_LABEL })]
            : await signer.signAllTransactions(plan.txs, { label: DRY_RUN_LABEL });
        // Wallet signed first; the mint co-signs the create after. Check every signature, then drop the bytes.
        const first = Transaction.from(signed[0]);
        first.partialSign(mint);
        const verified = first.verifySignatures(true);
        signed.forEach((b) => b.fill(0));
        return { signedTxs: signed.length, verified };
      } finally {
        mint = null;
      }
    }

    const label = launchLabel(req.coin.symbol, devBuy ? `${form.initialBuy.trim()} ${unitOf(form.pair)}` : null);
    const mintKey = mint.publicKey.toBase58();
    const signatures: string[] = [];
    let landed = 0;

    /** Sign txs[from..] in one Cherry approval (fresh blockhash), then send + confirm each in order. */
    async function run(from: number, progress: Progress): Promise<LaunchOutcome> {
      const rest = plan.txs.slice(from);
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      rest.forEach((tx) => (tx.recentBlockhash = blockhash));
      progress('Waiting for Cherry…');
      const signedBytes = rest.length === 1 ? [await signer.signTransaction(rest[0], { label })] : await signer.signAllTransactions(rest, { label });
      const signed = signedBytes.map((b) => Transaction.from(b));
      if (from === 0) {
        if (!mint) throw new Error('This launch was already used. Start again.');
        signed[0].partialSign(mint); // the new coin's mint co-signs the create, after Cherry
        mint = null; // memory only, never reused
      }
      for (let i = 0; i < signed.length; i++) {
        const n = from + i + 1;
        progress(n === 1 ? 'Creating your coin…' : `Finishing (${n}/${plan.txs.length})…`);
        try {
          const sig = await sendSigned(signed[i]);
          signatures[from + i] = sig;
          await confirmSignature(connection, sig);
          landed = from + i + 1;
        } catch (err) {
          if (landed === 0) throw err; // the coin wasn't created: nothing to finish
          return { mint: mintKey, steps: plan.steps, signatures: signatures.slice(), landed, total: plan.txs.length, error: explainLaunchError(err) };
        }
      }
      return { mint: mintKey, steps: plan.steps, signatures: signatures.slice(), landed, total: plan.txs.length };
    }

    const launch = (progress: Progress) => {
      if (LAUNCH_MODE !== 'live') throw new Error('Live launches are off.');
      return run(0, progress);
    };
    const retry = (progress: Progress) => {
      if (landed === 0 || landed >= plan.txs.length) throw new Error('Nothing to retry.');
      return run(landed, progress);
    };

    return { summary, sign, launch, retry };
  }

  return { buildLaunch };
}
