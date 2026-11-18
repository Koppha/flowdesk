import { useEffect, useState } from "react";
import { api, type SavedSignature, type SignatureInput } from "../api";
import SignaturePad from "./SignaturePad";
import SignatureUpload from "./SignatureUpload";

// Type, draw, or upload a picture of your signature - the same three ways as
// the web portal. Drawn and uploaded signatures are both images: they're
// sent and saved the same way (saved signature type "draw"), which is what
// keeps the saved signature in sync between web and mobile.
export type SignatureMode = "type" | "draw" | "upload";
export type SignatureChoice = { mode: SignatureMode; typed: string; drawn: string | null; uploaded: string | null };

/** The signature image for the image modes, or null. */
export function imageOf(c: SignatureChoice) {
  return c.mode === "draw" ? c.drawn : c.mode === "upload" ? c.uploaded : null;
}

export function toInput(c: SignatureChoice): SignatureInput {
  return c.mode === "type" ? { typedSignatureText: c.typed.trim() } : { signatureImageDataUrl: imageOf(c) || undefined };
}

export function isComplete(c: SignatureChoice) {
  return c.mode === "type" ? c.typed.trim().length > 0 : Boolean(imageOf(c));
}

/** What to store as the saved signature (shared with the web portal). */
export function toSaved(c: SignatureChoice): SavedSignature {
  return c.mode === "type"
    ? { signatureType: "type", typedName: c.typed.trim(), imageDataUrl: null }
    : { signatureType: "draw", typedName: null, imageDataUrl: imageOf(c) };
}

// Signatures must be drawn or uploaded once an admin switches that on (same
// rule as the web portal and the server). Someone who saved a TYPED
// signature may still sign with it typedLeft more times, then it's removed.
export type SignatureRules = { requireImage: boolean; typedLeft: number | null; typedAllowed: boolean };

/** Starts from the saved signature (shared with the web portal) when there is one. */
export function useSignatureChoice(defaultName: string) {
  const [choice, setChoice] = useState<SignatureChoice>({ mode: "draw", typed: defaultName, drawn: null, uploaded: null });
  const [saved, setSaved] = useState<SavedSignature | null>(null);
  const [requireImage, setRequireImage] = useState(false);

  useEffect(() => {
    api.signaturePolicy().then((p) => setRequireImage(p.requireImage === true)).catch(() => {});
    api
      .savedSignature()
      .then((s) => {
        if (!s) return;
        setSaved(s);
        const typedUsable = s.signatureType === "type" && s.typedSigningsLeft !== 0;
        setChoice(
          s.signatureType === "draw"
            ? { mode: "draw", typed: defaultName, drawn: s.imageDataUrl, uploaded: null }
            : { mode: typedUsable ? "type" : "draw", typed: s.typedName || defaultName, drawn: null, uploaded: null }
        );
      })
      .catch(() => {
        // No saved signature to start from - Draw it is.
      });
  }, [defaultName]);

  const typedLeft = saved?.signatureType === "type" ? saved.typedSigningsLeft ?? null : null;
  const rules: SignatureRules = { requireImage, typedLeft, typedAllowed: !requireImage || (typedLeft ?? 0) > 0 };
  return { choice, setChoice, saved, setSaved, rules };
}

/** The warning for someone still using up a saved typed signature, once per visit to the sign screen. */
export function TypedSignatureWarning({ rules, onDrawNow }: { rules: SignatureRules; onDrawNow: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open || !rules.requireImage || !rules.typedLeft || rules.typedLeft <= 0) return null;
  const left = rules.typedLeft;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="typed-sig-title">
      <div className="dialog stack">
        <h3 id="typed-sig-title">Please draw or upload your signature</h3>
        <p>Typed signatures are being retired. You can still sign with your typed signature <b>{left} more time{left === 1 ? "" : "s"}</b>. After that it will be removed, and you'll need to draw or upload your signature to sign.</p>
        <button type="button" className="primary" onClick={() => { setOpen(false); onDrawNow(); }}>Draw or upload now</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Later</button>
      </div>
    </div>
  );
}

