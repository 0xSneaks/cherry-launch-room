// SIGN-ONLY SPIKE. Asks Cherry's wallet to sign Pump.fun launch transactions and throws the
// signed bytes away. Nothing here can broadcast: no send call exists, and /api/rpc refuses
// every send method server-side.
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { CherryMiniApp, isInsideCherry } from '@cherrydotfun/miniapp-sdk';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { explainLaunchError } from '../launch/errors';
import { recipientIsSigner } from '../launch/guard';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { VARIANTS, fitsLegacy, serializedSize, type Variant } from './build';
import { APP_FEE_WALLET, SPIKE_LABEL, SPIKE_OWNER_WALLETS, SPIKE_TEST_RECIPIENT } from './constants';
import { isKill, refusalFields, toMarkdown, type SpikeRow } from './result';
import { isOwner, sessionFromResponse, short, type SessionState } from './session';
import { ENGINE_VARIANTS, USDC, buildAnyVariant, hasFeeShare, isEngine, type EngineVariant } from './variants';

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

function signerWallet(): PublicKey | null {
  const key = cherry?.paymentWallet ?? cherry?.wallet.publicKey ?? null;
  return key ? new PublicKey(key) : null;
}

/** Plain RPC simulation of ONE tx against today's chain (fallback only). */
async function simulateAlone(tx: Transaction): Promise<string> {
  try {
    const vtx = new VersionedTransaction(tx.compileMessage());
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) return `ok ${sim.value.unitsConsumed ?? '?'}CU (alone)`;
    const last = (sim.value.logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1)[0] ?? '';
    return `err ${JSON.stringify(sim.value.err)} ${last} (alone)`.slice(0, 160);
  } catch (e) {
    return `sim unavailable: ${(e as Error).message}`.slice(0, 120);
  }
}

/**
 * Chained simulation (server fork, /api/sim): tx 2 runs on the state tx 1 left, the way the
 * launch really lands. Plain per-tx RPC simulation fails every later tx (3012 / IncorrectProgramId)
 * because the coin doesn't exist yet. Falls back to per-tx RPC sim if the server is down.
 */
