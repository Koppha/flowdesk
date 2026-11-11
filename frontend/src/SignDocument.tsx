import React, { useCallback, useEffect, useRef, useState } from "react";
import SignatureUpload from "./components/SignatureUpload";
import PdfPlacePicker, { SignatureMarkPreview, type PlacePosition } from "./components/PdfPlacePicker";
import { api, getUserFromToken, openBlobInNewTab } from "./api";
import { ApproverCombobox, type DirectoryUser } from "./shared/ApproverCombobox";
import { FileSignature, Upload, Eraser, CheckCircle2, Copy, Download, Eye, ShieldCheck, BookmarkCheck, XCircle, Send, PenLine, BarChart3 } from "lucide-react";
import SignRoutingDocument from "./SignRoutingDocument";
import PdfTextEditor from "./PdfTextEditor";
import SignPerformance from "./SignPerformance";

// Tier A (audit-trail based) electronic signature: no third-party provider,
// no separate portal — this screen IS the signing surface, reusing the
// session that already proves who the signer is. Standalone by design (see
// document_signatures' generic source_type/source_id) — this page signs any
// uploaded PDF; a future hook into approval-chain steps would call the same
// backend without touching this component.

type SignatureRow = {
  id: string;
  title: string;
  verification_code: string;
  signed_at: string;
  source_type: string | null;
  delegation_notation: "AI" | "PP" | null;
  authority_name: string | null;
};

export const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--muted)",
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5, display: "block"
};
export const fieldStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", border: "1px solid var(--border)",
  borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)",
  fontSize: 13, boxSizing: "border-box"
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export function SignatureCanvas({ onChange, initialDataUrl }: { onChange: (dataUrl: string | null) => void; initialDataUrl?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    if (!initialDataUrl) return;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      hasInk.current = true;
    };
    img.src = initialDataUrl;
    // Only meant to seed the canvas once, when a saved signature first loads
    // (e.g. after the async fetch resolves) - not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataUrl]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInk.current = true;
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(hasInk.current ? canvasRef.current!.toDataURL("image/png") : null);
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={420}
        height={140}
        style={{ width: "100%", maxWidth: 420, height: 140, border: "1px dashed var(--border)", borderRadius: 8, background: "#fff", touchAction: "none", cursor: "crosshair" }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" onClick={clear} style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
        <Eraser size={12} /> Clear
      </button>
    </div>
  );
}

