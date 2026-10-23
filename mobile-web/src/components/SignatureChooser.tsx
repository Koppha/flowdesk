import { useEffect, useState } from "react";
import { api, type SavedSignature, type SignatureInput } from "../api";
import SignaturePad from "./SignaturePad";

export type SignatureChoice = { mode: "type" | "draw"; typed: string; drawn: string | null };

export function toInput(c: SignatureChoice): SignatureInput {
  return c.mode === "draw" ? { signatureImageDataUrl: c.drawn || undefined } : { typedSignatureText: c.typed.trim() };
}

export function isComplete(c: SignatureChoice) {
  return c.mode === "draw" ? Boolean(c.drawn) : c.typed.trim().length > 0;
}

/** Starts from the saved signature (shared with the web portal) when there is one. */
export function useSignatureChoice(defaultName: string) {
  const [choice, setChoice] = useState<SignatureChoice>({ mode: "type", typed: defaultName, drawn: null });
  const [saved, setSaved] = useState<SavedSignature | null>(null);

  useEffect(() => {
    api
      .savedSignature()
      .then((s) => {
        if (!s) return;
        setSaved(s);
        setChoice(s.signatureType === "draw" ? { mode: "draw", typed: defaultName, drawn: s.imageDataUrl } : { mode: "type", typed: s.typedName || defaultName, drawn: null });
      })
      .catch(() => {
        // No saved signature to start from - the typed name default stands.
      });
  }, [defaultName]);

  return { choice, setChoice, saved };
}

export default function SignatureChooser({ choice, onChange, saved }: { choice: SignatureChoice; onChange: (c: SignatureChoice) => void; saved: SavedSignature | null }) {
  // A saved drawing is shown as-is until the user chooses to redraw it.
  const [redraw, setRedraw] = useState(false);
  const usingSavedDrawing = choice.mode === "draw" && !redraw && saved?.signatureType === "draw" && choice.drawn === saved.imageDataUrl;

  return (
    <div className="stack">
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={choice.mode === "type"} className={choice.mode === "type" ? "on" : ""} onClick={() => onChange({ ...choice, mode: "type" })}>Type</button>
        <button type="button" role="tab" aria-selected={choice.mode === "draw"} className={choice.mode === "draw" ? "on" : ""} onClick={() => onChange({ ...choice, mode: "draw" })}>Draw</button>
      </div>
      {choice.mode === "type" ? (
        <label className="field">
          <span>Your signature</span>
          <input value={choice.typed} onChange={(e) => onChange({ ...choice, typed: e.target.value })} placeholder="Type your full name" autoComplete="name" />
        </label>
      ) : usingSavedDrawing ? (
        <div className="saved-drawing">
          <img src={choice.drawn!} alt="Your saved signature" />
          <button type="button" className="link-btn" onClick={() => { setRedraw(true); onChange({ ...choice, drawn: null }); }}>Draw a new one</button>
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
  return (
    <div className="mark" style={{ width: boxW, height: boxH }}>
      <div style={{ height: nameH, lineHeight: `${nameH}px`, fontSize: Math.min(nameH * 0.8, 9 * scale), fontWeight: 700 }}>{name}</div>
      <div className="mark-sig" style={{ height: markH, justifyContent: choice.mode === "draw" ? "center" : "flex-start" }}>
        {choice.mode === "draw" ? (
          choice.drawn ? <img src={choice.drawn} alt="" draggable={false} /> : <span className="mark-hint">Draw below</span>
        ) : (
          <span style={{ fontSize: Math.min(markH * 0.7, 20 * scale), fontWeight: 700, opacity: choice.typed.trim() ? 1 : 0.5 }}>{choice.typed.trim() || "Your signature"}</span>
        )}
      </div>
      <div className="mark-date" style={{ height: dateH, lineHeight: `${dateH}px`, fontSize: Math.min(dateH * 0.85, 7.5 * scale) }}>{new Date().toLocaleDateString("en-GB")}</div>
    </div>
  );
}
