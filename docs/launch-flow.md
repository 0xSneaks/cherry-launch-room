# PetalDeck launch flow (production pick)

Status: **chosen, sim-verified, NOT broadcast.** Mainnet send needs Sneaks's explicit yes.
Labels: **VERIFIED** (ran it / saw it) · **INTENT** (Sneaks wants it) · **INFERENCE** (reasoned, not proven) · **UNKNOWN**.

## The pick: variant P (one approval)

SOL pair, two legacy transactions, **one** `signAllTransactions` approval:

| # | Transaction | Bytes | CU (fork) |
|---|---|---|---|
| 1 | `create_v2` + first buy (legacy SOL `buy`, optional) | 1203 (858 without a buy) | ~200–260k |
| 2 | `create_fee_sharing_config` + `update_fee_shares` (user 9500 / app 500 bps) + 0-lamport self transfer carrying the Cherry reference key | 854 | ~140–155k |

- No first buy → the same shape is variant D (`[create + ref] + [fee share + ref]`, 908 + 854 B). Cherry already signed D.
- Order on send (INTENT, not yet built): app co-signs tx 1 with the in-memory mint key → send tx 1 → wait `confirmed` → send tx 2. Never send tx 2 first. Both share one blockhash (≈60–90 s window). If tx 2 expires, rebuild only tx 2 and ask Cherry again.
- If tx 2 never lands, the coin exists with the user as 100% creator-fee owner. Fees accrued before the split pay out to the user when it lands (VERIFIED: an intruder buy between tx 1 and tx 2 does not break tx 2, SOL and USDC, fork 2026-11-12).
- **Why P:** fewest approvals (1) and fewest txs (2) that include the 95/5 split, and it fits 1232 B without a lookup table. Both of its tx shapes have been signed in Cherry already: tx 1 = C, tx 2 = D's second tx. P as a pair has NOT been signed yet, so re-sign it.

## Results (all variants)

Cherry column = Sneaks's in-app run, 2026-11-12, signer Ftui…3GYp, `tier verified` (screenshot). Fork columns = `npm run sim`, fresh, 2026-11-12 22:39 UTC, mainnet state copied into LiteSVM. Reads only, nothing sent. A synthetic wallet gets 5 SOL (plus 50 USDC for F) on the fork.

| Var | What | Bytes | Cherry sign | Each tx alone (= plain RPC sim) | Chained on fork (tx 2 sees tx 1) |
|---|---|---|---|---|---|
| A | create_v2 | 858 | SIGNED | ok 119,571 CU | ok 119,571 CU |
| B | create_v2 + ref | 908 | SIGNED | ok 110,721 CU | ok 110,721 CU |
| C | create_v2 + 0.01 SOL buy (no room for ref) | 1203 | SIGNED | ok 196,514 CU | ok 196,514 CU |
| D | [create + ref] → [fee share 95/5 + ref] | 908 + 854 | SIGNED (sim showed 3012) | ok ; **3012** | ok 101,721 ; **ok 146,778** |
| E | create + buy + fee share + ref, one tx | 1667 | skipped (by design) | over 1232 B | over 1232 B |
| F | USDC: create → 1 USDC buy → fee share v2 + ref | 1030 + 1071 + 930 | SIGNED (old tx 3, see fix) | ok ; **IncorrectProgramId** ; **3012** | ok 122,535 ; ok 174,089 ; **ok 200,784** |
| G | mayhem: create + 0.01 SOL buy → fee share + ref | 1203 + 854 | not run | ok ; **3012** | ok 258,321 ; **ok 140,778** |
| H | custom pair: create → fee share v2 + ref | 1030 + 930 | SIGNED (sim showed 3012) | ok ; **3012** | ok 136,355 ; **ok 232,135** |
| H′ | H on Sneaks's pair `3NZ9…qmJh` | 1030 + 930 | — | ok ; **3012** | ok 125,855 ; **ok 181,135** |
| **P** | **production: create + 0.01 SOL buy → fee share + ref** | 1203 + 854 | not run (new) | ok ; **3012** | ok 208,480 ; **ok 152,774** |

Reproduce: `npm run sim` (all) · `node scripts/.sim-suite.mjs H <pairMint>` · `SIM_JSON=1` for logs · `SIM_FULL_LOGS=1` for full program logs. Preview only: `GET /api/sim?suite=1`.

## Diagnoses

### 3012 on the fee-share tx — CONFIRMED (VERIFIED)
`pfee…VojVZ` log: `AnchorError caused by account: mint. Error Code: AccountNotInitialized. Error Number: 3012.` The fee-share tx was simulated against today's chain, where tx 1's mint and bonding curve don't exist yet. Every fee-share tx (D, F, G, H, P) fails alone and passes when tx 1 runs first on the same fork (table above). So the failure is in the test, not in the instruction. Fix: the test page's sim (`/api/sim`) runs the txs chained on a fork (`src/sim/fork.ts`). Plain per-tx RPC sim is now only a fallback, and its output is labelled "(alone)".

