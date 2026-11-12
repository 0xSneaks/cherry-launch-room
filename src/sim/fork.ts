// Chained simulation on a local in-memory fork of mainnet (LiteSVM). SERVER ONLY.
//
// Why: a launch is several transactions (create → fee share). The public RPC
// simulateTransaction runs each one against TODAY's chain, where the mint and bonding curve
// from tx 1 don't exist yet, so tx 2 can only fail (Anchor 3012 AccountNotInitialized,
// ATA IncorrectProgramId). Here tx 1 runs first and tx 2 sees its state.
//
// Safety: this never talks to a validator for writes. The only network calls are the READ
// methods in READ_METHODS (account data, slot, time). "Executing" a tx means running it in
// the in-process VM; nothing leaves this process.
// Default import: litesvm is CommonJS; named ESM imports of CJS are fragile on Vercel's Node runtime.
import litesvm from 'litesvm';
import { address, type Transaction as KitTransaction, type SignatureBytes, type TransactionMessageBytes } from '@solana/kit';
import { PublicKey, type Transaction } from '@solana/web3.js';

const { LiteSVM, Clock, FailedTransactionMetadata } = litesvm;

export const READ_METHODS = new Set(['getMultipleAccounts', 'getSlot', 'getBlockTime', 'getEpochInfo']);

export type RpcRead = (method: string, params: unknown[]) => Promise<unknown>;

