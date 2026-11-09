import { getBridgeError } from '@cherrydotfun/miniapp-sdk';

/** One row of the spike table. Never holds signed bytes or signatures. */
export interface SpikeRow {
  /** A–E: spike builders · F–H: the real launch engine. */
  variant: string;
  result: 'SIGNED' | 'REFUSED' | 'SKIPPED' | 'ERROR';
  code?: string;
  policyCode?: string;
  reason?: string;
  /** Unsigned-size per tx, all signature slots counted. */
  bytes: number[];
  /** Length of what Cherry returned, per tx. */
  returnedBytes?: number[];
  /** Our own RPC simulation per tx (sigVerify off): 'ok' or the error. */
  sim?: string[];
  /** Wallet signed first, then the mint co-signed the returned tx: all signatures verify. */
  mintCosignOk?: boolean;
  at: string;
}

/** Codes on variant A that mean Cherry will not sign a Pump.fun launch at all. */
export const KILL_CODES = new Set(['FORBIDDEN_INSTRUCTION', 'DANGEROUS_INSTRUCTION', 'UNSTATED_ROLE']);

export function refusalFields(err: unknown): Pick<SpikeRow, 'result' | 'code' | 'policyCode' | 'reason'> {
  const be = getBridgeError(err);
  if (!be) {
    return { result: 'ERROR', reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
  }
  return {
    result: 'REFUSED',
    code: be.code,
    policyCode: be.policyCode,
    reason: (be.reason ?? be.message ?? '').slice(0, 200),
  };
}

/** KILL when variant A is refused for its content (not for limits, pauses or user rejection). */
export function isKill(row: SpikeRow): boolean {
  if (row.variant !== 'A' || row.result !== 'REFUSED') return false;
  return KILL_CODES.has(row.policyCode ?? '') || KILL_CODES.has(row.code ?? '');
}

export function toMarkdown(rows: SpikeRow[]): string {
  const head = '| Variant | Result | code / policyCode | bytes (sent to Cherry) | returned | our sim | mint co-sign |\n|---|---|---|---|---|---|---|';
  const body = rows.map((r) =>
    [
      r.variant,
      r.result,
      [r.code, r.policyCode].filter(Boolean).join(' / ') || '—',
      r.bytes.join(' + '),
      r.returnedBytes?.join(' + ') ?? '—',
      r.sim?.join(' ; ') ?? '—',
      r.mintCosignOk === undefined ? '—' : r.mintCosignOk ? 'ok' : 'FAIL',
    ].join(' | '),
  );
  return [head, ...body.map((b) => `| ${b} |`)].join('\n');
}