### F: IncorrectProgramId — same artifact, programs verified (VERIFIED)
Log: `TokenzQdBN… failed: incorrect program id` inside `ATokenGP…` (instruction 1 of the buy tx). The ATA create for the new coin runs Token-2022, which is correct for a `create_v2` mint. Simulated alone, though, the mint doesn't exist yet: it's owned by System, so Token-2022 rejects it. Chained, it passes. A unit test now pins the programs (`src/launch/engine.test.ts`, "token programs"): new pump mint ATA = **Token-2022**, USDC ATAs = **SPL Token**.

### F/H: a real bug behind the 3012 — fixed (VERIFIED)
With chaining, F's fee-share tx still failed: `UpdateFeeSharesV2 → DistributeCreatorFeesV2: InvalidAccountData`. `create_fee_sharing_config` moves the curve creator to the sharing-config PDA. `update_fee_shares_v2` then pays out of the **quote ATA of `creatorVault(sharingConfig)`**, which nothing creates. That fails with or without a first buy, so it hits every token-quoted coin (F, H). SOL coins use a lamport vault and are unaffected (D, G, P).
Fix: `sharingVaultAtaInstruction` (`src/launch/engine.ts`), an idempotent ATA create between the config and the update. It costs +10 B (920 → 930) and ~0.002 SOL rent paid by the user. Re-sim: F tx 3 ok 200,784 CU, H tx 2 ok 232,135 CU.

## 5% recipient guard (VERIFIED by tests)
- Engine: `validateLaunch` refuses a launch signed by the app fee wallet, and `feeShareholders` / `assertRecipientNotSigner` throw `RecipientIsSignerError` if recipient == signer (`src/launch/guard.ts`).
- Test page: no more silent swap at sign time. If Cherry's signer is the fee wallet (Ftui…3GYp), the recipient field is prefilled with the owner's second wallet **before** any tap, with a visible note. If recipient == signer, every fee-share button (D, F, G, H, P) is **blocked** with a ⛔ banner. A, B and C ignore the recipient.

## Attribution: reference key on the fee-share tx only
Rule (Cherry portal prompt §7): the reference key goes on one instruction we control in every tx. Our create + buy tx is 1203 B, and the smallest ref instruction (0-lamport System transfer) adds ~50 B, giving 1253 > 1232. There's no instruction of ours in that tx to append to, and appending to the Pump instruction is forbidden.
**Decision:** carry the ref on tx 2 (the fee-share tx) only, never in a lookup table, never on a Pump instruction. Why:
1. Every PetalDeck launch has tx 2 (the 95/5 split is mandatory), and tx 2 can only land after the create, so one ref per launch marks the launch.
2. Cherry SDK README §13 (VERIFIED, `reference/cherry-miniapp-sdk/README.md`): "attribution only: Cherry does not bill from it, so leaving it out never lowers a fee (volume is metered by the host's own transaction check)." Leaving the ref off tx 1 costs nothing on the bill.
3. The alternatives cost more: a v0 tx plus an app-owned lookup table (rent, needs Sneaks's yes, adds a moving part) or dropping the first buy from tx 1 (adds a third tx).
Dune query for app volume: txs whose keys include `getAppReferenceKey(CHERRY_APP_ID)`, joined on the mint created in the same signer's preceding tx.
Gap (INFERENCE): the portal checklist says "every transaction carries the reference key". Tx 1 doesn't. If listing review flags it, tell Cherry the reason above, or switch tx 1 to v0 + ALT.

## Rejected
| Var | Why not production |
|---|---|
| A, B | No first buy, no 95/5 split. The split is mandatory (owner ruling 2026-11-09). |
| C | No split, and no room for the ref. Kept only as P's tx 1. |
| D | Accepted as P's no-buy path. Not separate. |
| E | 1667 B > 1232. Needs v0 + ALT. |
| F | USDC: 3 txs, a USDC balance, vault-ATA rent. Works now; keep for a later "USDC pair" option. |
| G | Mayhem is opt-in, not the default. Same shape as P (G = P + mayhem); sim passes. |
| H | Custom pairs: token-quoted (vault-ATA rent), exotic quotes, custom creator fee. Later option. |

## Still open
- **UNKNOWN:** whether Cherry broadcasts or accepts these signed txs on a real send. Signing is proven (Sneaks's report). The board's 2026-11-09 `DANGEROUS_INSTRUCTION` refusals predate today's signatures; the tier still reads `verified`.
- **Sneaks re-signs in Cherry:** P, G, F, H, D (list in the handoff). A, B and C are unchanged, so no re-sign is needed.
- ⚠️ HIGH-RISK before any real launch: money-path review + independent Opus cross-check (board D5), then one small live launch on Sneaks's yes.
