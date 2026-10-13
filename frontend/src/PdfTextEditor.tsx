import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - Vite's ?url suffix resolves to the built worker's asset URL
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, downloadBlob } from "./api";
import { Field, fieldStyle, labelStyle } from "./SignDocument";
import { Upload, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Type, Trash2, Download, MousePointerClick, Undo2, Maximize2, Minimize2 } from "lucide-react";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// A small "add text to an existing PDF" tool — click a spot, type
// something, repeat, then download. Nothing is uploaded until the final
// download; there's no persistence, no signing, no sharing — this is
// deliberately a light utility, not a full editor.

type TextAnnotation = {
  id: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
  text: string;
  fontSize: number;
  color: string;
};

const COLORS = ["#111827", "#dc2626", "#1d4ed8", "#059669", "#ea580c"];

export default function PdfTextEditor() {
  const [file, setFile] = useState<File | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<any>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum, zoom);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, zoom]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await containerRef.current?.requestFullscreen();
    }
  }

  const [annotations, setAnnotations] = useState<TextAnnotation[]>([]);
  const [pendingClick, setPendingClick] = useState<{ xPct: number; yPct: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftSize, setDraftSize] = useState(14);
  const [draftColor, setDraftColor] = useState(COLORS[0]);

  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  async function renderPage(pdf: any, page: number, zoomOverride?: number) {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const pdfPage = await pdf.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const targetWidth = Math.min(container.clientWidth || 1000, 1500) * (zoomOverride ?? zoom);
    const viewport = pdfPage.getViewport({ scale: targetWidth / unscaled.width });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // Pins the rendered CSS box to the canvas's own pixel size - otherwise
    // the surrounding flex/grid layout can stretch or squeeze it (e.g. a
    // scrollbar appearing once a tall page overflows), which silently
    // breaks click-position math since getBoundingClientRect() would then
    // report a box that doesn't match what was actually rendered.
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d")!;
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    setPageNum(page);
  }

  async function handleFile(f: File) {
    setFile(f);
    setAnnotations([]);
    setPendingClick(null);
    setZoom(1);
    setError("");
    setBusy(true);
    try {
      const buf = await f.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      await renderPage(pdf, 1);
    } catch {
      setError("Couldn't open that PDF.");
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function goToPage(page: number) {
    if (!pdfDocRef.current || page < 1 || page > numPages) return;
    setPendingClick(null);
    await renderPage(pdfDocRef.current, page);
  }

  async function changeZoom(next: number) {
    const clamped = Math.min(2.5, Math.max(0.5, Math.round(next * 20) / 20));
    setZoom(clamped);
    if (pdfDocRef.current) {
      setPendingClick(null);
      await renderPage(pdfDocRef.current, pageNum, clamped);
    }
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setPendingClick({
      xPct: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
      yPct: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    });
    setDraftText("");
  }

  function addAnnotation() {
    if (!pendingClick || !draftText.trim()) return;
    setAnnotations((prev) => [...prev, {
      id: `${Date.now()}-${Math.random()}`, pageNumber: pageNum,
      xPct: pendingClick.xPct, yPct: pendingClick.yPct,
      text: draftText, fontSize: draftSize, color: draftColor
    }]);
    setPendingClick(null);
    setDraftText("");
  }

  function removeAnnotation(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }

  function undoLastAnnotation() {
    setAnnotations((prev) => prev.slice(0, -1));
  }

  function clearAllAnnotations() {
    setAnnotations([]);
  }

  async function handleDownload() {
    if (!file) return;
    if (annotations.length === 0) { setError("Add at least one piece of text first."); return; }
    setError("");
    setDownloading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("annotations", JSON.stringify(annotations.map(({ id, ...a }) => a)));
      await downloadBlob(() => api.annotatePdf(form), `${file.name.replace(/\.pdf$/i, "")}-edited.pdf`);
    } catch (e: any) {
      setError(e.message || "Failed to save the edited PDF.");
    } finally {
      setDownloading(false);
    }
  }

  const pageAnnotations = annotations.filter((a) => a.pageNumber === pageNum);

  return (
    <div>
      {!file ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, maxWidth: 420 }}>
          <label style={{ ...fieldStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", justifyContent: "center", padding: "20px 10px" }}>
            <Upload size={16} />
            Choose a PDF to add text to…
            <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          </label>
          {error && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 8 }}>{error}</div>}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 320px)", gap: 16, alignItems: "start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", marginBottom: 8, flexWrap: "wrap" }}>
              <MousePointerClick size={13} /> Click anywhere on the page to add text
              <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => void changeZoom(zoom - 0.15)} disabled={zoom <= 0.5} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ZoomOut size={13} /></button>
                  {Math.round(zoom * 100)}%
                  <button onClick={() => void changeZoom(zoom + 0.15)} disabled={zoom >= 2.5} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ZoomIn size={13} /></button>
                  <button onClick={() => void toggleFullscreen()} title={isFullscreen ? "Exit full screen" : "Full screen"} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}>
                    {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                </span>
                {numPages > 1 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => void goToPage(pageNum - 1)} disabled={pageNum <= 1} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronLeft size={13} /></button>
                    Page {pageNum} / {numPages}
                    <button onClick={() => void goToPage(pageNum + 1)} disabled={pageNum >= numPages} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronRight size={13} /></button>
                  </span>
                )}
              </span>
            </div>
            <div ref={containerRef} style={{ position: "relative", border: "1px solid var(--border)", borderRadius: 8, overflow: "auto", maxHeight: isFullscreen ? "100vh" : "80vh", background: "#525659", display: "flex", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
              <div style={{ position: "relative" }}>
                <canvas ref={canvasRef} onClick={handleCanvasClick} style={{ cursor: "text", display: "block" }} />
                {pageAnnotations.map((a) => (
                  <div key={a.id} style={{ position: "absolute", left: `${a.xPct * 100}%`, top: `${a.yPct * 100}%`, fontSize: a.fontSize, color: a.color, fontFamily: "Helvetica, Arial, sans-serif", whiteSpace: "pre", pointerEvents: "none", lineHeight: 1.25 }}>
                    {a.text}
                  </div>
                ))}
                {pendingClick && (
                  <div style={{ position: "absolute", left: `${pendingClick.xPct * 100}%`, top: `${pendingClick.yPct * 100}%`, width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: "50%", background: "#3b82f6", border: "2px solid #fff", boxShadow: "0 0 0 1px #3b82f6" }} />
                )}
              </div>
            </div>

            {annotations.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: "var(--text)" }}>Text added ({annotations.length})</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={undoLastAnnotation} style={{ display: "flex", alignItems: "center", gap: 4, border: "none", background: "none", color: "#1d4ed8", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: 0 }}>
                      <Undo2 size={12} /> Undo
                    </button>
                    <button onClick={clearAllAnnotations} style={{ display: "flex", alignItems: "center", gap: 4, border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: 0 }}>
                      <Trash2 size={12} /> Clear all
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {annotations.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>"{a.text}" — page {a.pageNumber}</span>
                      <button onClick={() => removeAnnotation(a.id)} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", display: "flex" }}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {pendingClick ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}><Type size={14} /> Add text</div>
                <Field label="Text">
                  <textarea autoFocus style={{ ...fieldStyle, minHeight: 60, resize: "vertical" }} value={draftText} onChange={(e) => setDraftText(e.target.value)} placeholder="Type here…" />
                </Field>
                <Field label="Size">
                  <input type="range" min={8} max={36} step={1} value={draftSize} onChange={(e) => setDraftSize(Number(e.target.value))} />
                </Field>
                <div>
                  <label style={labelStyle}>Color</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {COLORS.map((c) => (
                      <button key={c} onClick={() => setDraftColor(c)} style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: draftColor === c ? "2px solid var(--text)" : "1px solid var(--border)", cursor: "pointer" }} />
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addAnnotation} disabled={!draftText.trim()} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: draftText.trim() ? 1 : 0.6 }}>
                    Add
                  </button>
                  <button onClick={() => setPendingClick(null)} style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Click a spot on the page to add text there.</div>
            )}

            {error && <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}

            <button onClick={handleDownload} disabled={downloading || annotations.length === 0} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 12px", border: "none", borderRadius: 7, background: "#059669", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: downloading || annotations.length === 0 ? 0.6 : 1 }}>
              <Download size={13} /> {downloading ? "Saving…" : "Download edited PDF"}
            </button>

            <button onClick={() => { setFile(null); pdfDocRef.current = null; }} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
              Choose a different PDF
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
