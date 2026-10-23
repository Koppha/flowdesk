import { useEffect, useRef } from "react";

const INK = "#1c296b";

// Finger-drawn signature. Reports a PNG data URL cropped to the ink (the
// stamp scales the image into the signature box, so empty margins would
// just make the signature small), or null when cleared.
export default function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
  }, []);

  function point(e: React.PointerEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: React.PointerEvent) {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
    hasInk.current = true;
  }

  function move(e: React.PointerEvent) {
    if (!(e.buttons & 1) && e.pointerType === "mouse") return;
    if (!canvasRef.current!.hasPointerCapture(e.pointerId)) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function up() {
    if (hasInk.current) onChange(cropped(canvasRef.current!));
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    onChange(null);
  }

  return (
    <div className="pad">
      <canvas ref={canvasRef} className="pad-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="pad-foot">
        <span className="muted small">Sign with your finger</span>
        <button type="button" className="link-btn" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}

function cropped(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
