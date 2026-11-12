// Server-side gate for /api/send: only fully signed PetalDeck launch transactions are relayed.
// The relay is not an open broadcaster: every top-level instruction must be one a PetalDeck
// launch uses, and System instructions may only be the 0-lamport reference self-transfer.
import { PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { TX_BYTE_LIMIT } from '../spike/constants.js';

const ALLOWED_PROGRAMS = [PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ComputeBudgetProgram.programId, SystemProgram.programId];

export type TxCheck = { ok: true; tx: Transaction; bytes: Uint8Array } | { ok: false; error: string };

export function checkLaunchTx(base64: unknown): TxCheck {
  if (typeof base64 !== 'string' || base64.length > 2000) return { ok: false, error: 'bad tx' };
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (bytes.length === 0 || bytes.length > TX_BYTE_LIMIT) return { ok: false, error: 'bad tx size' };
  let tx: Transaction;
  try {
    tx = Transaction.from(bytes);
  } catch {
    return { ok: false, error: 'not a legacy transaction' };
  }
  if (!tx.verifySignatures(true)) return { ok: false, error: 'missing or invalid signature' };

  let pumpIxs = 0;
  for (const ix of tx.instructions) {
    if (!ALLOWED_PROGRAMS.some((p) => p.equals(ix.programId))) return { ok: false, error: `program not allowed: ${ix.programId.toBase58()}` };
    if (ix.programId.equals(PUMP_PROGRAM_ID) || ix.programId.equals(PUMP_FEE_PROGRAM_ID)) pumpIxs++;
    if (ix.programId.equals(SystemProgram.programId)) {
      // Only the Cherry reference ix: a 0-lamport transfer from the fee payer to itself.
      try {
        if (SystemInstruction.decodeInstructionType(ix) !== 'Transfer') return { ok: false, error: 'system ix not allowed' };
        const t = SystemInstruction.decodeTransfer(ix);
        if (BigInt(t.lamports) !== 0n) return { ok: false, error: 'system transfer not allowed' };
        if (!t.fromPubkey.equals(t.toPubkey)) return { ok: false, error: 'system transfer not allowed' };
      } catch {
        return { ok: false, error: 'system ix not allowed' };
      }
    }
  }
  if (pumpIxs === 0) return { ok: false, error: 'not a launch transaction' };
  return { ok: true, tx, bytes };
}
