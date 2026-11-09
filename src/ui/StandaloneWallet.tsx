import { useState } from "react";
import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { shortAddress } from "../launch/links";

function WalletControls() {
  const { wallet, wallets, publicKey, select, connect, disconnect, connecting } = useWallet();
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState("");
  const available = wallets.filter(({ readyState }) =>
    readyState === WalletReadyState.Installed || readyState === WalletReadyState.Loadable,
  );

  async function updateConnection() {
    setMessage("");
    try {
      if (publicKey) {
        await disconnect();
        select(null);
      } else {
        await connect();
      }
    } catch {
      setMessage("Wallet connection could not be updated.");
    }
  }

  return (
    <div className="wallet-controls">
      {wallet ? (
        <>
          <button type="button" onClick={() => void updateConnection()} disabled={connecting}>
            {publicKey ? `Disconnect ${shortAddress(publicKey.toBase58())}` : connecting ? "Connecting…" : `Connect ${wallet.adapter.name}`}
          </button>
          {!publicKey && <button type="button" disabled={connecting} onClick={() => { select(null); setChoosing(true); setMessage(""); }}>Change wallet</button>}
        </>
      ) : (
        <>
          <button type="button" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>Connect wallet</button>
          {choosing && (available.length
            ? available.map(({ adapter }) => (
              <button key={adapter.name} type="button" onClick={() => { select(adapter.name); setChoosing(false); }}>{adapter.name}</button>
            ))
            : <p role="status">Open Launch Room in a Solana wallet browser or install a compatible wallet.</p>)}
        </>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

export default function StandaloneWallet() {
  return (
    <ConnectionProvider endpoint={new URL("/api/rpc", window.location.origin).href}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletControls />
      </WalletProvider>
    </ConnectionProvider>
  );
}
