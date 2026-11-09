import { lazy, Suspense, useLayoutEffect, useState, type CSSProperties } from "react";
import {
  applyCherryContextToDocument, isInsideCherry, useCherryBlink, useCherryDisplayContext,
  useCherryMiniApp, useCherryUser,
} from "@cherrydotfun/miniapp-sdk/react";
import { AFFILIATION_NOTICE, PRIVACY_URL, TERMS_URL } from "../shared/cherry-listing";
import { pumpFunCoinUrl } from "./launch/links";
import { SharedCoin } from "./ui/CoinResult";
import { LaunchWizard, type PrepareLaunch } from "./ui/LaunchWizard";

const StandaloneWallet = lazy(() => import("./ui/StandaloneWallet"));

export interface RoomLaunch {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  imageUrl?: string;
  confirmedAt: string;
}

export function App({ launches = [], prepareLaunch }: { launches?: RoomLaunch[]; prepareLaunch?: PrepareLaunch }) {
  const insideCherry = isInsideCherry();
  const { user, room, isReady, error } = useCherryMiniApp();
  const profile = useCherryUser();
  const blink = useCherryBlink();
  const { locale, colorScheme, safeArea } = useCherryDisplayContext();
  const [wizard, setWizard] = useState(false);

  useLayoutEffect(() => {
    applyCherryContextToDocument({ locale, colorScheme });
  }, [locale, colorScheme]);

  const shellStyle = safeArea ? ({
    "--safe-top": `${safeArea.top}px`, "--safe-right": `${safeArea.right}px`,
    "--safe-bottom": `${safeArea.bottom}px`, "--safe-left": `${safeArea.left}px`,
  } as CSSProperties) : undefined;
  const displayName = profile?.displayName || user?.displayName;
  const avatarUrl = profile?.avatarUrl || user?.avatarUrl;
  const isCoinCard = window.location.pathname === "/coin";
  const mint = blink?.params?.mint ?? new URLSearchParams(window.location.search).get("mint");
  const waiting = insideCherry && !isReady && !error;

  if (isCoinCard && (mint !== null || !waiting)) {
    return <div className="shell card-shell" style={shellStyle}><SharedCoin mint={mint} /></div>;
  }

  return (
    <div className="shell" style={shellStyle}>
      <header className="topbar">
        <span className="wordmark">Launch Room</span>
        {!insideCherry && <Suspense fallback={<span className="skeleton wallet" aria-hidden="true" />}><StandaloneWallet /></Suspense>}
        {insideCherry && displayName && (
          <span className="profile">
            {avatarUrl && <img src={avatarUrl} alt="" width="28" height="28" referrerPolicy="no-referrer" />}
            <span>{displayName}</span>
          </span>
        )}
      </header>
      {waiting ? (
        <main className="panel" aria-busy="true" aria-label="Loading Launch Room">
          <div className="skeleton title" />
          <div className="skeleton row" />
          <div className="skeleton row" />
        </main>
      ) : insideCherry && !isReady ? (
        <main className="panel">
          <h1>Cherry connection unavailable</h1>
          <p>Reopen Launch Room from your Cherry room to try again.</p>
        </main>
      ) : wizard ? (
        <LaunchWizard insideCherry={insideCherry} prepare={prepareLaunch} onClose={() => setWizard(false)} />
      ) : (
        <main className="panel">
          <p className="eyebrow">{room?.title || "Pump.fun on Solana"}</p>
          <h1>Room feed</h1>
          {launches.length ? (
            <ul className="feed">
              {launches.map((launch) => (
                <li key={launch.mint}>
                  {launch.imageUrl && <img src={launch.imageUrl} alt="" loading="lazy" width="44" height="44" referrerPolicy="no-referrer" />}
                  <div><strong>{"$"}{launch.symbol}</strong><p>{launch.name} · {launch.creator}</p>
                    <time dateTime={launch.confirmedAt}>{new Date(launch.confirmedAt).toLocaleString(locale || "en")}</time></div>
                  <a href={pumpFunCoinUrl(launch.mint)} target="_blank" rel="noopener noreferrer">Pump.fun</a>
                </li>
              ))}
            </ul>
          ) : <p>Be first. Launch a coin.</p>}
          <button className="primary" type="button" onClick={() => setWizard(true)}>Launch a coin</button>
        </main>
      )}
      <footer>
        <div className="links">
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms of Service</a>
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </div>
        <p>{AFFILIATION_NOTICE}</p>
      </footer>
    </div>
  );
}
