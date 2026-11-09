import { pumpIdl } from "@pump-fun/pump-sdk";

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

const PUMP_ERRORS = new Map<number, { name: string; msg?: string }>(
  ((pumpIdl as any).errors ?? []).map((e: { code: number; name: string; msg?: string }) => [e.code, e]),
);

// Plain-language overrides for errors a launch can realistically hit.
const FRIENDLY: Record<string, string> = {
  CashbackDeprecated: "Cashback coins can no longer be created.",
  HolderRewardDisabled: "Holder-reward coins are disabled right now.",
  NameTooLong: "The coin name is too long.",
  SymbolTooLong: "The ticker is too long.",
  UriTooLong: "The metadata link is too long.",
  TooMuchSolRequired: "The price moved before your initial buy. Try again.",
  CreateV2Disabled: "Pump.fun has paused new coin creation. Try again later.",
  BuyNotEnoughSolToCoverRent: "Not enough SOL to cover the initial buy and account rent.",
  BuyNotEnoughSolToCoverFees: "Not enough SOL to cover the initial buy and its fees.",
  BuySlippageBelowMinTokensOut: "The price moved before your initial buy. Try again.",
  CreatorShouldNotBeZero: "The creator address is invalid.",
};

export function pumpErrorName(code: number): string | undefined {
  return PUMP_ERRORS.get(code)?.name;
}

function insufficientFunds(logs: string[], err: unknown): boolean {
  const text = JSON.stringify(err) + "\n" + logs.join("\n");
  return /insufficient (lamports|funds)|InsufficientFunds|AccountNotFound/i.test(text);
}

export function describeSimulationFailure(err: unknown, logs: string[]): string {
  if (insufficientFunds(logs, err)) return "Not enough SOL in your wallet to cover the launch, initial buy and fees.";
  if (err && typeof err === "object" && "InstructionError" in err) {
    const [, detail] = (err as { InstructionError: [number, unknown] }).InstructionError;
    if (detail && typeof detail === "object" && "Custom" in detail) {
      const code = (detail as { Custom: number }).Custom;
      const known = PUMP_ERRORS.get(code);
      if (known) return FRIENDLY[known.name] ?? `Pump.fun rejected the launch: ${known.msg ?? known.name} (error ${code}).`;
      return `The launch failed on-chain (error ${code}).`;
    }
  }
  if (err === "BlockhashNotFound") return "The network moved on before the launch was checked. Try again.";
  return "The launch would fail on-chain, so nothing was sent. Check your details and try again.";
}

export function describeWalletError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel|declined|closed/i.test(msg)) return "You cancelled the signature in your wallet. Nothing was sent.";
  return `Your wallet couldn't sign: ${msg}`;
}
