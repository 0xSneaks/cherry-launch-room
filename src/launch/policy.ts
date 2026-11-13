// PetalDeck policy knobs. Changing any of these changes the money path: Sneaks's yes first.

/**
 * Holder-reward coins send every creator fee to holders, so no 95/5 split is possible:
 * PetalDeck earns 0 on them. ON: OWNER RULING (Sneaks 2026-11-13) "keep it how pump has it" —
 * Creator | Holders like pump.fun's create form. The UI says plainly that Holders pays PetalDeck nothing.
 */
export const HOLDER_REWARD_ALLOWED = true;

/** create_v2 string limits (pump-public-docs COIN_CREATION.md: name 32, symbol 13, uri 200). */
export const LIMITS = { name: 32, symbol: 13, uri: 200 } as const;

/** Token-quoted creates are heavy (SDK README: ~200-240k CU each; ~500k for create + buy). */
export const TOKEN_QUOTE_CU = { create: 300_000, buy: 300_000, createAndBuy: 500_000 } as const;
