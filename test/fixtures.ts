// Test fixtures: a Pump `Global` account built from the SDK's own IDL, encoded with Anchor's
// coder and decoded by the SDK, so the shape is exactly what the SDK reads from chain.
// Reserve/fee numbers are representative test values, not live mainnet data.
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { type Global, PUMP_SDK, pumpIdl } from "@pump-fun/pump-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

type IdlType = any; // the IDL's type tree is loosely typed; this is test-only code

const idl = pumpIdl as unknown as Idl;

function defaultFor(type: IdlType): unknown {
  if (typeof type === "string") {
    if (type === "bool") return false;
    if (type === "pubkey") return PublicKey.default;
    if (type === "string") return "";
    if (/^[ui](8|16|32)$/.test(type)) return 0;
    if (/^[ui](64|128|256)$/.test(type)) return new BN(0);
    if (type === "bytes") return Buffer.alloc(0);
    throw new Error(`Unhandled IDL primitive ${type}`);
  }
  if (type.array) {
    const [inner, len] = type.array;
    return Array.from({ length: len }, () => defaultFor(inner));
  }
  if (type.vec) return [];
  if (type.option || type.coption) return null;
  if (type.defined) {
    const def = (idl.types ?? []).find((t) => t.name === type.defined.name);
    if (!def) throw new Error(`Missing IDL type ${type.defined.name}`);
    if (def.type.kind === "struct") {
      const out: Record<string, unknown> = {};
      for (const f of (def.type as any).fields) out[f.name] = defaultFor(f.type);
      return out;
    }
    if (def.type.kind === "enum") return { [(def.type as any).variants[0].name]: {} };
  }
  throw new Error(`Unhandled IDL type ${JSON.stringify(type)}`);
}

export const feeRecipients = Array.from({ length: 8 }, () => Keypair.generate().publicKey);

export async function makeGlobal(): Promise<Global> {
  const fields = defaultFor({ defined: { name: "Global" } }) as Record<string, unknown>;
  Object.assign(fields, {
    initialized: true,
    authority: Keypair.generate().publicKey,
    fee_recipient: feeRecipients[0],
    fee_recipients: feeRecipients.slice(1, 8),
    initial_virtual_token_reserves: new BN("1073000000000000"),
    initial_virtual_sol_reserves: new BN("30000000000"),
    initial_real_token_reserves: new BN("793100000000000"),
    token_total_supply: new BN("1000000000000000"),
    fee_basis_points: new BN(95),
    creator_fee_basis_points: new BN(30),
    create_v2_enabled: true,
    buyback_fee_recipients: feeRecipients,
  });
  // BorshAccountsCoder.encode uses a fixed 1000-byte buffer and Global is larger, so encode
  // with the coder's own layout into a big enough buffer.
  const coder = new BorshAccountsCoder(idl) as any;
  const { layout, discriminator } = coder.accountLayouts.get("Global");
  const buf = Buffer.alloc(4096);
  const len = layout.encode(fields, buf);
  const data = Buffer.concat([Buffer.from(discriminator), buf.subarray(0, len)]);
  return PUMP_SDK.decodeGlobal({
    data,
    executable: false,
    lamports: 1,
    owner: new PublicKey(pumpIdl.address),
    rentEpoch: 0,
  });
}
