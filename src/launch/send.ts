import type { Connection, Keypair, PublicKey, Transaction, TransactionSignature } from "@solana/web3.js";
import bs58 from "bs58";
import { describeWalletError, LaunchError } from "./errors";
import { assertWalletSigned } from "./transaction";

export type SendPhase = "signing" | "sending" | "confirming";

export interface SignAndSendArgs {
  connection: Connection;
  tx: Transaction; // fully built, fresh blockhash + lastValidBlockHeight set
  payer: PublicKey;
  mintKeypair: Keypair;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  onPhase?: (phase: SendPhase, signature?: string) => void;
  /** Test hooks. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SendOutcome =
  | { status: "confirmed"; signature: TransactionSignature }
  | { status: "failed"; signature: TransactionSignature; message: string }
  | { status: "expired"; signature: TransactionSignature }
  /** Seen on-chain but not confirmed within our wait window. Check the explorer. */
  | { status: "unknown"; signature: TransactionSignature };

const MAX_LANDED_POLLS = 40;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Order matters: the wallet signs first, then the in-browser mint keypair co-signs the
 * exact message the wallet returned. The mint keypair never leaves this function's caller
 * and is never persisted.
 */
export async function signAndSend(a: SignAndSendArgs): Promise<SendOutcome> {
  const sleep = a.sleep ?? defaultSleep;
  const pollMs = a.pollIntervalMs ?? 1_500;
  const lastValidBlockHeight = a.tx.lastValidBlockHeight;
  if (!lastValidBlockHeight) throw new Error("Transaction is missing lastValidBlockHeight");

  a.onPhase?.("signing");
  let signed: Transaction;
  try {
    signed = await a.signTransaction(a.tx);
  } catch (e) {
    throw new LaunchError(describeWalletError(e));
  }
  assertWalletSigned(signed, a.payer, a.mintKeypair.publicKey);
  signed.partialSign(a.mintKeypair);

  let raw: Buffer;
  try {
    // Throws if any required signature is missing or invalid, or if the wallet grew the
    // transaction past the packet limit.
    raw = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (/too large/i.test(msg))
      throw new LaunchError("Your wallet added instructions and the launch no longer fits in one transaction. Try a shorter name or no initial buy.");
    throw new LaunchError(`The signed launch didn't verify: ${msg}`);
  }
  const signature = bs58.encode(signed.signatures[0].signature!);

  a.onPhase?.("sending", signature);
  try {
    // First send runs the node's preflight so obvious failures surface before anything lands.
    await a.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs ?? [];
    throw new LaunchError(`The network rejected the launch: ${(e as Error).message}`, logs);
  }

  a.onPhase?.("confirming", signature);
  let tick = 0;
  let landedPolls = 0;
  for (;;) {
    await sleep(pollMs);
    tick++;
    const { value } = await a.connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) return { status: "failed", signature, message: `The launch failed on-chain: ${JSON.stringify(status.err)}` };
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"))
      return { status: "confirmed", signature };

    if (status) {
      // Landed but not yet confirmed: keep waiting (no rebroadcast needed), bounded.
      if (++landedPolls > MAX_LANDED_POLLS) return { status: "unknown", signature };
      continue;
    }

    const height = await a.connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // Final look with history search before declaring it expired.
      const final = (await a.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (final?.err) return { status: "failed", signature, message: `The launch failed on-chain: ${JSON.stringify(final.err)}` };
      if (final?.confirmationStatus === "confirmed" || final?.confirmationStatus === "finalized") return { status: "confirmed", signature };
      if (final) return { status: "unknown", signature };
      return { status: "expired", signature };
    }
    // Rebroadcast every other poll while the blockhash is still valid.
    if (tick % 2 === 0) {
      a.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
}
