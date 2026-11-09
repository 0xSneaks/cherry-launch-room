/// <reference types="vite/client" />
// PetalDeck main screen: pump.fun-style create-coin form → confirm sheet → one Cherry approval.
// UI only. Transactions come from the unchanged engine via createLauncher().buildLaunch(formData).
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import './styles.css';
import { CherryMiniApp, getBridgeError, isInsideCherry } from '@cherrydotfun/miniapp-sdk';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { explainLaunchError } from '../launch/errors';
import { SPIKE_OWNER_WALLETS } from '../spike/constants';
import { isOwner, sessionFromResponse, type SessionState } from '../spike/session';
import { FEE_LINE, LAUNCH_MODE, QUICK_BUYS } from './config';
import {
  emptyForm,
  hasErrors,
  isValidMint,
  normalizeTicker,
  requiredErrors,
  unitOf,
  validateForm,
  type Field,
  type FieldErrors,
  type LaunchForm,
  type Pair,
  type PumpLimits,
} from './form';
import { FeeWalletIsSignerError, FormInvalidError, createLauncher, shortKey, type CherrySigner, type LaunchSummary, type PreparedLaunch } from './launch';

// Hidden dev flag: /?debug=1 opens the A–H test harness (keeps Cherry's own params).
const debugParams = new URLSearchParams(location.search);
const goDebug = debugParams.has('debug');
if (goDebug) {
  debugParams.delete('debug');
  const rest = debugParams.toString();
  location.replace(`/debug/${rest ? '?' + rest : ''}`);
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed');
const pump = new OnlinePumpSdk(connection);

const form: LaunchForm = emptyForm();
const touched = new Set<Field>();
let limits: PumpLimits | null = null;
let customCheck: { mint: string; decimals?: number; error?: string } | null = null;
let feeRecipient: PublicKey | null = null;
let cherry: CherryMiniApp | null = null;
let auth: SessionState = { kind: 'checking' };
let signer: CherrySigner | null = null;
let ownerOverride = false; // dev preview only
let prepared: PreparedLaunch | null = null;
let imageUrl: string | null = null;
let busy = false;

// ---------- toasts ----------
function toast(text: string, kind: 'error' | 'success' | 'info' = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.role = kind === 'error' ? 'alert' : 'status';
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- validation + render ----------
const decimals = () => (form.pair === 'USDC' ? 6 : form.pair === 'CUSTOM' ? (customCheck?.decimals ?? 9) : 9);

function allErrors(): FieldErrors {
  const e = validateForm(form, limits, decimals());
  if (!e.customMint && form.pair === 'CUSTOM' && customCheck?.mint === form.customMint.trim() && customCheck.error) {
    e.customMint = customCheck.error;
  }
  return e;
}

function render() {
  const errs = allErrors();
  document.querySelectorAll<HTMLElement>('[data-err]').forEach((p) => {
    const f = p.dataset.err as Field;
    const msg = touched.has(f) ? (errs[f] ?? '') : '';
    p.textContent = msg;
    const el = document.getElementById(f);
    if (el && f !== 'image') el.setAttribute('aria-invalid', String(!!msg));
    if (el && msg) el.setAttribute('aria-describedby', `err-${f}`);
    p.id = `err-${f}`;
  });
  $('upload').classList.toggle('invalid', touched.has('image') && !!errs.image);

  // Pair-dependent bits.
  document.querySelectorAll<HTMLButtonElement>('[data-pair]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pair === form.pair)));
  $('customMintField').hidden = form.pair !== 'CUSTOM';
  $('buyUnit').textContent = unitOf(form.pair);
  document.querySelectorAll<HTMLButtonElement>('#buyChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.amount === form.initialBuy.trim())));

  const mayhemOk = form.pair !== 'CUSTOM' && (limits?.mayhemEnabled ?? false);
  input('mayhem').disabled = !mayhemOk;
  $('mayhemHint').textContent = !limits ? 'Checking Pump…' : !limits.mayhemEnabled ? 'Pump has mayhem mode off right now.' : 'SOL or USDC pairs only.';

  const feeOk = form.pair === 'CUSTOM' && (limits?.creatorFeeConfigurable ?? false);
  input('creatorFeePct').disabled = !feeOk;
  input('creatorFeePct').placeholder = feeOk ? 'Pump default' : 'Custom pairs only';
  $('creatorFeeHint').textContent = !limits
    ? 'Checking Pump…'
    : !limits.creatorFeeConfigurable
      ? 'Pump has custom creator fees off right now.'
      : feeOk
        ? `Up to ${limits.maxCreatorFeeBps / 100}% (Pump's current max).`
        : 'Pump allows a custom creator fee on custom pairs only.';

  const create = $<HTMLButtonElement>('create');
  create.disabled = hasErrors(requiredErrors(form)) || busy;
  create.setAttribute('aria-busy', String(busy));
  create.textContent = busy ? 'Preparing…' : 'Create coin';
}

function renderChip() {
  const chip = $('walletChip');
  const wallet = auth.kind === 'signed-in' ? auth.session.wallet : null;
  chip.textContent = wallet ? shortKey(wallet) : 'No wallet';
  chip.classList.toggle('chip-off', !wallet);
}

// ---------- inputs ----------
function bindText(id: Field & ('name' | 'description' | 'website' | 'x' | 'telegram' | 'initialBuy' | 'creatorFeePct' | 'customMint' | 'ticker')) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  el.addEventListener('input', () => {
    if (id === 'ticker') el.value = normalizeTicker(el.value);
    form[id] = el.value;
    if (id === 'customMint') void checkCustomMint();
    render();
  });
  el.addEventListener('blur', () => {
    if (el.value) touched.add(id);
    renderAfterTap();
  });
}

// A blur fires mid-tap (pointerdown on the next control). Rendering a new inline error right then shifts
// the layout and the tap lands on the wrong element, so wait until the pointer is released.
let pointerDown = false;
let renderPending = false;
document.addEventListener('pointerdown', () => (pointerDown = true), true);
document.addEventListener(
  'pointerup',
  () => {
    pointerDown = false;
    if (renderPending) {
      renderPending = false;
      setTimeout(render, 0); // after the click event
    }
  },
  true,
);
function renderAfterTap() {
  if (pointerDown) renderPending = true;
  else render();
}

let mintTimer: ReturnType<typeof setTimeout> | undefined;
async function checkCustomMint() {
  clearTimeout(mintTimer);
  const mint = form.customMint.trim();
  if (!isValidMint(mint)) return;
  mintTimer = setTimeout(async () => {
    try {
      const q = await pump.resolveQuoteMint(new PublicKey(mint));
      customCheck = { mint, decimals: q.decimals };
    } catch (err) {
      customCheck = { mint, error: explainLaunchError(err) };
      touched.add('customMint');
    }
    render();
  }, 400);
}

function setImage(file: File | null) {
  touched.add('image');
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  form.image = file ? { type: file.type, size: file.size } : null;
  const ok = file && !requiredErrors(form).image;
  if (ok) imageUrl = URL.createObjectURL(file);
  const img = $<HTMLImageElement>('imagePreview');
  img.hidden = !ok;
  if (imageUrl) img.src = imageUrl;
  $('uploadEmpty').hidden = !!ok;
  $('uploadChange').hidden = !ok;
  $('upload').classList.toggle('has-image', !!ok);
  render();
}

function setPair(pair: Pair) {
  form.pair = pair;
  if (pair === 'CUSTOM') {
    form.mayhem = false;
    input('mayhem').checked = false;
  } else {
    form.creatorFeePct = '';
    input('creatorFeePct').value = '';
  }
  render();
}

// ---------- confirm sheet ----------
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`;

function openSheet(s: LaunchSummary) {
  $('toasts').replaceChildren(); // nothing may cover the Sign button
  $<HTMLImageElement>('sheetImage').src = imageUrl ?? '';
  $('sheetTitle').textContent = s.name;
  $('sheetTicker').textContent = `$${s.ticker}`;
  $('sheetPair').textContent = s.pair;
  $('sheetBuy').textContent = s.initialBuy;
  $('sheetCost').textContent = s.costLamports === null ? 'Unavailable' : `≈ ${sol(s.costLamports)}`;
  $('sheetFees').textContent = s.feeSplit;
  $('sheetNote').textContent = s.costNote ?? '';
  $('sheetNote').hidden = !s.costNote;
  $('sheetDryRun').hidden = !s.dryRun;
  $('sheet').hidden = false;
  $<HTMLButtonElement>('sign').focus();
}

function closeSheet() {
  $('sheet').hidden = true;
  prepared = null;
}

function showError(err: unknown) {
  if (getBridgeError(err)?.code === 'USER_REJECTED') return; // silent, per Cherry guidance
  if (err instanceof FormInvalidError) {
    Object.keys(err.fields).forEach((f) => touched.add(f as Field));
    render();
    return toast(err.message, 'error');
  }
  if (err instanceof FeeWalletIsSignerError) return toast(err.message, 'error', 6000);
  toast(explainLaunchError(err), 'error', 6000);
}

async function onCreate() {
  (Object.keys(form) as Field[]).forEach((f) => {
    if (f === 'image' || f === 'name' || f === 'ticker' || (form[f] !== '' && form[f] !== false)) touched.add(f);
  });
  render();
  if (hasErrors(allErrors())) {
    const first = document.querySelector('.err:not(:empty)');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast('Fix the highlighted fields.', 'error');
  }
  if (!feeRecipient) return toast("Couldn't load PetalDeck settings. Try again in a minute.", 'error');
  if (auth.kind !== 'signed-in' || !signer) return toast('Open PetalDeck inside Cherry to create a coin.', 'info');
  if (LAUNCH_MODE === 'dry-run' && !ownerOverride && !isOwner(auth, SPIKE_OWNER_WALLETS)) return toast('Creating coins opens soon.', 'info');

  busy = true;
  render();
  try {
    const launcher = createLauncher({ connection, pump, signer, wallet: new PublicKey(auth.session.wallet), feeRecipient });
    prepared = await launcher.buildLaunch({ ...form });
    openSheet(prepared.summary);
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    render();
  }
}

async function onSign() {
  if (!prepared) return;
  const btn = $<HTMLButtonElement>('sign');
  btn.disabled = true;
  btn.textContent = 'Waiting for Cherry…';
  try {
    const res = await prepared.sign();
    closeSheet();
    toast(res.verified ? 'Signed in Cherry. Dry run: nothing was sent.' : 'Signed, but a signature did not verify. Nothing was sent.', res.verified ? 'success' : 'error', 6000);
  } catch (err) {
    closeSheet();
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in Cherry';
  }
}

// ---------- boot ----------
async function loadPumpLimits() {
  try {
    const g = await pump.fetchGlobal();
    limits = { mayhemEnabled: g.mayhemModeEnabled, creatorFeeConfigurable: g.creatorFeeConfigurable, maxCreatorFeeBps: g.maxConfigurableCreatorFeeBps.toNumber() };
  } catch {
    limits = null;
  }
  render();
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const body = (await res.json()) as { feeRecipient?: string };
    feeRecipient = res.ok && body.feeRecipient ? new PublicKey(body.feeRecipient) : null;
  } catch {
    feeRecipient = null;
  }
}

async function connectCherry() {
  if (!isInsideCherry({ strict: true })) {
    auth = { kind: 'signed-out', reason: 'not inside Cherry' };
    return renderChip();
  }
  try {
    cherry = new CherryMiniApp({ initTimeout: 8000 });
    await cherry.init();
    const sdkWallet = cherry.paymentWallet ?? cherry.wallet.publicKey ?? null;
    const token = cherry.launchToken;
    if (!token) auth = { kind: 'signed-out', reason: 'no launch token' };
    else {
      const res = await fetch('/api/auth/cherry', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      auth = sessionFromResponse(res.status, await res.json().catch(() => null), sdkWallet ? new PublicKey(sdkWallet).toBase58() : null);
    }
    const w = cherry.wallet;
    signer = {
      signTransaction: async (tx, opts) => (await w.signTransaction(tx, opts)) as Uint8Array,
      signAllTransactions: (txs, opts) => w.signAllTransactions(txs, opts),
    };
  } catch {
    auth = { kind: 'signed-out', reason: 'Cherry handshake failed' };
  }
  renderChip();
}

function boot() {
  $('feeLine').textContent = FEE_LINE;
  for (const amount of QUICK_BUYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.amount = amount;
    b.textContent = amount;
    b.onclick = () => {
      form.initialBuy = input('initialBuy').value = form.initialBuy.trim() === amount ? '' : amount;
      touched.add('initialBuy');
      render();
    };
    $('buyChips').append(b);
  }
  (['name', 'ticker', 'description', 'website', 'x', 'telegram', 'customMint', 'initialBuy', 'creatorFeePct'] as const).forEach(bindText);
  input('image').addEventListener('change', () => setImage(input('image').files?.[0] ?? null));
  document.querySelectorAll<HTMLButtonElement>('[data-pair]').forEach((b) => (b.onclick = () => setPair(b.dataset.pair as Pair)));
  input('mayhem').addEventListener('change', () => {
    form.mayhem = input('mayhem').checked;
    touched.add('mayhem');
    render();
  });
  $('create').onclick = () => void onCreate();
  $('sign').onclick = () => void onSign();
  document.querySelectorAll<HTMLElement>('[data-close]').forEach((el) => (el.onclick = closeSheet));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('sheet').hidden && closeSheet());

  render();
  renderChip();
  void loadPumpLimits();
  void loadConfig();
  void connectCherry();
}

if (!goDebug) boot();

// Dev server only (stripped from production builds): preview the signed-in flow outside Cherry for screenshots.
if (import.meta.env.DEV) {
  (window as unknown as { __petaldeck: unknown }).__petaldeck = {
    devSession(wallet: string) {
      auth = { kind: 'signed-in', session: { userKey: 'dev', wallet, tier: 'unverified', exp: Date.now() / 1000 + 300 } };
      signer = {
        signTransaction: () => Promise.reject(new Error('dev preview: no Cherry wallet')),
        signAllTransactions: () => Promise.reject(new Error('dev preview: no Cherry wallet')),
      };
      ownerOverride = true;
      renderChip();
    },
  };
}
