import { useEffect, useRef, useState, type ReactNode } from "react";
import { openPdf, type PdfDoc } from "../pdf";
import type { Placement, Position } from "../api";

// Shows one PDF page at a time, fitted to the phone's width. With onChange
// it's also the "where does my signature go" picker: tap to drop the box,
// drag it to adjust. Positions are the box's TOP-LEFT corner as a fraction
// of the page, and the box is widthPct of the page wide at 2.6:1 - the same
// convention the server's signature stamp uses (signatureStamp.ts), so what
// you see is where it's stamped.

export const MARK_RATIO = 2.6;

export default function PdfPlacer({ data, widthPct = 0.18, value = null, onChange, mark, placements = [], startOnLastPage = false }: {
  data: ArrayBuffer;
  widthPct?: number;
  value?: Position | null;
  onChange?: (pos: Position | null) => void;
  /** Drawn inside the box: (box width px, box height px, px per PDF point). */
  mark?: (boxW: number, boxH: number, scale: number) => ReactNode;
  /** Signatures already on the document, outlined so the next signer avoids them. */
  placements?: Placement[];
  startOnLastPage?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<{ cancel: () => void } | null>(null);
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const numPages = pdf?.numPages ?? 0;
  const [size, setSize] = useState({ width: 0, height: 0, scale: 1 });
  const [error, setError] = useState("");
  const [width, setWidth] = useState(0);

  // Track the available width so rotating the phone re-renders sharply.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError("");
    openPdf(data)
      .then((doc) => {
        if (cancelled) return;
        setPdf(doc);
        setPage(startOnLastPage ? doc.numPages : 1);
      })
      .catch(() => !cancelled && setError("Couldn't open this PDF."));
    return () => {
      cancelled = true;
    };
  }, [data, startOnLastPage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas || !width) return;
    let cancelled = false;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const scale = width / p.getViewport({ scale: 1 }).width;
      const vp = p.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      setSize({ width: vp.width, height: vp.height, scale });
      taskRef.current?.cancel();
      const task = p.render({ canvasContext: canvas.getContext("2d")!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      taskRef.current = task;
      await task.promise.catch(() => {
        // Cancelled by a newer render - expected.
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, page, width]);

  const boxW = widthPct * size.width;
  const boxH = boxW / MARK_RATIO;
  const hPct = size.height ? boxH / size.height : 0;

  const clamp = (x: number, y: number): Position => ({
    pageNumber: page,
    xPct: Math.min(Math.max(x, 0), Math.max(0, 1 - widthPct)),
    yPct: Math.min(Math.max(y, 0), Math.max(0, 1 - hPct))
  });
  const toPct = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };

  // Keep the box on the page when the size slider grows it.
  useEffect(() => {
    if (value && onChange) {
      const c = clamp(value.xPct, value.yPct);
      if (c.xPct !== value.xPct || c.yPct !== value.yPct) onChange(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthPct, size.width]);

  function onTap(e: React.MouseEvent) {
    if (!onChange) return;
    const p = toPct(e.clientX, e.clientY);
    // Centre the box on the finger - a top-left drop feels off on a phone.
    onChange(clamp(p.x - widthPct / 2, p.y - hPct / 2));
  }

  function startDrag(e: React.PointerEvent) {
    if (!value || !onChange) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toPct(e.clientX, e.clientY);
    const off = { x: start.x - value.xPct, y: start.y - value.yPct };
    const move = (ev: PointerEvent) => {
      const p = toPct(ev.clientX, ev.clientY);
      onChange(clamp(p.x - off.x, p.y - off.y));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function goTo(n: number) {
    if (n < 1 || n > numPages) return;
    setPage(n);
    if (value && value.pageNumber !== n) onChange?.(null);
  }

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="pdf">
      <div className="pdf-bar">
        <span className="muted small">
          {onChange ? (value && value.pageNumber === page ? "Drag your signature into place." : "Tap where your signature goes.") : `Page ${page} of ${numPages || "…"}`}
        </span>
        {numPages > 1 && (
          <span className="pager">
            <button type="button" className="icon-btn" onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
            <span className="small">{page}/{numPages}</span>
            <button type="button" className="icon-btn" onClick={() => goTo(page + 1)} disabled={page >= numPages} aria-label="Next page">›</button>
          </span>
        )}
      </div>
      <div ref={wrapRef} className="pdf-page">
        <div className="pdf-canvas-wrap">
          <canvas ref={canvasRef} onClick={onTap} className={onChange ? "placeable" : undefined} />
          {size.width > 0 &&
            placements
              .filter((p) => p.pageNumber === page)
              .map((p) => (
                <div key={p.id} className="existing-mark" style={{ left: p.xPct * size.width, top: p.yPct * size.height }}>
                  {p.signerName}
                </div>
              ))}
          {value && value.pageNumber === page && size.width > 0 && (
            <div className="place-box" onPointerDown={startDrag} style={{ left: value.xPct * size.width, top: value.yPct * size.height, width: boxW, height: boxH }}>
              {mark?.(boxW, boxH, size.scale)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
