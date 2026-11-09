import { useState, type FormEvent } from "react";
import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES } from "../../shared/limits";
import {
  normalizeDetails, parseSolToLamports, SOCIAL_FIELDS, validateDetails, validateImage,
  type CoinDetails, type FieldErrors,
} from "../../shared/validation";
import { CoinResult, type ConfirmedLaunch } from "./CoinResult";

interface PreparedLaunch {
  cost: string;
  estimatedTokens?: string;
  estimatedSupply?: string;
  confirm: () => Promise<ConfirmedLaunch>;
}

export type PrepareLaunch = (draft: {
  details: CoinDetails;
  image: File;
  buyLamports: bigint;
}) => Promise<PreparedLaunch>;

const detailFields = ["name", "symbol", "description", ...SOCIAL_FIELDS] as const;
const labels = { name: "Coin name", symbol: "Ticker", description: "Description", twitter: "X", telegram: "Telegram", website: "Website" };
const buyPresets = ["0", "0.05", "0.1", "0.25"];

export function LaunchWizard({
  insideCherry, prepare, onClose,
}: { insideCherry: boolean; prepare?: PrepareLaunch; onClose: () => void }) {
  const [step, setStep] = useState<"details" | "buy" | "review" | "launching" | "done">("details");
  const [details, setDetails] = useState(() => normalizeDetails({}));
  const [image, setImage] = useState<File>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [buy, setBuy] = useState("0");
  const [prepared, setPrepared] = useState<PreparedLaunch>();
  const [result, setResult] = useState<ConfirmedLaunch>();
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);

  async function submitDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeDetails(details);
    const errors = validateDetails(normalized);
    setChecking(true);
    try {
      const imageError = image && image.size > IMAGE_MAX_BYTES
        ? "Image is too large (max 4 MB)."
        : validateImage(image ? new Uint8Array(await image.slice(0, 12).arrayBuffer()) : null);
      if (imageError) errors.image = imageError;
    } catch {
      errors.image = "Could not read this image. Choose it again.";
    } finally {
      setChecking(false);
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setDetails(normalized);
    setStep("buy");
  }

  async function reviewBuy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const buyLamports = parseSolToLamports(buy);
    if (buyLamports === null || !image) {
      setMessage("Enter a SOL amount with up to nine decimal places.");
      return;
    }
    setMessage("");
    setPrepared(undefined);
    setStep("review");
    if (!prepare) return;
    setChecking(true);
    try {
      setPrepared(await prepare({ details, image, buyLamports }));
    } catch {
      setMessage("Simulation did not complete. Go back to check the launch details and try again.");
    } finally {
      setChecking(false);
    }
  }

  async function confirmLaunch() {
    if (!prepared || step !== "review") return;
    setStep("launching");
    try {
      setResult(await prepared.confirm());
      setStep("done");
    } catch {
      setPrepared(undefined);
      setMessage("Launch confirmation is unavailable.");
      setStep("review");
    }
  }

  if (step === "launching") {
    return <main className="panel" aria-busy="true"><h1>Launching</h1><p role="status">Waiting for on-chain confirmation.</p></main>;
  }

  if (step === "done" && result) {
    return <CoinResult result={result} symbol={details.symbol} insideCherry={insideCherry} onDone={onClose} />;
  }

  if (step === "review") {
    return (
      <main className="panel">
        <p className="eyebrow">Step 3 of 3</p>
        <h1>Review launch</h1>
        <dl>
          <dt>Coin</dt><dd>{details.name} ({"$"}{details.symbol})</dd>
          <dt>First buy</dt><dd>{buy.trim() || "0"} SOL</dd>
          <dt>Total outflow</dt><dd>{prepared?.cost ?? (checking ? "Simulating…" : "Simulation required")}</dd>
          {prepared?.estimatedTokens && <><dt>Estimated tokens</dt><dd>{prepared.estimatedTokens}</dd></>}
          {prepared?.estimatedSupply && <><dt>Estimated share of supply</dt><dd>{prepared.estimatedSupply}</dd></>}
        </dl>
        <p>Creates a coin on Pump.fun. You are the on-chain creator. This action is irreversible.</p>
        <p>You keep 95% of creator fees. 5% goes to Launch Room. Permanent.</p>
        {message && <p role="alert">{message}</p>}
        <button className="primary" type="button" disabled={!prepared || checking} onClick={() => void confirmLaunch()}>
          Sign and launch
        </button>
        <button type="button" disabled={checking} onClick={() => { setMessage(""); setStep("buy"); }}>Back</button>
      </main>
    );
  }

  if (step === "buy") {
    return (
      <main className="panel">
        <p className="eyebrow">Step 2 of 3</p>
        <h1>Optional first buy</h1>
        <p>Pick an amount in SOL or enter zero to create the coin without a buy.</p>
        <form onSubmit={(event) => void reviewBuy(event)}>
          <div className="presets" aria-label="First buy presets">
            {buyPresets.map((amount) => (
              <button key={amount} type="button" aria-pressed={buy === amount} onClick={() => setBuy(amount)}>{amount}</button>
            ))}
          </div>
          <label>First buy (SOL)
            <input inputMode="decimal" value={buy} maxLength={24} onChange={(event) => setBuy(event.target.value)} />
          </label>
          {message && <p role="alert">{message}</p>}
          <button className="primary" type="submit">Review launch</button>
          <button type="button" onClick={() => { setMessage(""); setStep("details"); }}>Back</button>
        </form>
      </main>
    );
  }

  return (
    <main className="panel">
      <p className="eyebrow">Step 1 of 3</p>
      <h1>Coin details</h1>
      <form noValidate onSubmit={(event) => void submitDetails(event)}>
        {detailFields.map((field) => (
          <label key={field}>{labels[field]}{field !== "name" && field !== "symbol" && " (optional)"}
            {field === "description"
              ? <textarea value={details[field]} onChange={(event) => setDetails({ ...details, [field]: event.target.value })} aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `error-${field}` : undefined} />
              : <input type={SOCIAL_FIELDS.some((social) => social === field) ? "url" : "text"}
                  value={details[field]} onChange={(event) => setDetails({ ...details, [field]: event.target.value })} aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `error-${field}` : undefined} />}
            {fieldErrors[field] && <small id={`error-${field}`} role="alert">{fieldErrors[field]}</small>}
          </label>
        ))}
        <label>Coin image
          <input type="file" accept={IMAGE_MIME_TYPES.join(",")} aria-invalid={Boolean(fieldErrors.image)}
            aria-describedby={fieldErrors.image ? "error-image" : undefined}
            onChange={(event) => setImage(event.target.files?.[0])} />
          {image && <span className="muted">{image.name}</span>}
          {fieldErrors.image && <small id="error-image" role="alert">{fieldErrors.image}</small>}
        </label>
        <button className="primary" type="submit" disabled={checking}>Continue</button>
        <button type="button" disabled={checking} onClick={onClose}>Back to room feed</button>
      </form>
    </main>
  );
}
