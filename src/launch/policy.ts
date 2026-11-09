import { type FieldErrors, parseSolToLamports } from "../../shared/validation";
import { LAMPORTS_PER_SOL } from "../../shared/limits";

/**
 * A launch policy decides which create_v2 flags a launch uses and any extra rules a
 * launch must follow. Everything that builds a launch goes through a policy, so new
 * launch types (holder rewards, gated launches, ...) can be added without touching
 * the transaction builder. V1 registers only `standard`.
 */
export interface CreateFlags {
  mayhemMode: boolean;
  holderReward: boolean;
}

export interface LaunchPolicy {
  id: string;
  label: string;
  description: string;
  /** Upper bound on the optional initial buy, in lamports. */
  maxInitialBuyLamports: bigint;
  createFlags(): CreateFlags;
  /** Policy-specific checks on top of the shared field validation. */
  validateInitialBuy(raw: string): { lamports: bigint | null; errors: FieldErrors };
}

const STANDARD_MAX_BUY = 50n * LAMPORTS_PER_SOL;

export const standardPolicy: LaunchPolicy = {
  id: "standard",
  label: "Standard launch",
  description: "A regular Pump.fun coin paired with SOL. You are the creator and earn the creator fee.",
  maxInitialBuyLamports: STANDARD_MAX_BUY,
  createFlags: () => ({ mayhemMode: false, holderReward: false }),
  validateInitialBuy(raw) {
    const lamports = parseSolToLamports(raw);
    if (lamports === null) return { lamports: null, errors: { initialBuy: "Enter an amount like 0.5" } };
    if (lamports > STANDARD_MAX_BUY) return { lamports: null, errors: { initialBuy: "Initial buy is capped at 50 SOL." } };
    return { lamports, errors: {} };
  },
};

const REGISTRY: Record<string, LaunchPolicy> = {
  [standardPolicy.id]: standardPolicy,
};

export const ENABLED_POLICY_IDS = Object.keys(REGISTRY);
export const DEFAULT_POLICY_ID = standardPolicy.id;

export function getPolicy(id: string): LaunchPolicy {
  const policy = REGISTRY[id];
  if (!policy) throw new Error(`Unknown launch policy: ${id}`);
  return policy;
}
