import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildLaunchInstructions, maxSolCost } from "../src/launch/adapter";
import { standardPolicy } from "../src/launch/policy";
import { chooseBudget, compileLaunchTx, PACKET_DATA_SIZE, serializedSize } from "../src/launch/transaction";
import { makeGlobal } from "./fixtures";

const coder = new BorshInstructionCoder(pumpIdl as unknown as Idl);
const user = Keypair.generate().publicKey;
const MAX_URI = "https://ipfs.io/ipfs/" + "b".repeat(200 - "https://ipfs.io/ipfs/".length);

function base(overrides: Partial<Parameters<typeof buildLaunchInstructions>[0]> = {}) {
  return {
    mint: Keypair.generate().publicKey,
    user,
    name: "Deck Coin",
    symbol: "DECK",
    uri: "https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
    initialBuyLamports: 0n,
    policy: standardPolicy,
    ...overrides,
  };
}

describe("buildLaunchInstructions: create only", () => {
  it("emits a single create_v2 with standard-launch args", async () => {
    const p = base();
    const { instructions, quote } = await buildLaunchInstructions(p, null);
    expect(quote).toBeNull();
    expect(instructions).toHaveLength(1);
    const [ix] = instructions;
    expect(ix.programId.equals(PUMP_PROGRAM_ID)).toBe(true);

    const decoded = coder.decode(ix.data) as { name: string; data: any };
    expect(decoded.name).toBe("create_v2");
    expect(decoded.data.name).toBe(p.name);
    expect(decoded.data.symbol).toBe(p.symbol);
    expect(decoded.data.uri).toBe(p.uri);
    expect((decoded.data.creator as PublicKey).equals(user)).toBe(true);
    expect(decoded.data.is_mayhem_mode).toBe(false);
    // Holder reward is encoded explicitly as false by the SDK; cashback is never true.
    expect(JSON.stringify(decoded.data.is_holder_reward)).not.toContain("true");
    expect(JSON.stringify(decoded.data.is_cashback_enabled ?? null)).not.toContain("true");

    // Account layout per docs/instructions/COIN_CREATION.md: 16 accounts, mint (#1) and user (#6) sign.
    expect(ix.keys).toHaveLength(16);
    expect(ix.keys[0].pubkey.equals(p.mint) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[5].pubkey.equals(user) && ix.keys[5].isSigner && ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ix.keys[8].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    // Nobody but the mint and the user is asked to sign.
    expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(2);
  });

  it("rejects out-of-range inputs before touching the SDK", async () => {
    await expect(buildLaunchInstructions(base({ name: "x".repeat(33) }), null)).rejects.toThrow();
    await expect(buildLaunchInstructions(base({ symbol: "S".repeat(14) }), null)).rejects.toThrow();
    await expect(buildLaunchInstructions(base({ uri: MAX_URI + "x" }), null)).rejects.toThrow();
    await expect(buildLaunchInstructions(base({ user: PublicKey.default }), null)).rejects.toThrow();
    await expect(buildLaunchInstructions(base({ initialBuyLamports: -1n }), null)).rejects.toThrow();
    await expect(buildLaunchInstructions(base({ initialBuyLamports: 51n * 1_000_000_000n }), null)).rejects.toThrow();
    // An initial buy needs on-chain state.
    await expect(buildLaunchInstructions(base({ initialBuyLamports: 1n }), null)).rejects.toThrow();
  });
});

describe("buildLaunchInstructions: create + initial buy", () => {
  it("emits create_v2, the Token-2022 ATA, then buy with a 1% max cost", async () => {
    const global = await makeGlobal();
    const sol = 250_000_000n; // 0.25 SOL
    const p = base({ initialBuyLamports: sol });
    const { instructions, quote } = await buildLaunchInstructions(p, { global, feeConfig: null });

    expect(instructions).toHaveLength(3);
    expect((coder.decode(instructions[0].data) as any).name).toBe("create_v2");
    expect(instructions[1].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(instructions[1].keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);

    const buy = coder.decode(instructions[2].data) as { name: string; data: any };
    expect(instructions[2].programId.equals(PUMP_PROGRAM_ID)).toBe(true);
    expect(buy.name).toBe("buy");
    expect(BigInt(buy.data.max_sol_cost.toString())).toBe(maxSolCost(sol));
    expect(maxSolCost(sol)).toBe(252_500_000n);
    expect(BigInt(buy.data.amount.toString())).toBe(quote!.tokenAmount);
    expect(quote!.tokenAmount > 0n).toBe(true);
    expect(quote!.supplyShareBps).toBeGreaterThan(0);
    expect(quote!.supplyShareBps).toBeLessThan(10_000);

    // The buy is made by the user, for the mint just created.
    expect(instructions[2].keys.some((k) => k.pubkey.equals(p.mint))).toBe(true);
    expect(instructions[2].keys.find((k) => k.isSigner)?.pubkey.equals(user)).toBe(true);
    // Only the mint and the user ever sign.
    const signers = new Set(instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
    expect([...signers].sort()).toEqual([p.mint.toBase58(), user.toBase58()].sort());
  });

  // Our metadata links are gateway + CIDv0 (67 chars) by default; CIDv1 is 80. Both must fit
  // at the maximum name and ticker lengths, with or without an initial buy.
  const LAUNCH_URIS = {
    cidv0: "https://ipfs.io/ipfs/Qm" + "a".repeat(44),
    cidv1: "https://ipfs.io/ipfs/bafkrei" + "a".repeat(52),
  };

  for (const [label, uri] of Object.entries(LAUNCH_URIS)) {
    it(`create + buy fits one packet at max name/ticker with a ${label} link`, async () => {
      const global = await makeGlobal();
      const { instructions } = await buildLaunchInstructions(
        base({ name: "N".repeat(32), symbol: "S".repeat(13), uri, initialBuyLamports: 10_000_000_000n }),
        { global, feeConfig: null },
      );
      const budget = chooseBudget(user, instructions, 100_000);
      const tx = compileLaunchTx({ payer: user, blockhash: Keypair.generate().publicKey.toBase58(), instructions, budget });
      expect(serializedSize(tx)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      // web3.js agrees with our size math.
      expect(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBe(serializedSize(tx));
    });
  }

  it("keeps the priority fee on create-only launches", async () => {
    const { instructions } = await buildLaunchInstructions(base({ name: "N".repeat(32), symbol: "S".repeat(13), uri: MAX_URI }), null);
    expect(chooseBudget(user, instructions, 100_000).kind).toBe("priority");
  });

  it("drops compute-budget instructions when create + buy would not fit with them", async () => {
    const global = await makeGlobal();
    const { instructions } = await buildLaunchInstructions(
      base({ name: "Deck Coin", symbol: "DECK", uri: LAUNCH_URIS.cidv0, initialBuyLamports: 1_000_000_000n }),
      { global, feeConfig: null },
    );
    const withBudget = compileLaunchTx({
      payer: user,
      blockhash: user.toBase58(),
      instructions,
      budget: { kind: "priority", computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 1 },
    });
    // Measured: a typical create + buy is over the limit once the two budget instructions are added.
    expect(serializedSize(withBudget)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(chooseBudget(user, instructions, 1).kind).toBe("default");
  });

  it("refuses a launch that cannot fit at all", async () => {
    const global = await makeGlobal();
    const { instructions } = await buildLaunchInstructions(
      base({ name: "N".repeat(32), symbol: "S".repeat(13), uri: MAX_URI, initialBuyLamports: 1_000_000_000n }),
      { global, feeConfig: null },
    );
    expect(() => chooseBudget(user, instructions, 1)).toThrow(/too large/);
  });
});
