import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderPdfPage, type RenderTaskRef } from "../shared/pdfRender";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight } from "lucide-react";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Shows a local PDF (before upload) so the signer can click where their
// signature goes and drag it into place. The position is the box's TOP-LEFT
// corner as a fraction of the page - the same convention the server's
// stampSignatureMarkAtPosition uses - and the box is widthPct of the page
// wide with a 2.6:1 ratio, exactly as stamped.

export type PlacePosition = { pageNumber: number; xPct: number; yPct: number };

export default function PdfPlacePicker({ file, widthPct, value, onChange, renderMark }: {
  file: File;
  widthPct: number;
  value: PlacePosition | null;
  onChange: (pos: PlacePosition | null) => void;
  // Draws the signature inside the box: (box width px, box height px, px per PDF point).
  renderMark: (boxW: number, boxH: number, pageScale: number) => ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<any>(null);
  const renderTaskRef: RenderTaskRef = useRef(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0, scale: 1 });
  const [error, setError] = useState("");

  async function render(pdf: any, n: number) {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !pdf) return;
    const p = await pdf.getPage(n);
    const unscaled = p.getViewport({ scale: 1 });
    const scale = Math.min(wrap.clientWidth || 800, 1100) / unscaled.width;
    const vp = p.getViewport({ scale });
    setSize({ width: vp.width, height: vp.height, scale });
    await renderPdfPage(p, canvas, vp, renderTaskRef);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        // Start on the last page - where signatures usually go.
        setPage(pdf.numPages);
        await render(pdf, pdf.numPages);
        setError("");
      } catch {
        if (!cancelled) setError("Couldn't open this PDF to place the signature.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  async function goTo(n: number) {
    if (!pdfRef.current || n < 1 || n > numPages) return;
    setPage(n);
    if (value && value.pageNumber !== n) onChange(null);
    await render(pdfRef.current, n);
  }

  const boxW = widthPct * size.width;
  const boxH = boxW / 2.6;
  const hPct = size.height ? boxH / size.height : 0;
  const clamp = (x: number, y: number): PlacePosition => ({
    pageNumber: page,
    xPct: Math.min(Math.max(x, 0), 1 - widthPct),
    yPct: Math.min(Math.max(y, 0), 1 - hPct)
  });
  const pct = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };

  function onCanvasClick(e: React.MouseEvent) {
    const p = pct(e.clientX, e.clientY);
    onChange(clamp(p.x, p.y));
  }

  function startDrag(e: React.PointerEvent) {
    if (!value) return;
    e.preventDefault(); e.stopPropagation();
    const start = pct(e.clientX, e.clientY);
    const off = { x: start.x - value.xPct, y: start.y - value.yPct };
    const move = (ev: PointerEvent) => { const p = pct(ev.clientX, ev.clientY); onChange(clamp(p.x - off.x, p.y - off.y)); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Keep the box on the page if the size slider grows it.
  useEffect(() => {
    if (value && (value.xPct > 1 - widthPct || value.yPct > 1 - hPct)) onChange(clamp(value.xPct, value.yPct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthPct]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 12, color: "var(--muted)" }}>
        <span>{value && value.pageNumber === page ? "Drag your signature to the right spot." : "Click where your signature should go."}</span>
        {numPages > 1 && (
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => void goTo(page - 1)} disabled={page <= 1} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronLeft size={13} /></button>
            Page {page} of {numPages}
            <button type="button" onClick={() => void goTo(page + 1)} disabled={page >= numPages} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronRight size={13} /></button>
          </span>
        )}
      </div>
      {error ? <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div> : (
        <div ref={wrapRef} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "#525659", overflow: "auto", maxHeight: "70vh", display: "flex", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <canvas ref={canvasRef} onClick={onCanvasClick} style={{ display: "block", cursor: "crosshair" }} />
            {value && value.pageNumber === page && size.width > 0 && (
              <div onPointerDown={startDrag} title="Drag to move your signature"
                style={{ position: "absolute", left: value.xPct * size.width, top: value.yPct * size.height, width: boxW, height: boxH, border: "1.5px dashed #3b82f6", background: "rgba(255,255,255,0.55)", boxShadow: "0 0 0 3px rgba(59,130,246,0.18)", cursor: "grab", touchAction: "none", overflow: "hidden", borderRadius: 2 }}>
                {renderMark(boxW, boxH, size.scale)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The signature as it will be stamped (signatureStamp.ts): name strip 24%,
// signature 56%, date strip 20%, text sizes in PDF points x page scale.
export function SignatureMarkPreview({ boxW, boxH, pageScale, name, signMode, typedName, drawnDataUrl }: {
  boxW: number; boxH: number; pageScale: number; name: string; signMode: "type" | "draw"; typedName: string; drawnDataUrl: string | null;
}) {
  const nameH = boxH * 0.24, dateH = boxH * 0.2, markH = boxH - nameH - dateH;
  const font = "Helvetica, Arial, sans-serif";
  return (
    <div style={{ width: boxW, height: boxH, pointerEvents: "none" }}>
      <div style={{ height: nameH, fontFamily: font, fontWeight: 700, fontSize: Math.min(nameH * 0.8, 9 * pageScale), lineHeight: `${nameH}px`, color: "#1c296b", whiteSpace: "nowrap" }}>{name}</div>
      <div style={{ height: markH, display: "flex", alignItems: "center", justifyContent: signMode === "draw" ? "center" : "flex-start" }}>
        {signMode === "draw"
          ? (drawnDataUrl ? <img src={drawnDataUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} draggable={false} /> : <span style={{ fontSize: 10, color: "#64748b" }}>Draw your signature</span>)
          : <span style={{ fontFamily: font, fontWeight: 700, fontSize: Math.min(markH * 0.7, 20 * pageScale), color: typedName.trim() ? "#1c296b" : "#94a3b8", whiteSpace: "nowrap" }}>{typedName.trim() || "Your signature"}</span>}
      </div>
      <div style={{ height: dateH, fontFamily: font, fontSize: Math.min(dateH * 0.85, 7.5 * pageScale), lineHeight: `${dateH}px`, color: "#737373" }}>{new Date().toLocaleDateString("en-GB")}</div>
    </div>
  );
}
