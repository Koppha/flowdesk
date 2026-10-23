import { useState } from "react";
import { consentStatement, currentUser, type Placement, type Position, type SignatureInput } from "../api";
import PdfPlacer from "./PdfPlacer";
import SignatureChooser, { SignatureMark, isComplete, toInput, useSignatureChoice } from "./SignatureChooser";

export type SignRequest = SignatureInput & Position & { widthPct: number; consentStatement: string };

// The whole "sign this PDF" step on one scrolling screen: choose the
// signature, drop it on the page, confirm consent, sign.
export default function SignFlow({ data, placements, submitLabel = "Sign", onSubmit }: {
  data: ArrayBuffer;
  placements?: Placement[];
  submitLabel?: string;
  onSubmit: (req: SignRequest) => Promise<void>;
}) {
  const me = currentUser();
  const name = me?.fullName || "";
  const { choice, setChoice, saved } = useSignatureChoice(name);
  const [position, setPosition] = useState<Position | null>(null);
  const [widthPct, setWidthPct] = useState(0.22);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const missing = !isComplete(choice)
    ? choice.mode === "draw" ? "Draw your signature." : "Type your signature."
    : !position ? "Tap the page where your signature goes." : !consent ? "Tick the consent box." : "";

  async function submit() {
    if (missing || !position) {
      setError(missing);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({ ...toInput(choice), ...position, widthPct, consentStatement: consentStatement(me) });
    } catch (e: any) {
      setError(e?.message || "Couldn't sign the document.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="card stack">
        <h3>1. Your signature</h3>
        <SignatureChooser choice={choice} onChange={setChoice} saved={saved} />
      </section>

      <section className="card stack">
        <h3>2. Place it</h3>
        <PdfPlacer
          data={data}
          placements={placements}
          startOnLastPage
          widthPct={widthPct}
          value={position}
          onChange={setPosition}
          mark={(w, h, scale) => <SignatureMark boxW={w} boxH={h} scale={scale} name={name} choice={choice} />}
        />
        <label className="field">
          <span>Size</span>
          <input type="range" min={0.12} max={0.4} step={0.01} value={widthPct} onChange={(e) => setWidthPct(Number(e.target.value))} />
        </label>
      </section>

      <label className="consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I confirm this is my legal signature and I consent to sign this document electronically.</span>
      </label>

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? "Signing…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
