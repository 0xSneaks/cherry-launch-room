// Every error a launch can hit → one plain sentence for the user. Unknown errors never leak raw text.
import { getBridgeError } from '@cherrydotfun/miniapp-sdk';
import {
  CashbackDeprecatedError,
  CreatorFeeBpsOutOfRangeError,
  CreatorFeeNotConfigurableError,
  CreatorFeeNotConfigurableForQuoteError,
  CurveDepthExceededError,
  DuplicateShareholderError,
  HolderRewardDisabledError,
  InvalidShareTotalError,
  QuoteBondingCurveNotEligibleError,
  QuoteCurveAwaitingMigrationError,
  QuotePoolNotFoundError,
  QuoteReservesOutOfRangeError,
  TooManyShareholdersError,
  UnsupportedQuoteMintError,
} from '@pump-fun/pump-sdk';
import { LaunchTooLargeError, LaunchValidationError } from './engine';

/** Cherry wallet bridge (SDK 0.1.24 BridgeErrorCode / CherryPolicyCode). */
const CHERRY: Record<string, string> = {
  USER_REJECTED: 'You cancelled in your wallet. Nothing was sent.',
  TX_LIMIT: 'This is over your Cherry per-transaction limit. Try a smaller first buy.',
  DAILY_LIMIT: "You've hit your Cherry daily limit. Try again tomorrow or with a smaller buy.",
  FORBIDDEN_INSTRUCTION: 'Cherry blocked this launch for safety. Nothing was sent.',
  DANGEROUS_INSTRUCTION: 'Cherry blocked this launch for safety. Nothing was sent.',
  UNSTATED_ROLE: 'Cherry blocked this launch for safety. Nothing was sent.',
  APP_PAUSED: 'PetalDeck is paused by Cherry right now.',
  SIMULATION_FAILED: "Cherry's safety check could not run this launch. Check your balance and try again.",
  PRICE_UNAVAILABLE: 'Cherry could not price this launch right now. Try again in a minute.',
  PRECHECK_UNAVAILABLE: "Cherry's safety check is down right now. Try again in a minute.",
  WALLET_CHANGED: 'Your wallet changed. Reopen PetalDeck and try again.',
  WALLET_NOT_CONNECTED: 'No wallet connected in Cherry.',
  WALLET_NOT_IN_ACCOUNT: 'That wallet is not in your Cherry account.',
  WALLET_UNAVAILABLE: 'Your Cherry wallet is unavailable right now.',
  NOT_A_SIGNER: 'Your wallet is not a signer on this launch. Reopen PetalDeck and try again.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  TIMEOUT: 'Cherry took too long to answer. Nothing was sent.',
};

/** Pump program custom errors (pump-public-docs, SDK 4.3.1 README). */
const PUMP: Record<number, string> = {
  6024: 'The creator-fee split was already set for this coin and cannot change.',
  6063: 'Pump does not accept that pair token.',
  6064: 'Pump does not accept that pair token.',
  6065: 'Pump does not accept that pair token.',
  6071: 'Mayhem mode only works with a SOL or USDC pair.',
  6075: 'Pump does not accept that pair token.',
  6077: 'Pump has custom creator fees switched off right now.',
  6078: 'That creator fee is outside what Pump allows.',
  6082: 'Pump no longer allows cashback coins.',
  6084: 'Pump has holder rewards switched off right now.',
  6091: 'A custom creator fee only works on custom pairs (not SOL or USDC).',
  6100: 'That pump coin cannot be used as a pair.',
  6102: 'That pump coin has no pool Pump can price yet.',
};

/** Pump SDK typed errors thrown before signing. instanceof, not class names (minified builds rename them). */
const SDK: [new (...a: never[]) => Error, string][] = [
  [UnsupportedQuoteMintError, 'Pump does not accept that pair token.'],
  [CreatorFeeNotConfigurableError, 'Pump has custom creator fees switched off right now.'],
  [CreatorFeeNotConfigurableForQuoteError, 'A custom creator fee only works on custom pairs (not SOL or USDC).'],
  [CreatorFeeBpsOutOfRangeError, 'That creator fee is outside what Pump allows.'],
  [CashbackDeprecatedError, 'Pump no longer allows cashback coins.'],
  [HolderRewardDisabledError, 'Pump has holder rewards switched off right now.'],
  [CurveDepthExceededError, 'That pump coin is too far down a pair chain to pair with.'],
  [QuoteBondingCurveNotEligibleError, 'That pump coin cannot be used as a pair.'],
  [QuoteCurveAwaitingMigrationError, 'That pump coin is moving to its pool. Try again in a few minutes.'],
  [QuoteReservesOutOfRangeError, 'That pump coin cannot be used as a pair at its current price.'],
  [QuotePoolNotFoundError, 'That pump coin has no pool Pump can price yet.'],
  [DuplicateShareholderError, 'Fee recipients must all be different wallets.'],
  [InvalidShareTotalError, 'Fee shares must add up to 100%.'],
  [TooManyShareholdersError, 'At most 10 fee recipients.'],
];

export const UNKNOWN_LAUNCH_ERROR = 'Something went wrong. Nothing was sent. Try again.';

function customCode(err: unknown): number | null {
  const text = typeof err === 'object' && err ? JSON.stringify(err) + String((err as Error).message ?? '') : String(err);
  const m = /"Custom":\s*(\d{4})|custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (!m) return null;
  return m[1] ? Number(m[1]) : parseInt(m[2], 16);
}

export function explainLaunchError(err: unknown): string {
  if (err instanceof LaunchValidationError) return err.problems.join(' ');
  if (err instanceof LaunchTooLargeError) return 'This pair is too complex to launch from Cherry yet. Pick another pair.';
  const be = getBridgeError(err);
  if (be) return CHERRY[be.policyCode ?? ''] ?? CHERRY[be.code] ?? UNKNOWN_LAUNCH_ERROR;
  const sdk = SDK.find(([cls]) => err instanceof cls);
  if (sdk) return sdk[1];
  const code = customCode(err);
  if (code !== null && PUMP[code]) return PUMP[code];
  if (/insufficient (funds|lamports)/i.test(String((err as Error | null)?.message ?? err))) {
    return 'Not enough balance for this launch (coin rent + fees + first buy).';
  }
  return UNKNOWN_LAUNCH_ERROR;
}
