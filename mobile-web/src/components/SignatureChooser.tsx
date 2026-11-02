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

/** Starts from the saved signature (shared with the web portal) when there is one. */
export function useSignatureChoice(defaultName: string) {
  const [choice, setChoice] = useState<SignatureChoice>({ mode: "type", typed: defaultName, drawn: null, uploaded: null });
  const [saved, setSaved] = useState<SavedSignature | null>(null);

  useEffect(() => {
    api
      .savedSignature()
      .then((s) => {
        if (!s) return;
        setSaved(s);
        setChoice(
          s.signatureType === "draw"
            ? { mode: "draw", typed: defaultName, drawn: s.imageDataUrl, uploaded: null }
            : { mode: "type", typed: s.typedName || defaultName, drawn: null, uploaded: null }
        );
      })
      .catch(() => {
        // No saved signature to start from - the typed name default stands.
      });
  }, [defaultName]);

  return { choice, setChoice, saved, setSaved };
}

export default function SignatureChooser({ choice, onChange, saved }: { choice: SignatureChoice; onChange: (c: SignatureChoice) => void; saved: SavedSignature | null }) {
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
        {tab("type", "Type")}
        {tab("draw", "Draw")}
        {tab("upload", "Upload")}
      </div>
      {choice.mode === "type" ? (
        <label className="field">
          <span>Your signature</span>
          <input value={choice.typed} onChange={(e) => onChange({ ...choice, typed: e.target.value })} placeholder="Type your full name" autoComplete="name" />
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
