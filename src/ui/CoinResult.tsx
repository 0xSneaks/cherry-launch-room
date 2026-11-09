import { useState } from "react";
import { useCherryShare } from "@cherrydotfun/miniapp-sdk/react";
import bs58 from "bs58";
import { pumpFunCoinUrl, solscanTokenUrl, solscanTxUrl } from "../launch/links";

export interface ConfirmedLaunch {
  mint: string;
  signature: string;
}

export function CoinLinks({ mint, signature }: { mint: string; signature?: string }) {
  return (
    <div className="links">
      <a href={pumpFunCoinUrl(mint)} target="_blank" rel="noopener noreferrer">Pump.fun</a>
      <a href={signature ? solscanTxUrl(signature) : solscanTokenUrl(mint)} target="_blank" rel="noopener noreferrer">Solscan</a>
    </div>
  );
}

export function SharedCoin({ mint }: { mint: unknown }) {
  let address: string;
  try {
    if (typeof mint !== "string" || mint.length > 44) throw new Error();
    if (bs58.decode(mint).length !== 32) throw new Error();
    address = mint;
  } catch {
    return <main className="panel"><h1>Coin unavailable</h1><p>This card needs a valid mint address.</p></main>;
  }

  return (
    <main className="panel coin-card">
      <p className="eyebrow">Shared from Launch Room</p>
      <h1>Coin address</h1>
      <code>{address}</code>
      <CoinLinks mint={address} />
    </main>
  );
}

export function CoinResult({
  result, symbol, insideCherry, onDone,
}: { result: ConfirmedLaunch; symbol: string; insideCherry: boolean; onDone: () => void }) {
  const share = useCherryShare();
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState(false);

  async function shareToRoom() {
    setSharing(true);
    setNotice("");
    try {
      const response = await share({
        route: "/coin",
        params: { mint: result.mint },
        caption: `I just launched ${"$"}${symbol} on Pump.fun.`,
        height: "medium",
        previewable: true,
      });
      if (response.shared) setNotice("Shared to room.");
    } catch {
      setNotice("Sharing failed. Try again or copy the address.");
    } finally {
      setSharing(false);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(result.mint);
      setNotice("Address copied.");
    } catch {
      setNotice("Select the address above to copy it.");
    }
  }

  return (
    <main className="panel">
      <p className="eyebrow">Confirmed on-chain</p>
      <h1>{"$"}{symbol} is live</h1>
      <code>{result.mint}</code>
      <button type="button" onClick={() => void copyAddress()}>Copy address</button>
      <CoinLinks mint={result.mint} signature={result.signature} />
      {insideCherry && (
        <button className="primary" type="button" disabled={sharing} onClick={() => void shareToRoom()}>
          {sharing ? "Opening share picker…" : "Share to room"}
        </button>
      )}
      <p role="status">{notice}</p>
      <button type="button" onClick={onDone}>Back to room feed</button>
    </main>
  );
}
