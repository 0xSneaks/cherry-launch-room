// A–H on a mainnet fork, chained vs unchained. SERVER ONLY. Builds, then runs in the
// in-process VM (src/sim/fork.ts). Nothing is signed for real and nothing is sent.
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { serializedSize } from '../launch/engine.js';
import { TX_BYTE_LIMIT } from '../spike/constants.js';
import { ALL_VARIANTS, USDC, buildAnyVariant, isEngine, type AnyVariant } from '../spike/variants.js';
import { VARIANTS } from '../spike/build.js';
import { simulateChain, type RawAccount, type RpcRead, type TxResult } from './fork.js';

export interface SuiteRow {
  variant: AnyVariant;
  steps: string[];
  bytes: number[];
  /** Each tx alone against current chain (what plain RPC simulate does). */
  unchained: TxResult[] | null;
  /** In order, each tx on the state the previous one left. */
  chained: TxResult[] | null;
  skipped?: string;
  error?: string;
}

const SOL = 1_000_000_000;

/** A system-owned wallet holding `lamports`. */
export function fundedWallet(lamports = 5 * SOL): RawAccount {
  return { lamports, owner: SystemProgram.programId.toBase58(), data: new Uint8Array(0), executable: false };
}

/** An initialized SPL-Token account (owner `wallet`) holding `amount` of `mint`. */
export function splTokenAccount(mint: PublicKey, wallet: PublicKey, amount: bigint): RawAccount {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: wallet,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID.toBase58(), data: Uint8Array.from(data), executable: false };
}

export interface SuiteOptions {
  rpcUrl: string;
  read: RpcRead;
  variants?: AnyVariant[];
  /** H pair; default = first QuoteControl mint Pump lists. */
  pairMint?: PublicKey;
}

export async function runSuite(opts: SuiteOptions): Promise<SuiteRow[]> {
  const connection = new Connection(opts.rpcUrl, 'confirmed');
  const pump = new OnlinePumpSdk(connection);
  // Synthetic signer + recipient: fresh keys, never real funds. Only public keys are used.
  const wallet = Keypair.generate().publicKey;
  const appFeeRecipient = Keypair.generate().publicKey;
  const usdcAta = getAssociatedTokenAddressSync(USDC, wallet, true, TOKEN_PROGRAM_ID);
  const overrides = [
    { pubkey: wallet, account: fundedWallet() },
    { pubkey: usdcAta, account: splTokenAccount(USDC, wallet, 50_000_000n) }, // 50 USDC for F
  ];
  let pairMint = opts.pairMint;
  if (!pairMint) {
    const pairs = await pump.fetchSupportedQuoteMints().catch(() => []);
    pairMint = pairs.find((p) => p.source === 'quoteControl')?.mint;
  }
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const rows: SuiteRow[] = [];
  for (const variant of opts.variants ?? ALL_VARIANTS) {
    const mint = Keypair.generate().publicKey;
    const row: SuiteRow = { variant, steps: [], bytes: [], unchained: null, chained: null };
    try {
      const built = await buildAnyVariant(variant, { pump, wallet, mint, appFeeRecipient, recentBlockhash: blockhash, pairMint });
      row.steps = built.steps;
      row.bytes = built.txs.map(serializedSize);
      const measureOnly = !isEngine(variant) && !VARIANTS[variant].signable;
      if (measureOnly || row.bytes.some((b) => b > TX_BYTE_LIMIT)) {
        row.skipped = `over ${TX_BYTE_LIMIT} B: measure only`;
      } else {
        row.unchained = await simulateChain(opts.read, built.txs, { overrides, chained: false });
        row.chained = await simulateChain(opts.read, built.txs, { overrides, chained: true });
      }
    } catch (e) {
      row.error = (e as Error).message.slice(0, 300);
    }
    rows.push(row);
  }
  return rows;
}

const cell = (r: TxResult[] | null) => (r ? r.map((t) => (t.ok ? `ok ${t.cu}CU` : t.err)).join(' ; ') : '—');

export function suiteMarkdown(rows: SuiteRow[]): string {
  const head = '| Variant | txs | bytes | each tx alone (RPC-style) | chained (tx1 → tx2 …) |\n|---|---|---|---|---|';
  const body = rows.map(
    (r) =>
      `| ${r.variant} | ${r.steps.join(' → ') || '—'} | ${r.bytes.join(' + ') || '—'} | ${r.error ? 'BUILD ERROR: ' + r.error : r.skipped ?? cell(r.unchained)} | ${r.error || r.skipped ? '—' : cell(r.chained)} |`,
  );
  return [head, ...body].join('\n');
}
