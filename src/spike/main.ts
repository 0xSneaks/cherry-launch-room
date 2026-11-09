// SIGN-ONLY SPIKE. Asks Cherry's wallet to sign Pump.fun launch transactions and throws the
// signed bytes away. Nothing here can broadcast: no send call exists, and /api/rpc refuses
// every send method server-side.
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { CherryMiniApp, isInsideCherry } from '@cherrydotfun/miniapp-sdk';
import { OnlinePumpSdk, type FeeConfig, type Global } from '@pump-fun/pump-sdk';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { VARIANTS, buildVariant, fitsLegacy, serializedSize, type Variant } from './build';
import { SPIKE_COIN } from './coin';
import { APP_FEE_WALLET, SPIKE_LABEL } from './constants';
import { isKill, refusalFields, toMarkdown, type SpikeRow } from './result';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (msg: string) => {
  const li = document.createElement('li');
  li.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  $('log').prepend(li);
};

const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed');
const pump = new OnlinePumpSdk(connection);
const rows: SpikeRow[] = [];
let cherry: CherryMiniApp | null = null;
let pumpState: { global: Global; feeConfig: FeeConfig | null } | null = null;

function signerWallet(): PublicKey | null {
  const key = cherry?.paymentWallet ?? cherry?.wallet.publicKey ?? null;
  return key ? new PublicKey(key) : null;
}

async function simulate(tx: Transaction): Promise<string> {
  try {
    const vtx = new VersionedTransaction(tx.compileMessage());
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) return `ok ${sim.value.unitsConsumed ?? '?'}CU`;
    const last = (sim.value.logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1)[0] ?? '';
    return `err ${JSON.stringify(sim.value.err)} ${last}`.slice(0, 160);
  } catch (e) {
    return `sim unavailable: ${(e as Error).message}`.slice(0, 120);
  }
}

function render() {
  $('table').textContent = rows.length ? toMarkdown(rows) : 'No runs yet.';
  const kill = rows.find(isKill);
  $('verdict').textContent = kill
    ? `KILL: variant A refused (${kill.code}${kill.policyCode ? ' / ' + kill.policyCode : ''}). Tell Sneaks.`
    : rows.some((r) => r.variant === 'A' && r.result === 'SIGNED')
      ? 'Variant A signed: Cherry will sign a Pump.fun create_v2. GO on A.'
      : '';
}

async function run(variant: Variant) {
  const wallet = signerWallet();
  if (!cherry || !wallet) return log('No Cherry wallet. Open this page inside Cherry.');
  const spec = VARIANTS[variant];
  document.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  let mint: Keypair | null = Keypair.generate(); // memory only, dropped after the run
  const row: SpikeRow = { variant, result: 'ERROR', bytes: [], at: new Date().toISOString() };
  try {
    const appFeeRecipient = new PublicKey(($('feeRecipient') as HTMLInputElement).value.trim() || APP_FEE_WALLET);
    if (appFeeRecipient.equals(wallet)) throw new Error('5% recipient equals your wallet: paste another address you control.');
    if (spec.txs.some((t) => t.buy) && !pumpState) {
      const [global, feeConfig] = await Promise.all([pump.fetchGlobal(), pump.fetchFeeConfig().catch(() => null)]);
      pumpState = { global, feeConfig };
    }
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const txs = await buildVariant(variant, {
      wallet,
      mint: mint.publicKey,
      recentBlockhash: blockhash,
      coin: SPIKE_COIN,
      global: pumpState?.global,
      feeConfig: pumpState?.feeConfig,
      appFeeRecipient,
    });
    row.bytes = txs.map(serializedSize);
    if (!spec.signable || !txs.every(fitsLegacy)) {
      row.result = 'SKIPPED';
      row.reason = 'over 1232 B: measured only';
      return;
    }
    row.sim = await Promise.all(txs.map(simulate));
    log(`${variant}: asking Cherry to sign ${txs.length} tx (${row.bytes.join(' + ')} B). Nothing will be sent.`);

    const signed: Uint8Array[] =
      txs.length === 1
        ? [(await cherry.wallet.signTransaction(txs[0], { label: SPIKE_LABEL })) as Uint8Array]
        : await cherry.wallet.signAllTransactions(txs, { label: SPIKE_LABEL });

    row.result = 'SIGNED';
    row.returnedBytes = signed.map((b) => b.length);
    // Prove the order works: wallet signed first, mint co-signs after, every signature verifies.
    const first = Transaction.from(signed[0]);
    if (VARIANTS[variant].txs[0].create) first.partialSign(mint);
    row.mintCosignOk = first.verifySignatures(true);
    signed.fill(new Uint8Array(0)); // drop the signed bytes
  } catch (err) {
    Object.assign(row, refusalFields(err));
  } finally {
    mint = null;
    rows.push(row);
    log(`${variant}: ${row.result}${row.code ? ' ' + row.code : ''}${row.policyCode ? ' / ' + row.policyCode : ''}${row.reason ? ' — ' + row.reason : ''}`);
    render();
    document.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

// Verified identity from our backend. Memory only (no cookies inside Cherry's frame).
let session: { userKey: string; wallet: string; tier: string | null } | null = null;

/** Exchange the 5-minute launch token ONCE for a server-verified identity. */
async function exchangeLaunchToken(token: string) {
  if (!token || session) return;
  try {
    const res = await fetch('/api/auth/cherry', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return log(`Server refused the launch token (${res.status}).`);
    session = await res.json();
    log(`Server verified you (tier ${session?.tier ?? '?'}).`);
  } catch {
    log('Could not reach the server to verify the launch token.');
  }
}

async function boot() {
  const inCherry = isInsideCherry();
  $('env').textContent = inCherry ? 'Inside Cherry' : 'Not inside Cherry — open from the Cherry app to sign.';
  for (const v of Object.keys(VARIANTS) as Variant[]) {
    const b = document.createElement('button');
    b.textContent = `${v} · ${VARIANTS[v].title}`;
    b.onclick = () => void run(v);
    $('variants').append(b);
  }
  $('copy').onclick = () => void navigator.clipboard?.writeText(toMarkdown(rows)).then(() => log('Table copied.'));
  ($('feeRecipient') as HTMLInputElement).value = APP_FEE_WALLET;
  render();
  if (!inCherry) return;
  try {
    cherry = new CherryMiniApp({ initTimeout: 8000 });
    await cherry.init();
    const w = signerWallet()?.toBase58() ?? 'none';
    $('who').textContent = `Wallet ${w.slice(0, 4)}…${w.slice(-4)} · tier ${cherry.tier ?? '?'} · ${cherry.hasPermission('wallet:sign') ? 'wallet:sign ✓' : 'wallet:sign MISSING'}`;
    void exchangeLaunchToken(cherry.launchToken);
  } catch (e) {
    $('who').textContent = `Cherry handshake failed: ${(e as Error).message}`;
  }
}

void boot();
