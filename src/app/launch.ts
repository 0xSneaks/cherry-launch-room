// The ONE function the form calls: buildLaunch(formData) → a prepared launch the confirm sheet shows
// and signs. Wraps the unchanged launch engine (src/launch/engine.ts). Dry-run only: Cherry signs,
// the signed bytes are dropped, nothing is sent.
import type { OnlinePumpSdk, ResolvedQuoteMint } from '@pump-fun/pump-sdk';
import { Keypair, PublicKey, Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';
import { buildLaunch as buildLaunchTxs, type LaunchRequest } from '../launch/engine';
import { explainLaunchError } from '../launch/errors';
import { DRY_RUN_LABEL, DRY_RUN_METADATA_URI, FEE_SPLIT_SHORT, LAUNCH_MODE, ROUTES, USDC_MINT, type HarnessVariant } from './config';
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

export interface PreparedLaunch {
  summary: LaunchSummary;
  sign(): Promise<SignResult>;
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

  async function buildLaunch(form: LaunchForm): Promise<PreparedLaunch> {
    // Never launch with the fee wallet as signer: the 95/5 split would name the same wallet twice.
    if (feeRecipient.equals(wallet)) throw new FeeWalletIsSignerError();

    const [global, feeConfig, quoteControl, { blockhash }] = await Promise.all([
      pump.fetchGlobal(),
      pump.fetchFeeConfig().catch(() => null),
      pump.fetchQuoteControl().catch(() => null),
      connection.getLatestBlockhash('confirmed'),
    ]);
    const limits: PumpLimits = { mayhemEnabled: global.mayhemModeEnabled };

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
      coin: { name: form.name.trim(), symbol: form.ticker, uri: DRY_RUN_METADATA_URI },
      quote,
      devBuy,
      mayhemMode: form.mayhem,
      creatorFeeBps: null, // H without a custom fee: this form has no creator-fee field
      holderReward: false, // 'Holders' is shown as Soon: no harness variant covers it with the 95/5 split
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
      feeSplit: FEE_SPLIT_SHORT,
      steps: plan.steps,
      approvals: 1,
      dryRun: LAUNCH_MODE === 'dry-run',
      variants: routeFor(form),
    };

    async function sign(): Promise<SignResult> {
      if (!mint) throw new Error('This launch was already signed. Start again.');
      if (LAUNCH_MODE !== 'dry-run') throw new Error('Only dry-run is enabled.');
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

    return { summary, sign };
  }

  return { buildLaunch };
}
