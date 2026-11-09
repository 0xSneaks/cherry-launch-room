// Launch Room policy knobs. Changing any of these changes the money path: Sneaks's yes first.

/**
 * Holder-reward coins send every creator fee to holders, so no 95/5 split is possible:
 * Launch Room earns 0 on them. OFF until Sneaks decides.
 */
export const HOLDER_REWARD_ALLOWED = false;

/** create_v2 string limits (pump-public-docs COIN_CREATION.md: name 32, symbol 13, uri 200). */
export const LIMITS = { name: 32, symbol: 13, uri: 200 } as const;

/** Token-quoted creates are heavy (SDK README: ~200-240k CU each; ~500k for create + buy). */
export const TOKEN_QUOTE_CU = { create: 300_000, buy: 300_000, createAndBuy: 500_000 } as const;