export default function SignatureChooser({ choice, onChange, saved, rules }: { choice: SignatureChoice; onChange: (c: SignatureChoice) => void; saved: SavedSignature | null; rules: SignatureRules }) {
  // A saved image (drawn here or on the web, or uploaded) is shown as-is
  // until the user chooses to replace it.
  const [replace, setReplace] = useState(false);
  const usingSavedImage = choice.mode === "draw" && !replace && saved?.signatureType === "draw" && !!saved.imageDataUrl && choice.drawn === saved.imageDataUrl;

  const tab = (mode: SignatureMode, label: string) => (
    <button type="button" role="tab" aria-selected={choice.mode === mode} className={choice.mode === mode ? "on" : ""} onClick={() => onChange({ ...choice, mode })}>
      {label}
    </button>
  );

  return (
    <div className="stack">
      <div className="segmented" role="tablist">
        {rules.typedAllowed && tab("type", "Type")}
        {tab("draw", "Draw")}
        {tab("upload", "Upload")}
      </div>
      {choice.mode === "type" ? (
        <label className="field">
          <span>Your signature</span>
          <input value={choice.typed} readOnly={rules.requireImage} onChange={(e) => onChange({ ...choice, typed: e.target.value })} placeholder="Type your full name" autoComplete="name" />
          {rules.requireImage && rules.typedLeft !== null && rules.typedLeft > 0 && (
            <span className="warn-text">Your saved typed signature can be used {rules.typedLeft} more time{rules.typedLeft === 1 ? "" : "s"}. Please draw or upload instead.</span>
          )}
        </label>
      ) : choice.mode === "upload" ? (
        <SignatureUpload value={choice.uploaded} onChange={(uploaded) => onChange({ ...choice, uploaded })} />
      ) : usingSavedImage ? (
        <div className="saved-drawing">
          <img src={choice.drawn!} alt="Your saved signature" className="checker" />
          <span className="muted small">Your saved signature</span>
          <div className="row gap">
            <button type="button" className="link-btn" onClick={() => { setReplace(true); onChange({ ...choice, drawn: null }); }}>Draw a new one</button>
            <button type="button" className="link-btn" onClick={() => onChange({ ...choice, mode: "upload" })}>Upload instead</button>
          </div>
        </div>
      ) : (
        <SignaturePad onChange={(drawn) => onChange({ ...choice, drawn })} />
      )}
    </div>
  );
}

// The signature as it will be stamped (signatureStamp.ts): name strip 24%,
// signature 56%, date strip 20%, text sizes in PDF points x page scale.
export function SignatureMark({ boxW, boxH, scale, name, choice }: { boxW: number; boxH: number; scale: number; name: string; choice: SignatureChoice }) {
  const nameH = boxH * 0.24, dateH = boxH * 0.2, markH = boxH - nameH - dateH;
  const image = imageOf(choice);
  return (
    <div className="mark" style={{ width: boxW, height: boxH }}>
      <div style={{ height: nameH, lineHeight: `${nameH}px`, fontSize: Math.min(nameH * 0.8, 9 * scale), fontWeight: 700 }}>{name}</div>
      <div className="mark-sig" style={{ height: markH, justifyContent: choice.mode === "type" ? "flex-start" : "center" }}>
        {choice.mode !== "type" ? (
          image ? <img src={image} alt="" draggable={false} /> : <span className="mark-hint">{choice.mode === "upload" ? "Upload below" : "Draw below"}</span>
        ) : (
          <span style={{ fontSize: Math.min(markH * 0.7, 20 * scale), fontWeight: 700, opacity: choice.typed.trim() ? 1 : 0.5 }}>{choice.typed.trim() || "Your signature"}</span>
        )}
      </div>
      <div className="mark-date" style={{ height: dateH, lineHeight: `${dateH}px`, fontSize: Math.min(dateH * 0.85, 7.5 * scale) }}>{new Date().toLocaleDateString("en-GB")}</div>
    </div>
  );
}
