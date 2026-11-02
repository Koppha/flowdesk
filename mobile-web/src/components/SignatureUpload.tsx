import { useEffect, useRef, useState } from "react";

// Upload a picture of your signature (a photo or scan of it on paper) - the
// same processing as the web portal's SignatureUpload (frontend/src/
// components/SignatureUpload.tsx), so a signature uploaded on either one
// looks the same: scaled down, trimmed to the ink, and - unless switched off -
// the paper (white, grey or in shadow) made transparent. The result is saved
// like a drawn signature, which is how web and mobile share it.

const MAX_W = 900;

// The backend's CSP allows data: images but not blob:, so the file is read
// as a data URL (the web version uses a blob: URL).
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that picture."));
    r.readAsDataURL(file);
  });
}

export async function processSignatureImage(file: File, removeWhite: boolean): Promise<string> {
  const src = await readAsDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("That file isn't an image we can read."));
    i.src = src;
  });
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    // Transparent pixels count as white paper.
    lum[i] = 255 - a * (255 - (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]));
  }
  // The paper's brightness around each point: the brightest value in each
  // block (paper is lighter than ink), smoothed - so grey paper, shadows and
  // uneven light are all treated as background.
  const B = Math.max(12, Math.round(Math.max(w, h) / 24));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const blockMax = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = Math.floor(y / B) * bw + Math.floor(x / B);
      if (lum[y * w + x] > blockMax[k]) blockMax[k] = lum[y * w + x];
    }
  }
  const smooth = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy, xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) best = Math.max(best, blockMax[yy * bw + xx]);
        }
      }
      smooth[by * bw + bx] = Math.max(best, 60);
    }
  }
  const paperAt = (x: number, y: number) => {
    // bilinear between block centres
    const fx = Math.min(Math.max(x / B - 0.5, 0), bw - 1), fy = Math.min(Math.max(y / B - 0.5, 0), bh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, bw - 1), y1 = Math.min(y0 + 1, bh - 1);
    const tx = fx - x0, ty = fy - y0;
    const top = smooth[y0 * bw + x0] * (1 - tx) + smooth[y0 * bw + x1] * tx;
    const bot = smooth[y1 * bw + x0] * (1 - tx) + smooth[y1 * bw + x1] * tx;
    return top * (1 - ty) + bot * ty;
  };
  // How much darker than its paper each pixel is: under ~12% darker is paper
  // (grain, faint lines, shadow edges); from ~30% darker it's solid ink.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ratio = lum[i] / paperAt(x, y);
      const ink = Math.min(1, Math.max(0, (0.88 - ratio) / 0.18));
      if (ink > 0.25) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (removeWhite) px[i * 4 + 3] = Math.round(px[i * 4 + 3] * ink);
    }
  }
  ctx.putImageData(data, 0, 0);
  if (maxX < 0) throw new Error("No signature found in that picture - is it blank?");
  const pad = 6;
  const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
  const sw = Math.min(w, maxX + pad + 1) - sx, sh = Math.min(h, maxY + pad + 1) - sy;
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d")!.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL("image/png");
}

export default function SignatureUpload({ value, onChange }: { value: string | null; onChange: (dataUrl: string | null) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setError("");
    setBusy(true);
    processSignatureImage(file, removeWhite)
      .then((d) => !cancelled && onChange(d))
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || "Couldn't read that picture.");
        onChange(null);
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, removeWhite]);

  return (
    <div className="stack-sm">
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
      {value ? (
        <div className="saved-drawing">
          <img src={value} alt="Your uploaded signature" className="checker" />
          <div className="row gap">
            <button type="button" className="link-btn" onClick={() => inputRef.current?.click()}>Choose another</button>
            <button type="button" className="link-btn danger-text" onClick={() => { setFile(null); onChange(null); }}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button" className="photo-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? "Reading the picture…" : "Upload a picture of your signature"}
        </button>
      )}
      {file && (
        <label className="consent small">
          <input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} />
          <span>Remove the background (paper, shadows)</span>
        </label>
      )}
      {!file && !value && <span className="muted small">Sign on white paper, take a photo, and choose it here.</span>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