export default function SignDocument() {
  const me = getUserFromToken();
  const isAdmin = me?.role === "ADMIN";
  // Company-wide directory, available to any authenticated user - the
  // admin-only staff list (useStaffDirectory) 403s for a regular signer.
  const [companyDirectory, setCompanyDirectory] = useState<DirectoryUser[]>([]);
  useEffect(() => {
    api.requestDirectory("company").then((rows: any[]) => setCompanyDirectory(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);
  const directory: DirectoryUser[] = companyDirectory.filter((s) => s.id !== me?.userId);

  const [mode, setMode] = useState<"quick" | "routing" | "annotate" | "performance">(() => (
    new URLSearchParams(window.location.search).get("signDoc") ? "routing" : "quick"
  ));

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [signMode, setSignMode] = useState<"type" | "draw" | "upload">("type");
  // A picture of the signature someone uploaded (see SignatureUpload).
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string | null>(null);
  const [typedName, setTypedName] = useState(me?.fullName || "");
  const [drawnDataUrl, setDrawnDataUrl] = useState<string | null>(null);
  const [onBehalfOf, setOnBehalfOf] = useState(false);
  const [authorityUserId, setAuthorityUserId] = useState("");
  const [requestedNotation, setRequestedNotation] = useState<"AI" | "PP">("PP");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; verificationCode: string } | null>(null);
  const [error, setError] = useState("");
  // Where the signature goes: the usual block at the bottom of the last
  // page, or wherever the signer clicks and drags it on the document.
  const [placement, setPlacement] = useState<"bottom" | "custom">("bottom");
  const [placePos, setPlacePos] = useState<PlacePosition | null>(null);
  const [markWidthPct, setMarkWidthPct] = useState(0.2);

  const [policy, setPolicy] = useState<{ default: "AI" | "PP"; overridable: boolean } | null>(null);
  const [mine, setMine] = useState<SignatureRow[]>([]);
  // Routed documents I've signed (from /signatures/documents/mine), listed
  // with the one-off ones so "Documents you've signed" is complete.
  const [routedSigned, setRoutedSigned] = useState<Array<{ id: string; title: string; status: string; my_signed_at: string; created_by_name: string | null; created_by_me: boolean }>>([]);
  const [loadingMine, setLoadingMine] = useState(true);

  const [adminNotation, setAdminNotation] = useState<"AI" | "PP">("PP");
  const [adminOverridable, setAdminOverridable] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  // The saved signature is a convenience cache only — canvasSeed feeds the
  // canvas once on load and is never touched again, so it doesn't fight
  // with the user's own strokes as drawnDataUrl updates on every stroke.
  const [hasSavedSignature, setHasSavedSignature] = useState(false);
  const [canvasSeed, setCanvasSeed] = useState<string | null>(null);
  const [rememberSignature, setRememberSignature] = useState(true);

  const loadMine = useCallback(async () => {
    setLoadingMine(true);
    try {
      const [resp, routed] = await Promise.all([api.mySignatures(), api.mySignableDocuments().catch(() => ({ items: [] }))]);
      setMine(Array.isArray(resp?.items) ? resp.items : []);
      setRoutedSigned((Array.isArray(routed?.items) ? routed.items : []).filter((d: any) => d.my_signed_at));
    } catch {
      // non-critical — the signing form above still works without history
    } finally {
      setLoadingMine(false);
    }
  }, []);

  useEffect(() => {
    void loadMine();
    api.signatureNotationPolicy().then((p) => {
      setPolicy(p);
      setRequestedNotation(p.default);
      setAdminNotation(p.default);
      setAdminOverridable(Boolean(p.overridable));
    }).catch(() => {});
    api.mySavedSignature().then((saved) => {
      if (!saved) return;
      setHasSavedSignature(true);
      setSignMode(saved.signatureType);
      if (saved.signatureType === "type") setTypedName(saved.typedName || me?.fullName || "");
      if (saved.signatureType === "draw" && saved.imageDataUrl) {
        setDrawnDataUrl(saved.imageDataUrl);
        setCanvasSeed(saved.imageDataUrl);
      }
    }).catch(() => {});
  }, [loadMine]);

  async function handleForgetSignature() {
    try {
      await api.clearMySavedSignature();
      setHasSavedSignature(false);
      setCanvasSeed(null);
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  function resetForm() {
    setFile(null);
    setPlacePos(null);
    setTitle("");
    setConsentChecked(false);
    setOnBehalfOf(false);
    setAuthorityUserId("");
    // Signature itself (typedName / drawnDataUrl / signMode) deliberately
    // carries over into the next document instead of resetting — that's
    // the whole point of remembering it.
  }

  async function handleSubmit() {
    setError("");
    if (!file) { setError("Choose a PDF to sign."); return; }
    if (!title.trim()) { setError("Give this document a title."); return; }
    if (!consentChecked) { setError("You must confirm consent to sign electronically."); return; }
    if (signMode === "type" && !typedName.trim()) { setError("Type your name to sign."); return; }
    if (signMode === "draw" && !drawnDataUrl) { setError("Draw your signature."); return; }
    if (signMode === "upload" && !uploadedDataUrl) { setError("Upload a picture of your signature."); return; }
    if (onBehalfOf && !authorityUserId) { setError("Choose whose authority you're signing under."); return; }
    if (placement === "custom" && !placePos) { setError("Click on the document where your signature should go."); return; }

    const authority = directory.find((u) => u.id === authorityUserId);
    const consentStatement = `I, ${me?.fullName || "the signer"}, confirm this is my legal signature and I consent to sign this document electronically on ${new Date().toLocaleDateString("en-GB")}.`;

    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim());
    form.append("consentStatement", consentStatement);
    if (signMode === "type") form.append("typedSignatureText", typedName.trim());
    if (signMode === "draw" && drawnDataUrl) form.append("signatureImageDataUrl", drawnDataUrl);
    if (signMode === "upload" && uploadedDataUrl) form.append("signatureImageDataUrl", uploadedDataUrl);
    if (onBehalfOf && authority) {
      form.append("authorityUserId", authority.id);
      if (policy?.overridable) form.append("requestedNotation", requestedNotation);
    }
    if (placement === "custom" && placePos) {
      form.append("pageNumber", String(placePos.pageNumber));
      form.append("xPct", String(placePos.xPct));
      form.append("yPct", String(placePos.yPct));
      form.append("widthPct", String(markWidthPct));
    }

    setSubmitting(true);
    try {
      const resp = await api.uploadAndSignDocument(form);
      setResult({ id: resp.id, verificationCode: resp.verificationCode });
      if (rememberSignature) {
        await api.saveMySavedSignature({
          signatureType: signMode === "type" ? "type" : "draw",
          typedName: signMode === "type" ? typedName.trim() : null,
          imageDataUrl: signMode === "draw" ? drawnDataUrl : signMode === "upload" ? uploadedDataUrl : null
        }).then(() => setHasSavedSignature(true)).catch(() => {});
      }
      resetForm();
      await loadMine();
    } catch (e: any) {
      setError(e.message || "Failed to sign document.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      const p = await api.updateSignatureNotationPolicy({ notation: adminNotation, overridable: adminOverridable });
      setPolicy(p);
    } catch (e: any) {
      alert("Error saving settings: " + e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  const activeNotation = onBehalfOf ? (policy?.overridable ? requestedNotation : policy?.default) : null;

  return (
    <div style={{ padding: 24, maxWidth: mode === "quick" ? (placement === "custom" && file ? 1200 : 920) : 1500 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <FileSignature size={22} color="#3b82f6" />
        <div style={{ fontWeight: 700, fontSize: 20, color: "var(--text)" }}>Sign a Document</div>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
        {mode === "quick"
          ? "Upload a PDF, sign it electronically, and get back a stamped copy with a public verification code anyone can check — no FlowDesk account required to verify."
          : mode === "routing"
          ? "Ask several people to sign a document in turn, each placing their mark exactly where it belongs on the page — for example a multi-manager sign-off form."
          : mode === "performance"
          ? "How much gets signed, how fast documents get fully signed, and who documents are waiting on — across the web portal and the mobile app."
          : "Add text anywhere on a PDF before signing or sending it — no signing, no sharing, just a quick fix."}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        <button type="button" onClick={() => setMode("quick")} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: mode === "quick" ? "1px solid #3b82f6" : "1px solid var(--border)", background: mode === "quick" ? "#eff6ff" : "var(--surface-soft)", color: mode === "quick" ? "#1d4ed8" : "var(--text)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <FileSignature size={13} /> Quick Sign
        </button>
        <button type="button" onClick={() => setMode("routing")} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: mode === "routing" ? "1px solid #3b82f6" : "1px solid var(--border)", background: mode === "routing" ? "#eff6ff" : "var(--surface-soft)", color: mode === "routing" ? "#1d4ed8" : "var(--text)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <Send size={13} /> Request Signature (multi-signer)
        </button>
        <button type="button" onClick={() => setMode("annotate")} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: mode === "annotate" ? "1px solid #3b82f6" : "1px solid var(--border)", background: mode === "annotate" ? "#eff6ff" : "var(--surface-soft)", color: mode === "annotate" ? "#1d4ed8" : "var(--text)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <PenLine size={13} /> Add Text to PDF
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setMode("performance")} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: mode === "performance" ? "1px solid #3b82f6" : "1px solid var(--border)", background: mode === "performance" ? "#eff6ff" : "var(--surface-soft)", color: mode === "performance" ? "#1d4ed8" : "var(--text)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <BarChart3 size={13} /> Performance
          </button>
        )}
      </div>

      {mode === "performance" && isAdmin ? (
        <SignPerformance />
      ) : mode === "routing" ? (
        <SignRoutingDocument />
      ) : mode === "annotate" ? (
        <PdfTextEditor />
      ) : (
      <>
      {result && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 8, background: "#ecfdf5", border: "1px solid #34d399", marginBottom: 18, flexWrap: "wrap" }}>
          <CheckCircle2 size={18} color="#059669" />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: "#065f46" }}>Document signed — verification code {result.verificationCode}</div>
            <div style={{ fontSize: 11, color: "#065f46" }}>Anyone holding this document can verify it publicly using this code.</div>
          </div>
          <button
            onClick={() => { navigator.clipboard?.writeText(result.verificationCode).catch(() => {}); }}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid #34d399", borderRadius: 6, background: "#fff", color: "#065f46", cursor: "pointer", fontSize: 12 }}
          >
            <Copy size={12} /> Copy code
          </button>
          <button
            onClick={() => openBlobInNewTab(() => api.signatureFileBlob(result.id))}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "none", borderRadius: 6, background: "#059669", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            <Eye size={12} /> View signed PDF
          </button>
        </div>
      )}

      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Document title">
            <input style={fieldStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Vendor NDA — Acme Ltd" />
          </Field>
          <Field label="PDF file">
            <label style={{
              ...fieldStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
              border: file ? "1px solid #34d399" : "1px dashed var(--border)",
              background: file ? "#ecfdf5" : "var(--surface-soft)"
            }}>
              {file ? <CheckCircle2 size={14} color="#059669" /> : <Upload size={14} />}
              <span style={{ flex: 1, color: file ? "#065f46" : "inherit", fontWeight: file ? 600 : 400 }}>
                {file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB) — attached` : "Choose a PDF…"}
              </span>
              <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => { setFile(e.target.files?.[0] || null); setPlacePos(null); }} />
            </label>
          </Field>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <label style={labelStyle}>Your signature</label>
            {hasSavedSignature && (
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#059669" }}><BookmarkCheck size={12} /> Loaded your saved signature</span>
                <button type="button" onClick={handleForgetSignature} style={{ display: "flex", alignItems: "center", gap: 4, border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11, padding: 0 }}>
                  <XCircle size={12} /> Forget
                </button>
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            {(["type", "draw", "upload"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSignMode(m)}
                style={{
                  padding: "6px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  border: signMode === m ? "1px solid #3b82f6" : "1px solid var(--border)",
                  background: signMode === m ? "#eff6ff" : "var(--surface-soft)",
                  color: signMode === m ? "#1d4ed8" : "var(--text)", fontWeight: 600
                }}
              >
                {m === "type" ? "Type my name" : m === "draw" ? "Draw signature" : "Upload signature"}
              </button>
            ))}
          </div>
          {signMode === "type" ? (
            <input style={{ ...fieldStyle, maxWidth: 420, fontFamily: "'Brush Script MT', cursive", fontSize: 22 }} value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Your full name" />
          ) : signMode === "draw" ? (
            <SignatureCanvas key={canvasSeed ? "seeded" : "blank"} onChange={setDrawnDataUrl} initialDataUrl={canvasSeed} />
          ) : (
            <SignatureUpload value={uploadedDataUrl} onChange={setUploadedDataUrl} />
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)", marginTop: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={rememberSignature} onChange={(e) => setRememberSignature(e.target.checked)} />
            Remember this signature for next time
          </label>
        </div>

        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={onBehalfOf} onChange={(e) => setOnBehalfOf(e.target.checked)} />
            I'm signing on behalf of someone else's authority (delegated signature)
          </label>
          {onBehalfOf && (
            <div style={{ display: "grid", gridTemplateColumns: policy?.overridable ? "1fr auto" : "1fr", gap: 10, marginTop: 10, alignItems: "end" }}>
              <Field label="Whose authority">
                <ApproverCombobox users={directory} value={authorityUserId} onChange={setAuthorityUserId} />
              </Field>
              {policy?.overridable && (
                <Field label="Notation">
                  <select style={fieldStyle} value={requestedNotation} onChange={(e) => setRequestedNotation(e.target.value as "AI" | "PP")}>
                    <option value="AI">a.i. (ad interim)</option>
                    <option value="PP">p.p. (per procurationem)</option>
                  </select>
                </Field>
              )}
            </div>
          )}
          {onBehalfOf && activeNotation && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
              The signature block will read: "{typedName || me?.fullName}, {activeNotation === "AI" ? "a.i." : "p.p."} for {directory.find((u) => u.id === authorityUserId)?.full_name || "…"}"
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Where to sign</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {([["bottom", "Bottom of the last page"], ["custom", "Place it myself"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setPlacement(k)}
                style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontWeight: 600,
                  border: placement === k ? "1px solid #3b82f6" : "1px solid var(--border)",
                  background: placement === k ? "#eff6ff" : "var(--surface-soft)", color: placement === k ? "#1d4ed8" : "var(--text)" }}>
                {label}
              </button>
            ))}
          </div>
          {placement === "custom" && (
            !file ? (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Choose the PDF above, then click on it where your signature should go.</div>
            ) : (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 8 }}>
                  Size
                  <input type="range" min={0.08} max={0.35} step={0.01} value={markWidthPct} onChange={(e) => setMarkWidthPct(Number(e.target.value))} style={{ width: 160 }} />
                </label>
                <PdfPlacePicker
                  file={file}
                  widthPct={markWidthPct}
                  value={placePos}
                  onChange={setPlacePos}
                  renderMark={(boxW, boxH, pageScale) => (
                    <SignatureMarkPreview boxW={boxW} boxH={boxH} pageScale={pageScale}
                      name={`${me?.fullName || "Your name"}${onBehalfOf && activeNotation ? ` (${activeNotation === "AI" ? "a.i." : "p.p."})` : ""}`}
                      signMode={signMode === "type" ? "type" : "draw"} typedName={typedName} drawnDataUrl={signMode === "upload" ? uploadedDataUrl : drawnDataUrl} />
                  )}
                />
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>The verification code goes in the page footer.</div>
              </div>
            )
          )}
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} style={{ marginTop: 2 }} />
          I confirm this is my legal signature and I consent to sign this document electronically.
        </label>

        {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}

        <div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 18px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: submitting ? "default" : "pointer", fontSize: 13, fontWeight: 600, opacity: submitting ? 0.7 : 1 }}
          >
            <FileSignature size={14} /> {submitting ? "Signing…" : "Sign document"}
          </button>
        </div>
      </div>

      {isAdmin && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, marginTop: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>
            <ShieldCheck size={16} /> Delegated signature notation policy
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
            Controls how a delegated signature is labelled org-wide, and whether a signer can change it per signature.
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "end", flexWrap: "wrap" }}>
            <Field label="Default notation">
              <select style={fieldStyle} value={adminNotation} onChange={(e) => setAdminNotation(e.target.value as "AI" | "PP")}>
                <option value="AI">a.i. (ad interim)</option>
                <option value="PP">p.p. (per procurationem)</option>
              </select>
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, paddingBottom: 8 }}>
              <input type="checkbox" checked={adminOverridable} onChange={(e) => setAdminOverridable(e.target.checked)} />
              Let the signer override this per signature
            </label>
            <button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              style={{ padding: "8px 16px", border: "none", borderRadius: 7, background: "#111827", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 2 }}
            >
              {savingSettings ? "Saving…" : "Save policy"}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 10 }}>Documents you've signed</div>
        {loadingMine ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div>
        ) : mine.length === 0 && routedSigned.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Nothing signed yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {routedSigned.map((d) => (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                    {d.title}
                    <span style={{ fontSize: 10, fontWeight: 700, color: d.status === "COMPLETED" ? "#059669" : d.status === "REJECTED" ? "#dc2626" : "#92400e", background: d.status === "COMPLETED" ? "#ecfdf5" : d.status === "REJECTED" ? "#fef2f2" : "#fef3e2", padding: "2px 7px", borderRadius: 10 }}>
                      {d.status === "COMPLETED" ? "COMPLETED" : d.status === "REJECTED" ? "REJECTED" : "IN PROGRESS"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    Signed {new Date(d.my_signed_at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {d.created_by_me ? " · sent by you" : ` · from ${d.created_by_name || "someone"}`}
                  </div>
                </div>
                <button
                  onClick={() => {
                    // Request signature mode opens ?signDoc=<id> when it mounts.
                    const url = new URL(window.location.href);
                    url.searchParams.set("signDoc", d.id);
                    window.history.replaceState(null, "", url.toString());
                    setMode("routing");
                  }}
                  style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
                >
                  Open
                </button>
              </div>
            ))}
            {mine.map((row) => (
              <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{row.title}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {new Date(row.signed_at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {row.authority_name ? ` · ${row.delegation_notation === "AI" ? "a.i." : "p.p."} for ${row.authority_name}` : ""}
                  </div>
                </div>
                <code style={{ fontSize: 11, color: "var(--muted)" }}>{row.verification_code}</code>
                <button onClick={() => openBlobInNewTab(() => api.signatureFileBlob(row.id))} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                  <Download size={12} /> Download
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