async function simulate(txs: Transaction[]): Promise<string[]> {
  try {
    // fundPayer: Preview only (server ignores it on Production). Tests program logic, not your balance.
    const body = {
      txs: txs.map((t) => t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')),
      fundPayer: true,
    };
    const res = await fetch('/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { results } = (await res.json()) as { results: { ok: boolean; cu: number; err?: string }[] };
    return results.map((r) => (r.ok ? `ok ${r.cu}CU (chained)` : `err ${r.err} (chained)`.slice(0, 160)));
  } catch (e) {
    log(`chained sim unavailable (${(e as Error).message}); simulating each tx alone`);
    return Promise.all(txs.map(simulateAlone));
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

async function run(variant: Variant | EngineVariant) {
  const wallet = signerWallet();
  if (!cherry || !wallet) return log('No Cherry wallet. Open this page inside Cherry.');
  if (!isOwner(auth, SPIKE_OWNER_WALLETS)) return log('Not available yet.');
  const spec = isEngine(variant) ? null : VARIANTS[variant];
  document.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  let mint: Keypair | null = Keypair.generate(); // memory only, dropped after the run
  const row: SpikeRow = { variant, result: 'ERROR', bytes: [], at: new Date().toISOString() };
  try {
    // GUARD: the 5% recipient must never be the signing wallet. BLOCKED here, never swapped
    // silently at sign time (production blocks too: src/launch/guard.ts + validateLaunch).
    const appFeeRecipient = new PublicKey(($('feeRecipient') as HTMLInputElement).value.trim() || APP_FEE_WALLET);
    if (hasFeeShare(variant) && recipientIsSigner(wallet, appFeeRecipient)) {
      warnRecipient(wallet);
      row.result = 'SKIPPED';
      row.reason = 'BLOCKED: 5% recipient = signing wallet. Paste a different recipient above.';
      return;
    }
    const pairRaw = ($('pairMint') as HTMLInputElement).value.trim();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const built = await buildAnyVariant(variant, {
      pump,
      wallet,
      mint: mint.publicKey,
      appFeeRecipient,
      recentBlockhash: blockhash,
      pairMint: pairRaw ? new PublicKey(pairRaw) : undefined,
    });
    const txs = built.txs;
    log(`${variant}: ${built.steps.join(' → ')}${built.quote ? ` · pair ${built.quote.source}` : ''}`);
    row.bytes = txs.map(serializedSize);
    if ((spec && !spec.signable) || !txs.every(fitsLegacy)) {
      row.result = 'SKIPPED';
      row.reason = 'over 1232 B: measured only';
      return;
    }
    row.sim = await simulate(txs);
    log(`${variant}: asking Cherry to sign ${txs.length} tx (${row.bytes.join(' + ')} B). Nothing will be sent.`);

    const signed: Uint8Array[] =
      txs.length === 1
        ? [(await cherry.wallet.signTransaction(txs[0], { label: SPIKE_LABEL })) as Uint8Array]
        : await cherry.wallet.signAllTransactions(txs, { label: SPIKE_LABEL });

    row.result = 'SIGNED';
    row.returnedBytes = signed.map((b) => b.length);
    // Prove the order works: wallet signed first, mint co-signs after, every signature verifies.
    const first = Transaction.from(signed[0]);
    if (!spec || spec.txs[0].create) first.partialSign(mint); // tx 0 is always the create
    row.mintCosignOk = first.verifySignatures(true);
    signed.fill(new Uint8Array(0)); // drop the signed bytes
  } catch (err) {
    Object.assign(row, refusalFields(err));
    if (row.result === 'ERROR') row.reason = `${explainLaunchError(err)} (${row.reason ?? ''})`.slice(0, 200);
  } finally {
    mint = null;
    rows.push(row);
    log(`${variant}: ${row.result}${row.code ? ' ' + row.code : ''}${row.policyCode ? ' / ' + row.policyCode : ''}${row.reason ? ' — ' + row.reason : ''}`);
    render();
    setVariantButtons(isOwner(auth, SPIKE_OWNER_WALLETS));
    ($('copy') as HTMLButtonElement).disabled = false;
  }
}

/** Visible warning when the 5% recipient equals the signing wallet. */
function warnRecipient(wallet: PublicKey | null) {
  const raw = ($('feeRecipient') as HTMLInputElement).value.trim();
  let same = false;
  try {
    same = Boolean(wallet && raw && recipientIsSigner(wallet, raw));
  } catch {
    /* not an address yet */
  }
  $('recipientWarn').hidden = !same;
}

/**
 * Signed in AS the fee wallet (Ftui…): prefill the owner's second wallet BEFORE any tap, and say
 * so on screen. Nothing changes at sign time; an equal pair is blocked in run().
 */
function prefillRecipient(wallet: PublicKey | null) {
  const input = $('feeRecipient') as HTMLInputElement;
  if (wallet && recipientIsSigner(wallet, input.value.trim() || APP_FEE_WALLET) && !recipientIsSigner(wallet, SPIKE_TEST_RECIPIENT)) {
    input.value = SPIKE_TEST_RECIPIENT;
    $('recipientNote').textContent = `You're signed in with the PetalDeck fee wallet (${short(wallet.toBase58())}), so the 5% recipient is set to your second wallet ${short(SPIKE_TEST_RECIPIENT)}. Check it before you tap.`;
    $('recipientNote').hidden = false;
    log(`5% recipient prefilled with ${short(SPIKE_TEST_RECIPIENT)} (signer is the fee wallet).`);
  }
  warnRecipient(wallet);
}

/** What Pump allows right now, read from chain (Global + QuoteControl). */
async function showPumpSettings() {
  try {
    const [global, pairs] = await Promise.all([pump.fetchGlobal(), pump.fetchSupportedQuoteMints()]);
    const name = (m: PublicKey) => (m.equals(USDC) ? 'USDC' : `${m.toBase58().slice(0, 4)}…`);
    const custom = pairs.filter((p) => p.source === 'quoteControl').length;
    const listed = [
      ...pairs.filter((p) => p.source === 'sol' || p.source === 'global').map((p) => (p.source === 'sol' ? 'SOL' : name(p.mint))),
      ...(custom ? [`${custom} custom tokens`] : []),
    ].join(', ');
    const qc = pairs.find((p) => p.source === 'quoteControl');
    if (qc && !($('pairMint') as HTMLInputElement).value) ($('pairMint') as HTMLInputElement).value = qc.mint.toBase58();
    $('pump').textContent =
      `Pump now: pairs ${listed}; pump-coin pairs ${global.maxCurveDepth ? 'up to depth ' + global.maxCurveDepth : 'OFF'}; ` +
      `mayhem ${global.mayhemModeEnabled ? 'on' : 'OFF'}; custom creator fee ${global.creatorFeeConfigurable ? 'on, max ' + global.maxConfigurableCreatorFeeBps.toNumber() / 100 + '%' : 'OFF'}; ` +
      `holder rewards ${global.isHolderRewardEnabled ? 'on' : 'OFF'}; new coins ${global.createV2Enabled ? 'on' : 'PAUSED'}.`;
  } catch (e) {
    $('pump').textContent = `Could not read Pump settings: ${(e as Error).message}`.slice(0, 160);
  }
}

// Signed-in state comes ONLY from our backend verifying the launch token. Memory only.
let auth: SessionState = { kind: 'checking' };

function setVariantButtons(enabled: boolean) {
  $('variants').querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = !enabled));
}

function renderWho() {
  const sdk = cherry ? `${cherry.hasPermission('wallet:sign') ? 'wallet:sign ✓' : 'wallet:sign MISSING'}` : '';
  $('who').textContent =
    auth.kind === 'signed-in'
      ? `Signed in: ${short(auth.session.wallet)} · tier ${auth.session.tier ?? '?'} · ${sdk}`
      : auth.kind === 'checking'
        ? 'Checking your launch token with the server…'
        : `Not signed in: ${auth.reason}.`;
  const owner = isOwner(auth, SPIKE_OWNER_WALLETS);
  $('spike').hidden = !owner;
  $('soon').hidden = owner;
  setVariantButtons(owner);
}

/** Exchange the 5-minute launch token ONCE for a server-verified identity. */
async function exchangeLaunchToken(token: string) {
  const sdkWallet = signerWallet()?.toBase58() ?? null;
  if (!token) {
    auth = { kind: 'signed-out', reason: 'no launch token from Cherry' };
  } else {
    try {
      const res = await fetch('/api/auth/cherry', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      auth = sessionFromResponse(res.status, await res.json().catch(() => null), sdkWallet);
    } catch {
      auth = { kind: 'signed-out', reason: 'could not reach the server' };
    }
  }
  log(auth.kind === 'signed-in' ? 'Server verified your launch token.' : `Signed out: ${auth.kind === 'signed-out' ? auth.reason : ''}`);
  renderWho();
}

async function boot() {
  // strict: only Cherry's own markers (window.__cherry or ?cherry_embed=1). Wallet in-app browsers are
  // React Native WebViews and would otherwise look like Cherry's mobile app.
  const inCherry = isInsideCherry({ strict: true });
  $('env').textContent = inCherry ? 'Inside Cherry' : 'Not inside Cherry — open from the Cherry app to sign.';
  const titles: [Variant | EngineVariant, string][] = [
    ...(Object.keys(VARIANTS) as Variant[]).map((v) => [v, VARIANTS[v].title] as [Variant, string]),
    ...(Object.keys(ENGINE_VARIANTS) as EngineVariant[]).map((v) => [v, ENGINE_VARIANTS[v]] as [EngineVariant, string]),
  ];
  for (const [v, title] of titles) {
    const b = document.createElement('button');
    b.textContent = `${v} · ${title}`;
    b.onclick = () => void run(v);
    $('variants').append(b);
  }
  void showPumpSettings();
  $('copy').onclick = () => void navigator.clipboard?.writeText(toMarkdown(rows)).then(() => log('Table copied.'));
  ($('feeRecipient') as HTMLInputElement).value = APP_FEE_WALLET;
  ($('feeRecipient') as HTMLInputElement).oninput = () => warnRecipient(signerWallet());
  render();
  renderWho();
  if (!inCherry) {
    auth = { kind: 'signed-out', reason: 'open this page inside Cherry' };
    return renderWho();
  }
  try {
    cherry = new CherryMiniApp({ initTimeout: 8000 });
    await cherry.init();
    renderWho();
    prefillRecipient(signerWallet());
    await exchangeLaunchToken(cherry.launchToken);
  } catch (e) {
    auth = { kind: 'signed-out', reason: `Cherry handshake failed: ${(e as Error).message}` };
    renderWho();
  }
}

void boot();
