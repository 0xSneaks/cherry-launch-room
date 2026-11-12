/// <reference types="vite/client" />
// PetalDeck main screen: "Create new coin" form → initial-buy sheet → confirm sheet → one Cherry approval.
// UI only. Transactions come from the unchanged engine via createLauncher().buildLaunch(formData).
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import './styles.css';
import { CherryMiniApp, getBridgeError, isInsideCherry } from '@cherrydotfun/miniapp-sdk';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { explainLaunchError } from '../launch/errors';
import { SPIKE_OWNER_WALLETS } from '../spike/constants';
import { isOwner, sessionFromResponse, type SessionState } from '../spike/session';
import { DRY_RUN_METADATA_URI, FEE_LINE, LAUNCH_MODE, LIVE_FOR_OWNERS_ONLY, QUICK_BUYS } from './config';
import { UploadError, uploadMetadata } from './upload';
import {
  buyError,
  emptyForm,
  hasErrors,
  isValidMint,
  isVideo,
  mediaError,
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
import { FeeWalletIsSignerError, FormInvalidError, createLauncher, shortKey, type CherrySigner, type LaunchOutcome, type LaunchSummary, type PreparedLaunch } from './launch';
import { nextTier, type Tier } from './tiers';

// Hidden owner flag: /?harness=1 opens the A–H test harness (keeps Cherry's own params).
// Without it nobody lands on the harness: /debug/ and /spike send everyone back here.
const params = new URLSearchParams(location.search);
const goDebug = params.get('harness') === '1';
if (goDebug) location.replace(`/debug/?${params.toString()}`);
const theme = params.get('cherry_theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.cherryTheme = theme;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

const connection = new Connection(`${location.origin}/api/rpc`, 'confirmed');
const pump = new OnlinePumpSdk(connection);

const form: LaunchForm = emptyForm();
const touched = new Set<Field>();
let limits: PumpLimits | null = null;
let customCheck: { mint: string; decimals?: number; error?: string } | null = null;
let feeRecipient: PublicKey | null = null;
let auth: SessionState = { kind: 'checking' };
let signer: CherrySigner | null = null;
let ownerOverride = false; // dev preview only
let prepared: PreparedLaunch | null = null;
let mediaUrl: string | null = null;
let mediaFile: File | null = null;
/** Pinned metadata for the current form (re-used if the user goes back and forth). */
let pinned: { key: string; uri: string } | null = null;
/** The live launch shown on the done sheet (kept for Retry). */
let live: { launch: PreparedLaunch; outcome: LaunchOutcome } | null = null;
let launching = false;
let bannerUrl: string | null = null;

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
  const e = validateForm(form, limits);
  if (!e.customMint && form.pair === 'CUSTOM' && customCheck?.mint === form.customMint.trim() && customCheck.error) {
    e.customMint = customCheck.error;
  }
  return e;
}

function showErrors(errs: FieldErrors, scope: ParentNode = document) {
  scope.querySelectorAll<HTMLElement>('[data-err]').forEach((p) => {
    const f = p.dataset.err as Field;
    const msg = touched.has(f) ? (errs[f] ?? '') : '';
    p.textContent = msg;
    p.id = `err-${f}`;
    const el = document.getElementById(f);
    if (el && el.tagName !== 'DIV') {
      el.setAttribute('aria-invalid', String(!!msg));
      if (msg) el.setAttribute('aria-describedby', p.id);
    }
  });
}

function render() {
  const errs = allErrors();
  showErrors(errs, $('page'));
  $('drop').classList.toggle('invalid', touched.has('media') && !!errs.media);

  document.querySelectorAll<HTMLButtonElement>('[data-pair]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pair === form.pair)));
  $('customMintField').hidden = form.pair !== 'CUSTOM';
  document.querySelectorAll<HTMLButtonElement>('[data-rewards]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.rewards === form.rewards)));

  const mayhemOk = form.pair !== 'CUSTOM' && (limits?.mayhemEnabled ?? false);
  input('mayhem').disabled = !mayhemOk;
  $('mayhemHint').textContent = !limits
    ? 'Checking Pump…'
    : !limits.mayhemEnabled
      ? 'Pump has mayhem mode off right now.'
      : form.pair === 'CUSTOM'
        ? 'Mayhem mode works with SOL or USDC pairs only.'
        : "Pump's mayhem launch mode. SOL or USDC pairs only, set once at creation.";

  $<HTMLButtonElement>('create').disabled = hasErrors(requiredErrors(form));
}

function renderChip() {
  const chip = $('walletChip');
  const wallet = auth.kind === 'signed-in' ? auth.session.wallet : null;
  chip.textContent = wallet ? shortKey(wallet) : 'No wallet';
  chip.classList.toggle('chip-off', !wallet);
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
const renderAfterTap = () => (pointerDown ? (renderPending = true) : render());

// ---------- inputs ----------
type TextField = 'name' | 'ticker' | 'description' | 'website' | 'x' | 'telegram' | 'customMint';
function bindText(id: TextField) {
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

let mintTimer: ReturnType<typeof setTimeout> | undefined;
function checkCustomMint() {
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

function setMedia(file: File | null) {
  touched.add('media');
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = null;
  form.media = file ? { type: file.type, size: file.size } : null;
  const ok = !!file && !mediaError(form.media);
  mediaFile = ok ? file : null;
  if (ok) mediaUrl = URL.createObjectURL(file);
  const video = ok && isVideo(form.media);
  const img = $<HTMLImageElement>('mediaImg');
  const vid = $<HTMLVideoElement>('mediaVideo');
  img.hidden = !ok || video;
  vid.hidden = !ok || !video;
  if (ok && !video) img.src = mediaUrl!;
  if (ok && video) vid.src = mediaUrl!;
  $('dropEmpty').hidden = ok;
  $('dropChange').hidden = !ok;
  $('drop').classList.toggle('has-file', ok);
  render();
}

function setBanner(file: File | null) {
  touched.add('banner');
  if (bannerUrl) URL.revokeObjectURL(bannerUrl);
  bannerUrl = null;
  form.banner = file ? { type: file.type, size: file.size } : null;
  const ok = !!file && !validateForm(form, limits).banner;
  if (ok) bannerUrl = URL.createObjectURL(file);
  $<HTMLImageElement>('bannerImg').hidden = !ok;
  if (ok) $<HTMLImageElement>('bannerImg').src = bannerUrl!;
  $('bannerEmpty').hidden = ok;
  $('bannerDrop').classList.toggle('has-file', ok);
  render();
}

function setPair(pair: Pair) {
  form.pair = pair;
  if (pair === 'CUSTOM' && form.mayhem) {
    form.mayhem = false;
    input('mayhem').checked = false;
  }
  form.initialBuy = ''; // the unit changed
  render();
}

// ---------- sheets ----------
function openSheet(id: 'buySheet' | 'sheet' | 'doneSheet') {
  $('toasts').replaceChildren(); // nothing may cover the sheet's buttons
  $(id).hidden = false;
}
function closeSheet(id: 'buySheet' | 'sheet' | 'doneSheet') {
  if (launching && id === 'sheet') return; // never hide a launch in flight
  $(id).hidden = true;
  if (id === 'sheet') prepared = null;
}

function renderBuy() {
  const err = buyError(form.initialBuy, decimals());
  touched.add('initialBuy');
  showErrors({ initialBuy: form.initialBuy.trim() ? err : undefined }, $('buySheet'));
  $('buyUnit').textContent = unitOf(form.pair);
  document.querySelectorAll<HTMLButtonElement>('#buyChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.amount === form.initialBuy.trim())));
  $<HTMLButtonElement>('buyContinue').disabled = !!err;
}

function openBuySheet() {
  input('initialBuy').value = form.initialBuy;
  renderBuy();
  openSheet('buySheet');
}

const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`;

function fillConfirm(s: LaunchSummary) {
  const media = $('sheetMedia');
  media.replaceChildren();
  if (mediaUrl) {
    const el = isVideo(form.media) ? Object.assign(document.createElement('video'), { muted: true, autoplay: true, loop: true, playsInline: true }) : document.createElement('img');
    el.src = mediaUrl;
    media.append(el);
  }
  $('sheetTitle').textContent = s.name;
  $('sheetTicker').textContent = `$${s.ticker}`;
  $('sheetPair').textContent = s.pair;
  $('sheetBuy').textContent = s.initialBuy;
  $('sheetCost').textContent = s.costLamports === null ? 'Unavailable' : `≈ ${sol(s.costLamports)}`;
  $('sheetFees').textContent = s.feeSplit;
  $('sheetNote').textContent = s.costNote ?? '';
  $('sheetNote').hidden = !s.costNote;
  $('sheetDryRun').hidden = !s.dryRun;
}

function showError(err: unknown) {
  if (getBridgeError(err)?.code === 'USER_REJECTED') return; // silent, per Cherry guidance
  if (err instanceof FormInvalidError) {
    Object.keys(err.fields).forEach((f) => touched.add(f as Field));
    render();
    return toast(err.message, 'error');
  }
  if (err instanceof FeeWalletIsSignerError || err instanceof UploadError) return toast(err.message, 'error', 6000);
  toast(explainLaunchError(err), 'error', 6000);
}

function signedInWallet(): PublicKey | null {
  return auth.kind === 'signed-in' ? new PublicKey(auth.session.wallet) : null;
}

/** Step 1: "Create coin" → check everything we can, then the buy sheet. */
function onCreate() {
  (Object.keys(form) as Field[]).forEach((f) => {
    if (['name', 'ticker', 'media'].includes(f) || (form[f] !== '' && form[f] !== false && form[f] !== null)) touched.add(f);
  });
  render();
  if (hasErrors(allErrors())) {
    document.querySelector('.page .err:not(:empty)')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast('Fix the highlighted fields.', 'error');
  }
  const wallet = signedInWallet();
  if (!feeRecipient) return toast("Couldn't load PetalDeck settings. Try again in a minute.", 'error');
  if (!wallet || !signer) return toast('Open PetalDeck inside Cherry to create a coin.', 'info');
  if (feeRecipient.equals(wallet)) return toast(new FeeWalletIsSignerError().message, 'error', 6000);
  if ((LAUNCH_MODE === 'dry-run' || LIVE_FOR_OWNERS_ONLY) && !ownerOverride && !isOwner(auth, SPIKE_OWNER_WALLETS)) return toast('Creating coins opens soon.', 'info');
  openBuySheet();
}

/** Step 2: buy chosen (or skipped) → buildLaunch(formData) → confirm sheet. */
async function onBuyDone(skip: boolean) {
  if (skip) form.initialBuy = '';
  const wallet = signedInWallet();
  if (!wallet || !signer || !feeRecipient) return;
  const btn = $<HTMLButtonElement>(skip ? 'buySkip' : 'buyContinue');
  const label = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Preparing…';
  try {
    let uri = DRY_RUN_METADATA_URI;
    if (LAUNCH_MODE === 'live') {
      if (!mediaFile) throw new UploadError('Add an image for your coin.');
      const key = JSON.stringify([form.name.trim(), form.ticker, form.description.trim(), form.website.trim(), form.x.trim(), form.telegram.trim(), mediaFile.name, mediaFile.size, mediaFile.lastModified]);
      if (pinned?.key !== key) {
        btn.textContent = 'Uploading image…';
        pinned = { key, uri: await uploadMetadata(form, mediaFile) };
        btn.textContent = 'Preparing…';
      }
      uri = pinned.uri;
    }
    prepared = await createLauncher({ connection, pump, signer, wallet, feeRecipient }).buildLaunch({ ...form }, uri);
    fillConfirm(prepared.summary);
    closeSheet('buySheet');
    openSheet('sheet');
  } catch (err) {
    if (err instanceof FormInvalidError && err.fields.initialBuy && Object.keys(err.fields).length === 1) {
      renderBuy();
    } else {
      closeSheet('buySheet');
      showError(err);
    }
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = label;
    if (!$('buySheet').hidden) renderBuy();
  }
}

/** Step 3: one Cherry approval. Live: send + confirm in order, then the done sheet. Dry-run: signed, verified, dropped. */
async function onSign() {
  if (!prepared) return;
  const btn = $<HTMLButtonElement>('sign');
  const back = $<HTMLButtonElement>('sheetBack');
  btn.disabled = back.disabled = true;
  btn.textContent = 'Waiting for Cherry…';
  const launch = prepared;
  try {
    if (LAUNCH_MODE === 'live') {
      launching = true;
      const outcome = await launch.launch((t) => (btn.textContent = t)).finally(() => (launching = false));
      live = { launch, outcome };
      closeSheet('sheet');
      showDone();
      return;
    }
    const res = await launch.sign();
    closeSheet('sheet');
    toast(res.verified ? 'Signed in Cherry. Dry run: nothing was sent.' : 'Signed, but a signature did not verify. Nothing was sent.', res.verified ? 'success' : 'error', 6000);
  } catch (err) {
    closeSheet('sheet');
    showError(err);
  } finally {
    btn.disabled = back.disabled = false;
    btn.textContent = LAUNCH_MODE === 'live' ? 'Launch coin' : 'Sign in Cherry';
  }
}

// ---------- done sheet (live) ----------
function showDone() {
  if (!live) return;
  const o = live.outcome;
  const done = o.landed === o.total;
  $('doneTitle').textContent = done ? 'Your coin is live' : 'Your coin is live, one step left';
  $('doneMint').textContent = o.mint;
  $<HTMLAnchorElement>('donePump').href = `https://pump.fun/coin/${o.mint}`;
  $<HTMLAnchorElement>('doneSolscan').href = `https://solscan.io/token/${o.mint}`;
  const media = $('doneMedia');
  media.replaceChildren();
  if (mediaUrl) media.append(Object.assign(document.createElement('img'), { src: mediaUrl, alt: '' }));
  $('doneStatus').textContent = done
    ? 'Creator fees: you 95% · PetalDeck 5%, set on-chain.'
    : "The fee-split step didn't go through. Your coin exists; tap Finish to set the 95/5 split.";
  $('doneStatus').classList.toggle('warn-text', !done);
  $('doneRetry').hidden = done;
  openSheet('doneSheet');
}

async function onRetry() {
  if (!live) return;
  const btn = $<HTMLButtonElement>('doneRetry');
  btn.disabled = true;
  try {
    live.outcome = await live.launch.retry((t) => (btn.textContent = t));
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Finish';
    showDone();
  }
}

// ---------- height tiers (Cherry split view) ----------
let tier: Tier = 'full';
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'file', 'radio'].includes((a as HTMLInputElement).type)));
}
function measureTier() {
  tier = nextTier(tier, $('appRoot').getBoundingClientRect().height, isTyping());
  document.documentElement.dataset.tier = tier;
}

// ---------- boot ----------
async function loadPumpLimits() {
  try {
    const g = await pump.fetchGlobal();
    limits = { mayhemEnabled: g.mayhemModeEnabled };
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
    const cherry = new CherryMiniApp({ initTimeout: 8000 });
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
  (['name', 'ticker', 'description', 'website', 'x', 'telegram', 'customMint'] as const).forEach(bindText);
  input('media').addEventListener('change', () => setMedia(input('media').files?.[0] ?? null));
  input('banner').addEventListener('change', () => setBanner(input('banner').files?.[0] ?? null));
  document.querySelectorAll<HTMLButtonElement>('[data-pair]').forEach((b) => (b.onclick = () => setPair(b.dataset.pair as Pair)));
  document.querySelectorAll<HTMLButtonElement>('[data-rewards]').forEach((b) => {
    b.onclick = () => {
      if (b.disabled) return;
      form.rewards = b.dataset.rewards as LaunchForm['rewards'];
      render();
    };
  });
  input('mayhem').addEventListener('change', () => {
    form.mayhem = input('mayhem').checked;
    touched.add('mayhem');
    render();
  });

  for (const amount of QUICK_BUYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.amount = amount;
    b.textContent = amount;
    b.onclick = () => {
      form.initialBuy = input('initialBuy').value = form.initialBuy.trim() === amount ? '' : amount;
      renderBuy();
    };
    $('buyChips').append(b);
  }
  input('initialBuy').addEventListener('input', () => {
    form.initialBuy = input('initialBuy').value;
    renderBuy();
  });

  $('create').onclick = onCreate;
  $('buyContinue').onclick = () => void onBuyDone(false);
  $('buySkip').onclick = () => void onBuyDone(true);
  $('sign').onclick = () => void onSign();
  $('doneRetry').onclick = () => void onRetry();
  $('doneCopy').onclick = () => {
    if (live) void navigator.clipboard?.writeText(live.outcome.mint).then(() => toast('Contract address copied.', 'success'));
  };
  if (LAUNCH_MODE === 'live') $('sign').textContent = 'Launch coin';
  $('sheetBack').onclick = () => {
    closeSheet('sheet');
    openBuySheet();
  };
  document.querySelectorAll<HTMLElement>('[data-close]').forEach((el) => (el.onclick = () => closeSheet(el.dataset.close as 'buySheet' | 'sheet' | 'doneSheet')));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('doneSheet').hidden) closeSheet('doneSheet');
    else if (!$('sheet').hidden) closeSheet('sheet');
    else if (!$('buySheet').hidden) closeSheet('buySheet');
  });

  measureTier();
  new ResizeObserver(measureTier).observe($('appRoot')); // live while Cherry's split handle is dragged
  document.addEventListener('focusout', () => setTimeout(measureTier, 0)); // keyboard closed

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
    devSession(wallet: string, fakeSign = false) {
      // fakeSign: a throwaway in-memory key stands in for Cherry and really signs, to exercise the live
      // screens against a mocked /api/send. Dev server only; stripped from production builds.
      const kp = fakeSign ? Keypair.generate() : null;
      if (kp) wallet = kp.publicKey.toBase58();
      auth = { kind: 'signed-in', session: { userKey: 'dev', wallet, tier: 'unverified', exp: Date.now() / 1000 + 300 } };
      const sign = (tx: Transaction) => (tx.partialSign(kp!), tx.serialize({ requireAllSignatures: false }));
      signer = kp
        ? { signTransaction: async (tx) => sign(tx), signAllTransactions: async (txs) => txs.map(sign) }
        : {
            signTransaction: () => Promise.reject(new Error('dev preview: no Cherry wallet')),
            signAllTransactions: () => Promise.reject(new Error('dev preview: no Cherry wallet')),
          };
      ownerOverride = true;
      renderChip();
    },
  };
}