/** JSON-RPC reader that refuses anything but READ_METHODS. */
export function rpcReader(url: string, fetchImpl: typeof fetch = fetch): RpcRead {
  return async (method, params) => {
    if (!READ_METHODS.has(method)) throw new Error(`fork sim: method not allowed: ${method}`);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? 'error'}`);
    return body.result;
  };
}

export interface RawAccount {
  lamports: number;
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const PROGRAMDATA_HEADER = 45; // enum u32 + slot u64 + Option<Pubkey>

const isSysvar = (key: string) => key.startsWith('Sysvar');

/** Programs' ELF bytes, cached per warm server instance (they rarely change). */
const elfCache = new Map<string, Uint8Array>();

export interface TxResult {
  ok: boolean;
  /** Compute units consumed. */
  cu: number;
  /** Error as text (e.g. `InstructionError(1, Custom(3012))`), when not ok. */
  err?: string;
  /** Last log lines (errors first). */
  logs: string[];
}

export interface ForkOptions {
  /** Accounts to force before running (funded wallet, token balances). Applied after loading. */
  overrides?: { pubkey: PublicKey; account: RawAccount }[];
}

async function fetchAccounts(read: RpcRead, keys: string[]): Promise<Map<string, RawAccount | null>> {
  const out = new Map<string, RawAccount | null>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const result = (await read('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }])) as {
      value: ({ lamports: number; owner: string; data: [string, string]; executable: boolean } | null)[];
    };
    result.value.forEach((a, j) => {
      out.set(
        chunk[j],
        a ? { lamports: a.lamports, owner: a.owner, data: Uint8Array.from(Buffer.from(a.data[0], 'base64')), executable: a.executable } : null,
      );
    });
  }
  return out;
}

/** web3.js legacy tx → kit wire shape (empty signature slots; sigverify is off). */
export function toKitTransaction(tx: Transaction): KitTransaction {
  const messageBytes = tx.serializeMessage();
  const msg = tx.compileMessage();
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
  const signatures: Record<string, SignatureBytes | null> = {};
  for (const s of signers) signatures[s.toBase58()] = null;
  return { messageBytes: messageBytes as unknown as TransactionMessageBytes, signatures } as unknown as KitTransaction;
}

function errText(err: unknown): string {
  // FailedTransactionMetadata.err() returns a napi object; toString is the most stable form.
  try {
    const s = String((err as { toString(): string }).toString());
    if (s && s !== '[object Object]') return s;
  } catch {
    /* fall through */
  }
  return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function tailLogs(logs: string[]): string[] {
  const errs = logs.filter((l) => /error|failed|Error Code|custom program error/i.test(l));
  return [...errs.slice(-4), ...logs.slice(-3)].filter((l, i, a) => a.indexOf(l) === i).map((l) => l.slice(0, 220));
}

/**
 * A fork that lazily copies every account a transaction names from mainnet, then runs the
 * transactions IN ORDER so each one sees the state the previous ones left.
 */
export class ChainFork {
  private svm: InstanceType<typeof LiteSVM>;
  private loaded = new Set<string>();

  constructor(private read: RpcRead) {
    this.svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false);
  }

  /** Clock from mainnet so time-gated program logic behaves as it would now. */
  async syncClock(): Promise<void> {
    const slot = (await this.read('getSlot', [{ commitment: 'confirmed' }])) as number;
    const time = ((await this.read('getBlockTime', [slot]).catch(() => null)) as number | null) ?? Math.floor(Date.now() / 1000);
    const epoch = ((await this.read('getEpochInfo', [{ commitment: 'confirmed' }])) as { epoch: number }).epoch;
    this.svm.setClock(new Clock(BigInt(slot), BigInt(time), BigInt(epoch), BigInt(epoch + 1), BigInt(time)));
  }

  private setRaw(key: string, a: RawAccount) {
    this.svm.setAccount({
      address: address(key),
      lamports: BigInt(a.lamports) as never,
      data: a.data,
      programAddress: address(a.owner),
      executable: a.executable,
      space: BigInt(a.data.length),
      exists: true,
    } as never);
  }

  /** Copy every account a tx names (programs as ELF) unless already loaded. */
  async load(keys: string[]): Promise<void> {
    const todo = keys.filter((k) => !this.loaded.has(k) && !isSysvar(k));
    if (!todo.length) return;
    const accounts = await fetchAccounts(this.read, todo);
    const programDataFor = new Map<string, string>();
    for (const [key, a] of accounts) {
      this.loaded.add(key);
      if (!a) continue; // does not exist yet: the chain creates it
      if (a.executable) {
        if (a.owner === NATIVE_LOADER) continue; // builtin (System, ComputeBudget…)
        if (a.owner === UPGRADEABLE_LOADER) {
          programDataFor.set(key, new PublicKey(a.data.slice(4, 36)).toBase58());
        } else if (!elfCache.has(key)) {
          elfCache.set(key, a.data); // BPFLoader2: the account data IS the ELF
        }
        continue;
      }
      this.setRaw(key, a);
    }
    const needData = [...programDataFor].filter(([pid]) => !elfCache.has(pid));
    if (needData.length) {
      const pd = await fetchAccounts(this.read, needData.map(([, d]) => d));
      for (const [pid, dataKey] of needData) {
        const d = pd.get(dataKey);
        if (d) elfCache.set(pid, d.data.slice(PROGRAMDATA_HEADER));
      }
    }
    for (const key of accounts.keys()) {
      const elf = elfCache.get(key);
      if (elf) this.svm.addProgram(address(key), elf);
    }
  }

  apply(overrides: ForkOptions['overrides'] = []) {
    for (const { pubkey, account } of overrides) {
      this.loaded.add(pubkey.toBase58());
      this.setRaw(pubkey.toBase58(), account);
    }
  }

  /** Run one tx on the fork; state carries to the next call only if it succeeded. */
  async run(tx: Transaction): Promise<TxResult> {
    await this.load(tx.compileMessage().accountKeys.map((k) => k.toBase58()));
    // In-process VM only (see header): nothing is sent to any network.
    const res = this.svm.sendTransaction(toKitTransaction(tx));
    if (res instanceof FailedTransactionMetadata) {
      const meta = res.meta();
      return { ok: false, cu: Number(meta.computeUnitsConsumed()), err: errText(res.err()), logs: tailLogs(meta.logs()) };
    }
    return { ok: true, cu: Number(res.computeUnitsConsumed()), logs: tailLogs(res.logs()).slice(-2) };
  }
}

/**
 * Simulate `txs` in order on one fork. `chained: false` runs each on a FRESH fork instead
 * (what plain RPC simulation does), for comparison.
 */
export async function simulateChain(
  read: RpcRead,
  txs: Transaction[],
  opts: ForkOptions & { chained?: boolean } = {},
): Promise<TxResult[]> {
  const chained = opts.chained ?? true;
  const results: TxResult[] = [];
  let fork: ChainFork | null = null;
  for (const tx of txs) {
    if (!fork || !chained) {
      fork = new ChainFork(read);
      await fork.syncClock();
      await fork.load(tx.compileMessage().accountKeys.map((k) => k.toBase58()));
      fork.apply(opts.overrides);
    }
    results.push(await fork.run(tx));
    if (chained && !results[results.length - 1].ok) {
      // Later txs depend on this one: report them as not run.
      for (let i = results.length; i < txs.length; i++) results.push({ ok: false, cu: 0, err: 'NOT_RUN (previous tx failed)', logs: [] });
      break;
    }
  }
  return results;
}
