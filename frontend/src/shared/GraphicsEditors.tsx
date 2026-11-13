import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

// Charts and diagrams for documents (BRS). Each one is drawn as SVG, turned
// into a PNG and inserted as an <img> - so it shows the same in the editor,
// read-only views and the PDF - and the image carries its own spec in
// data-fd-graphic, so double-clicking it opens the editor again.

// ── Shared ──────────────────────────────────────────────────────────────────
const FONT = "Arial, Helvetica, sans-serif";
const INK = "#0b0b0b";
const INK_2 = "#52514e";
const GRID = "#e5e7eb";
// Categorical colours in fixed order (validated for colour-blind readers on a
// white page); a chart never needs more than eight - the rest fold into "Other".
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const uid = () => Math.random().toString(36).slice(2, 9);

// Wrap text to a width (rough average glyph width for Arial).
function wrap(text: string, maxWidth: number, size: number): string[] {
  const per = Math.max(4, Math.floor(maxWidth / (size * 0.55)));
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if ((line + " " + word).length <= per) line += " " + word;
      else { out.push(line); line = word; }
      while (line.length > per) { out.push(line.slice(0, per)); line = line.slice(per); }
    }
    out.push(line);
  }
  return out;
}

function textBlock(lines: string[], cx: number, cy: number, size: number, color = INK, weight = "normal", anchor = "middle") {
  const lh = size * 1.25;
  const top = cy - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) =>
    `<text x="${cx}" y="${top + i * lh}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central">${esc(l)}</text>`
  ).join("");
}

// SVG -> PNG data URL (2x, white background).
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(width * scale);
      c.height = Math.round(height * scale);
      const ctx = c.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return reject(new Error("No canvas")); }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not draw the graphic")); };
    img.src = url;
  });
}

// ── Charts ──────────────────────────────────────────────────────────────────
export type ChartType = "bar" | "hbar" | "stacked" | "line" | "area" | "pie" | "doughnut";
export type ChartSpec = {
  kind: "chart";
  type: ChartType;
  title: string;
  xLabel: string;
  yLabel: string;
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  showValues: boolean;
  width: number;
  height: number;
};

export const newChart = (): ChartSpec => ({
  kind: "chart", type: "bar", title: "", xLabel: "", yLabel: "",
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [{ name: "Series 1", values: [120, 150, 135, 180] }],
  showValues: false, width: 720, height: 400
});

function niceTicks(min: number, max: number, count = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
const fmt = (v: number) => Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`;

// A bar with a rounded data end (4px) and a square end on the baseline.
function barPath(x: number, y: number, w: number, h: number, dir: "up" | "down" | "right" | "left") {
  const r = Math.min(4, Math.abs(dir === "up" || dir === "down" ? h : w) / 2, (dir === "up" || dir === "down" ? w : h) / 2);
  if (r <= 0.5) return `M${x},${y}h${w}v${h}h${-w}Z`;
  if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  if (dir === "down") return `M${x},${y}H${x + w}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}Z`;
  if (dir === "right") return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
}

export function chartSvg(spec: ChartSpec): { svg: string; width: number; height: number } {
  const W = spec.width, H = spec.height;
  const series = spec.series.slice(0, SERIES_COLORS.length);
  const cats = spec.categories;
  const parts: string[] = [];
  let top = 16;
  if (spec.title.trim()) { parts.push(textBlock([spec.title.trim()], W / 2, top + 8, 16, INK, "bold")); top += 30; }

  const isPie = spec.type === "pie" || spec.type === "doughnut";
  // Legend: always for 2+ series (and for pies, one entry per slice).
  const legendItems = isPie ? [] : series.length > 1 ? series.map((s, i) => ({ name: s.name || `Series ${i + 1}`, color: SERIES_COLORS[i] })) : [];
  if (legendItems.length) {
    let x = 0; const rows: Array<Array<{ name: string; color: string; x: number }>> = [[]];
    for (const it of legendItems) {
      const w = 22 + it.name.length * 6.6 + 16;
      if (x + w > W - 40 && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      rows[rows.length - 1].push({ ...it, x }); x += w;
    }
    for (const row of rows) {
      const rowW = row.reduce((t, it) => t + 22 + it.name.length * 6.6 + 16, 0) - 16;
      const ox = (W - rowW) / 2;
      for (const it of row) {
        parts.push(`<rect x="${ox + it.x}" y="${top + 2}" width="12" height="12" rx="3" fill="${it.color}"/>`);
        parts.push(`<text x="${ox + it.x + 18}" y="${top + 8}" font-family="${FONT}" font-size="12" fill="${INK_2}" dominant-baseline="central">${esc(it.name)}</text>`);
      }
      top += 20;
    }
    top += 6;
  }

  if (isPie) {
    const s0 = series[0] || { name: "", values: [] };
    let slices = cats.map((c, i) => ({ name: c || `Item ${i + 1}`, value: Math.max(0, Number(s0.values[i]) || 0) })).filter((x) => x.value > 0);
    if (slices.length > 7) {
      const sorted = [...slices].sort((a, b) => b.value - a.value);
      slices = [...sorted.slice(0, 6), { name: "Other", value: sorted.slice(6).reduce((t, x) => t + x.value, 0) }];
    }
    const total = slices.reduce((t, x) => t + x.value, 0) || 1;
    const legendW = 220;
    const r = Math.max(40, Math.min((W - legendW - 60) / 2, (H - top - 20) / 2));
    const cx = 30 + r, cy = top + (H - top) / 2;
    let a = -Math.PI / 2;
    slices.forEach((sl, i) => {
      const frac = sl.value / total;
      const a2 = a + frac * Math.PI * 2;
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      if (frac >= 0.9999) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
      else {
        const large = a2 - a > Math.PI ? 1 : 0;
        parts.push(`<path d="M${cx},${cy}L${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)}Z" fill="${color}" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>`);
      }
      if (spec.showValues && frac >= 0.05) {
        const m = (a + a2) / 2, lr = spec.type === "doughnut" ? r * 0.78 : r * 0.62;
        parts.push(`<text x="${cx + lr * Math.cos(m)}" y="${cy + lr * Math.sin(m)}" font-family="${FONT}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${Math.round(frac * 100)}%</text>`);
      }
      a = a2;
    });
    if (spec.type === "doughnut") {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.56}" fill="#ffffff"/>`);
      parts.push(textBlock([fmt(total)], cx, cy - 8, 20, INK, "bold"));
      parts.push(textBlock([s0.name || "Total"], cx, cy + 14, 11, INK_2));
    }
    const lx = cx + r + 40;
    const ly0 = cy - (slices.length * 24) / 2;
    slices.forEach((sl, i) => {
      const y = ly0 + i * 24;
      parts.push(`<rect x="${lx}" y="${y}" width="12" height="12" rx="3" fill="${SERIES_COLORS[i % SERIES_COLORS.length]}"/>`);
      parts.push(`<text x="${lx + 18}" y="${y + 6}" font-family="${FONT}" font-size="12" fill="${INK}" dominant-baseline="central">${esc(sl.name)}</text>`);
      parts.push(`<text x="${W - 16}" y="${y + 6}" font-family="${FONT}" font-size="12" fill="${INK_2}" text-anchor="end" dominant-baseline="central">${fmt(sl.value)} (${Math.round((sl.value / total) * 100)}%)</text>`);
    });
  } else {
    const horizontal = spec.type === "hbar";
    const stacked = spec.type === "stacked";
    const vals = (si: number, ci: number) => Number(series[si]?.values[ci] ?? 0) || 0;
    let lo = 0, hi = 0;
    cats.forEach((_c, ci) => {
      if (stacked) { const sum = series.reduce((t, _s, si) => t + Math.max(0, vals(si, ci)), 0); hi = Math.max(hi, sum); }
      else series.forEach((_s, si) => { lo = Math.min(lo, vals(si, ci)); hi = Math.max(hi, vals(si, ci)); });
    });
    if (spec.type === "line" || spec.type === "area") {
      // Lines don't need zero, but a document reader expects it unless the
      // values sit far from it.
      const nums = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined).map(Number));
      if (nums.length) { const mn = Math.min(...nums); if (mn > 0 && mn > hi * 0.6) lo = mn * 0.9; }
    }
    const ticks = niceTicks(lo, hi);
    const t0 = ticks[0], t1 = ticks[ticks.length - 1];
    const labelW = horizontal ? Math.min(160, Math.max(40, ...cats.map((c) => (c || "").length * 6.4))) : Math.max(...ticks.map((t) => fmt(t).length * 6.6)) + 8;
    const left = 16 + (spec.yLabel.trim() && !horizontal ? 18 : 0) + labelW;
    const bottom = H - 16 - (spec.xLabel.trim() ? 20 : 0) - (horizontal ? 18 : 22);
    const right = W - 20;
    const pw = right - left, ph = bottom - top;
    const scale = (v: number) => (v - t0) / (t1 - t0 || 1);

    // Grid + value axis.
    for (const t of ticks) {
      if (horizontal) {
        const x = left + scale(t) * pw;
        parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${t === 0 ? "#9ca3af" : GRID}" stroke-width="1"/>`);
        parts.push(`<text x="${x}" y="${bottom + 14}" font-family="${FONT}" font-size="11" fill="${INK_2}" text-anchor="middle">${fmt(t)}</text>`);
      } else {
        const y = bottom - scale(t) * ph;
        parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${t === 0 ? "#9ca3af" : GRID}" stroke-width="1"/>`);
        parts.push(`<text x="${left - 8}" y="${y}" font-family="${FONT}" font-size="11" fill="${INK_2}" text-anchor="end" dominant-baseline="central">${fmt(t)}</text>`);
      }
    }
    const n = Math.max(1, cats.length);
    const band = (horizontal ? ph : pw) / n;
    // Category labels (thinned when crowded).
    const every = horizontal ? 1 : Math.max(1, Math.ceil((Math.max(...cats.map((c) => (c || "").length), 1) * 6.4 + 8) / band));
    cats.forEach((c, ci) => {
      if (ci % every) return;
      if (horizontal) {
        const y = top + band * ci + band / 2;
        parts.push(`<text x="${left - 8}" y="${y}" font-family="${FONT}" font-size="11" fill="${INK_2}" text-anchor="end" dominant-baseline="central">${esc((c || "").slice(0, 26))}</text>`);
      } else {
        const x = left + band * ci + band / 2;
        parts.push(`<text x="${x}" y="${bottom + 16}" font-family="${FONT}" font-size="11" fill="${INK_2}" text-anchor="middle">${esc(c || "")}</text>`);
      }
    });
    const base = scale(Math.max(t0, Math.min(0, t1)));
    if (spec.type === "bar" || spec.type === "hbar" || stacked) {
      const groupW = band * 0.72;
      const k = stacked ? 1 : series.length;
      const barW = Math.max(2, (groupW - (k - 1) * 2) / k);
      cats.forEach((_c, ci) => {
        let acc = 0;
        series.forEach((_s, si) => {
          const v = stacked ? Math.max(0, vals(si, ci)) : vals(si, ci);
          if (!v) return;
          const color = SERIES_COLORS[si];
          const off = band * ci + (band - groupW) / 2 + (stacked ? 0 : si * (barW + 2));
          const from = stacked ? scale(acc) : base;
          const to = stacked ? scale(acc + v) : scale(v);
          const isTop = !stacked || si === series.map((_x, j) => j).filter((j) => Math.max(0, vals(j, ci)) > 0).pop();
          acc += v;
          if (horizontal) {
            const x1 = left + Math.min(from, to) * pw, w = Math.abs(to - from) * pw, y = top + off;
            parts.push(`<path d="${barPath(x1, y, Math.max(1, w - (stacked && !isTop ? 2 : 0)), barW, v >= 0 ? "right" : "left")}" fill="${color}"/>`);
            if (spec.showValues) parts.push(`<text x="${v >= 0 ? x1 + w + 4 : x1 - 4}" y="${y + barW / 2}" font-family="${FONT}" font-size="10" fill="${INK}" text-anchor="${v >= 0 ? "start" : "end"}" dominant-baseline="central">${fmt(v)}</text>`);
          } else {
            const y1 = bottom - Math.max(from, to) * ph, h = Math.abs(to - from) * ph, x = left + off;
            const gap = stacked && si > 0 ? 2 : 0;
            if (stacked && !isTop) parts.push(`<rect x="${x}" y="${y1}" width="${barW}" height="${Math.max(1, h - gap)}" fill="${color}"/>`);
            else parts.push(`<path d="${barPath(x, y1, barW, Math.max(1, h - gap), v >= 0 ? "up" : "down")}" fill="${color}"/>`);
            if (spec.showValues && (!stacked || isTop)) {
              const shown = stacked ? acc : v;
              parts.push(`<text x="${x + barW / 2}" y="${v >= 0 ? y1 - 5 : y1 + h + 12}" font-family="${FONT}" font-size="10" fill="${INK}" text-anchor="middle">${fmt(shown)}</text>`);
            }
          }
        });
      });
    } else {
      series.forEach((s, si) => {
        const color = SERIES_COLORS[si];
        const pts = cats.map((_c, ci) => {
          const v = s.values[ci];
          return v === null || v === undefined || (v as any) === "" ? null : { x: left + band * ci + band / 2, y: bottom - scale(Number(v)) * ph, v: Number(v) };
        });
        const segs: Array<Array<{ x: number; y: number; v: number }>> = [[]];
        pts.forEach((p) => { if (p) segs[segs.length - 1].push(p); else if (segs[segs.length - 1].length) segs.push([]); });
        for (const seg of segs.filter((g) => g.length)) {
          const d = seg.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join("");
          if (spec.type === "area" && seg.length > 1) {
            const by = bottom - base * ph;
            parts.push(`<path d="${d}L${seg[seg.length - 1].x},${by}L${seg[0].x},${by}Z" fill="${color}" fill-opacity="${series.length > 1 ? 0.18 : 0.25}"/>`);
          }
          parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
          for (const p of seg) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}" stroke="#ffffff" stroke-width="2"/>`);
        }
        // Values: above the point when it's the highest at that category,
        // below it otherwise - so crossing lines don't print over each other.
        if (spec.showValues) pts.forEach((p, ci) => {
          if (!p) return;
          const others = series.map((q, j) => j === si ? null : q.values[ci]).filter((v) => v !== null && v !== undefined).map(Number);
          const top = others.every((v) => p.v > v || (p.v === v && si === 0));
          parts.push(`<text x="${p.x}" y="${top ? p.y - 10 : p.y + 18}" font-family="${FONT}" font-size="10" fill="${INK}" text-anchor="middle">${fmt(p.v)}</text>`);
        });
      });
    }
    if (spec.xLabel.trim()) parts.push(textBlock([spec.xLabel.trim()], left + pw / 2, H - 14, 12, INK_2));
    if (spec.yLabel.trim() && !horizontal) parts.push(`<text transform="translate(18 ${top + ph / 2}) rotate(-90)" font-family="${FONT}" font-size="12" fill="${INK_2}" text-anchor="middle" dominant-baseline="central">${esc(spec.yLabel.trim())}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${parts.join("")}</svg>`;
  return { svg, width: W, height: H };
}

// Excel / CSV paste -> categories + series (first row = series names, first
// column = categories).
function parseTable(text: string): { categories: string[]; series: ChartSpec["series"] } | null {
  const rows = text.trim().split(/\r?\n/).map((r) => r.split(r.includes("\t") ? "\t" : ",").map((c) => c.trim()));
  if (rows.length < 2 || rows[0].length < 2) return null;
  const num = (c: string) => { const v = Number(c.replace(/[\s,](?=\d{3}\b)/g, "").replace(/[^\d.\-eE]/g, "")); return c.trim() === "" || isNaN(v) ? null : v; };
  return {
    categories: rows.slice(1).map((r) => r[0]),
    series: rows[0].slice(1).map((name, si) => ({ name: name || `Series ${si + 1}`, values: rows.slice(1).map((r) => num(r[si + 1] ?? "")) }))
  };
}

// ── Diagrams ────────────────────────────────────────────────────────────────
export type ShapeKind =
  | "process" | "rounded" | "decision" | "terminator" | "io" | "database" | "document" | "subprocess" | "connector"
  | "class" | "interface" | "actor" | "usecase" | "package" | "component" | "note" | "start" | "end" | "bar" | "lifeline"
  | "rect" | "ellipse" | "text";
export type EdgeEnd = "none" | "arrow" | "open" | "triangle" | "diamond" | "odiamond";
export type DNode = { id: string; shape: ShapeKind; x: number; y: number; w: number; h: number; text: string; fill: string; stroke: string };
export type DEdge = { id: string; from: string; to: string; label: string; dashed: boolean; start: EdgeEnd; end: EdgeEnd; route: "straight" | "elbow" };
export type DiagramSpec = { kind: "diagram"; title: string; nodes: DNode[]; edges: DEdge[] };

const SHAPES: Array<{ group: string; items: Array<{ shape: ShapeKind; label: string; w: number; h: number; text: string; fill?: string }> }> = [
  { group: "Flowchart", items: [
    { shape: "terminator", label: "Start / End", w: 140, h: 50, text: "Start", fill: "#dbeafe" },
    { shape: "process", label: "Process", w: 150, h: 64, text: "Process" },
    { shape: "decision", label: "Decision", w: 150, h: 96, text: "Condition?", fill: "#fef3c7" },
    { shape: "io", label: "Input / Output", w: 160, h: 60, text: "Input" },
    { shape: "document", label: "Document", w: 150, h: 70, text: "Document" },
    { shape: "database", label: "Database", w: 120, h: 80, text: "Database" },
    { shape: "subprocess", label: "Sub-process", w: 160, h: 64, text: "Sub-process" },
    { shape: "connector", label: "Connector", w: 44, h: 44, text: "A" }
  ] },
  { group: "UML", items: [
    { shape: "class", label: "Class", w: 190, h: 130, text: "ClassName\n--\n- id: string\n- name: string\n--\n+ save(): void" },
    { shape: "interface", label: "Interface", w: 190, h: 100, text: "IName\n--\n+ method(): void" },
    { shape: "actor", label: "Actor", w: 70, h: 110, text: "User" },
    { shape: "usecase", label: "Use case", w: 170, h: 70, text: "Use case" },
    { shape: "package", label: "Package", w: 180, h: 110, text: "package" },
    { shape: "component", label: "Component", w: 170, h: 74, text: "Component" },
    { shape: "lifeline", label: "Lifeline", w: 120, h: 260, text: ":Object" },
    { shape: "note", label: "Note", w: 160, h: 80, text: "Note", fill: "#fef9c3" },
    { shape: "start", label: "Initial node", w: 30, h: 30, text: "" },
    { shape: "end", label: "Final node", w: 34, h: 34, text: "" },
    { shape: "bar", label: "Fork / Join", w: 160, h: 10, text: "" }
  ] },
  { group: "Basic", items: [
    { shape: "rect", label: "Rectangle", w: 140, h: 70, text: "" },
    { shape: "rounded", label: "Rounded", w: 140, h: 70, text: "" },
    { shape: "ellipse", label: "Ellipse", w: 140, h: 80, text: "" },
    { shape: "text", label: "Text", w: 160, h: 36, text: "Text" }
  ] }
];

const STROKE = "#1f2937";
const nodeFont = 13;

// One shape as SVG (in its own coordinates).
export function shapeSvg(n: DNode): string {
  const { x, y, w, h } = n;
  const f = n.fill || "#ffffff", s = n.stroke || STROKE;
  const st = `fill="${f}" stroke="${s}" stroke-width="1.5"`;
  const cx = x + w / 2, cy = y + h / 2;
  const label = (lines = wrap(n.text, w - 16, nodeFont), yy = cy, size = nodeFont, weight = "normal") => textBlock(lines, cx, yy, size, INK, weight);
  switch (n.shape) {
    case "process": case "rect": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}/>` + label();
    case "rounded": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" ${st}/>` + label();
    case "terminator": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ${st}/>` + label();
    case "decision": return `<path d="M${cx},${y}L${x + w},${cy}L${cx},${y + h}L${x},${cy}Z" ${st}/>` + label(wrap(n.text, w * 0.6, nodeFont));
    case "io": { const k = Math.min(20, w / 6); return `<path d="M${x + k},${y}H${x + w}L${x + w - k},${y + h}H${x}Z" ${st}/>` + label(wrap(n.text, w - 2 * k - 8, nodeFont)); }
    case "document": { const k = Math.min(12, h / 5); return `<path d="M${x},${y}H${x + w}V${y + h - k}C${x + w * 0.75},${y + h - 2.5 * k} ${x + w * 0.25},${y + h + k} ${x},${y + h - k}Z" ${st}/>` + label(undefined, cy - k / 2); }
    case "database": { const ry = Math.min(12, h / 6); return `<path d="M${x},${y + ry}V${y + h - ry}A${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry}V${y + ry}" ${st}/><ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" ${st}/>` + label(undefined, cy + ry / 2); }
    case "subprocess": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}/><line x1="${x + 10}" y1="${y}" x2="${x + 10}" y2="${y + h}" stroke="${s}" stroke-width="1.5"/><line x1="${x + w - 10}" y1="${y}" x2="${x + w - 10}" y2="${y + h}" stroke="${s}" stroke-width="1.5"/>` + label(wrap(n.text, w - 28, nodeFont));
    case "connector": case "ellipse": return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" ${st}/>` + label(wrap(n.text, w * 0.7, nodeFont));
    case "usecase": return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" ${st}/>` + label(wrap(n.text, w * 0.72, nodeFont));
    case "class": case "interface": {
      // Compartments split by a line holding only "--".
      const comps = n.text.split(/\n-{2,}\n?/);
      const head = n.shape === "interface" ? ["«interface»", ...(comps[0] || "").split("\n")] : (comps[0] || "").split("\n");
      const lh = nodeFont * 1.3;
      let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}/>`;
      let yy = y + 6;
      head.forEach((l, i) => { out += `<text x="${cx}" y="${yy + lh / 2}" font-family="${FONT}" font-size="${i === 0 && n.shape === "interface" ? 11 : nodeFont}" font-weight="${(n.shape === "interface" ? i === 1 : i === 0) ? "bold" : "normal"}" font-style="${i === 0 && n.shape === "interface" ? "italic" : "normal"}" fill="${INK}" text-anchor="middle" dominant-baseline="central">${esc(l)}</text>`; yy += lh; });
      for (const c of comps.slice(1)) {
        yy += 4;
        out += `<line x1="${x}" y1="${yy}" x2="${x + w}" y2="${yy}" stroke="${s}" stroke-width="1.5"/>`;
        yy += 4;
        for (const l of c.split("\n").filter((q) => q.length)) { out += `<text x="${x + 8}" y="${yy + lh / 2}" font-family="${FONT}" font-size="12" fill="${INK}" dominant-baseline="central">${esc(l)}</text>`; yy += lh; }
      }
      return out;
    }
    case "actor": {
      const hh = h - 22, r = Math.min(w, hh) * 0.16, hx = cx, hy = y + r + 1;
      const neck = hy + r, hip = y + hh * 0.66;
      return `<g fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round"><circle cx="${hx}" cy="${hy}" r="${r}" fill="${f}"/><line x1="${hx}" y1="${neck}" x2="${hx}" y2="${hip}"/><line x1="${x + w * 0.15}" y1="${neck + hh * 0.13}" x2="${x + w * 0.85}" y2="${neck + hh * 0.13}"/><line x1="${hx}" y1="${hip}" x2="${x + w * 0.2}" y2="${y + hh}"/><line x1="${hx}" y1="${hip}" x2="${x + w * 0.8}" y2="${y + hh}"/></g>` + textBlock([n.text], cx, y + h - 8, nodeFont);
    }
    case "package": { const tw = Math.min(w * 0.45, 90); return `<path d="M${x},${y}H${x + tw}V${y + 20}H${x}Z" ${st}/><rect x="${x}" y="${y + 20}" width="${w}" height="${h - 20}" ${st}/>` + textBlock([n.text.split("\n")[0] || ""], x + tw / 2, y + 10, 12, INK, "bold") + textBlock(wrap(n.text.split("\n").slice(1).join("\n"), w - 16, nodeFont), cx, y + 20 + (h - 20) / 2, nodeFont); }
    case "component": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}/><rect x="${x + w - 26}" y="${y + 8}" width="16" height="18" fill="${f}" stroke="${s}" stroke-width="1.2"/><rect x="${x + w - 30}" y="${y + 11}" width="8" height="4" fill="${f}" stroke="${s}" stroke-width="1.2"/><rect x="${x + w - 30}" y="${y + 19}" width="8" height="4" fill="${f}" stroke="${s}" stroke-width="1.2"/>` + label(wrap(n.text, w - 48, nodeFont), cy, nodeFont, "bold");
    case "lifeline": return `<rect x="${x}" y="${y}" width="${w}" height="40" ${st}/><line x1="${cx}" y1="${y + 40}" x2="${cx}" y2="${y + h}" stroke="${s}" stroke-width="1.5" stroke-dasharray="6 5"/>` + textBlock(wrap(n.text, w - 12, nodeFont), cx, y + 20, nodeFont);
    case "note": { const k = 14; return `<path d="M${x},${y}H${x + w - k}L${x + w},${y + k}V${y + h}H${x}Z" ${st}/><path d="M${x + w - k},${y}V${y + k}H${x + w}" fill="none" stroke="${s}" stroke-width="1.5"/>` + label(); }
    case "start": return `<circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) / 2}" fill="${STROKE}"/>`;
    case "end": return `<circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) / 2}" fill="#ffffff" stroke="${STROKE}" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) / 2 - 6}" fill="${STROKE}"/>`;
    case "bar": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${STROKE}"/>`;
    case "text": return textBlock(wrap(n.text, w - 4, nodeFont), cx, cy, nodeFont);
  }
  return "";
}

// Where the line from the centre towards (px,py) leaves the shape's outline.
function boundaryPoint(n: DNode, px: number, py: number) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = px - cx, dy = py - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = n.w / 2, hh = n.h / 2;
  let t: number;
  if (["decision"].includes(n.shape)) t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else if (["ellipse", "usecase", "connector", "start", "end"].includes(n.shape)) t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: cx + dx * t, y: cy + dy * t };
}

function markerDefs() {
  const m = (id: string, path: string, fill: string, w = 12, h = 12, refX = 11) =>
    `<marker id="${id}" viewBox="0 0 ${w} ${h}" refX="${refX}" refY="${h / 2}" markerWidth="${w}" markerHeight="${h}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="${path}" fill="${fill}" stroke="${STROKE}" stroke-width="1.3" stroke-linejoin="round"/></marker>`;
  return `<defs>${m("fd-arrow", "M1,1L11,6L1,11Z", STROKE)}${m("fd-open", "M1,1L11,6L1,11", "none")}${m("fd-triangle", "M1,1L13,7L1,13Z", "#ffffff", 14, 14, 13)}${m("fd-diamond", "M1,6L8,1L15,6L8,11Z", STROKE, 16, 12, 15)}${m("fd-odiamond", "M1,6L8,1L15,6L8,11Z", "#ffffff", 16, 12, 15)}</defs>`;
}

export function edgePoints(e: DEdge, nodes: DNode[], all: DEdge[] = []): Array<{ x: number; y: number }> | null {
  const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to);
  if (!a || !b) return null;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (a.shape === "lifeline" && b.shape === "lifeline") {
    // Sequence message: horizontal, one below the other in the order they
    // were drawn.
    const msgs = all.filter((x) => nodes.find((q) => q.id === x.from)?.shape === "lifeline" && nodes.find((q) => q.id === x.to)?.shape === "lifeline");
    const i = Math.max(0, msgs.findIndex((x) => x.id === e.id));
    const y = Math.min(Math.max(a.y, b.y) + 70 + i * 40, Math.min(a.y + a.h, b.y + b.h) - 8);
    return [{ x: ac.x, y }, { x: bc.x, y }];
  }
  if (e.route === "elbow") {
    const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
    const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
    if (!overlapX && !overlapY) {
      // L-shape: out of the top/bottom of the source, into the side of the target.
      const corner = { x: ac.x, y: bc.y };
      return [boundaryPoint(a, corner.x, corner.y), corner, boundaryPoint(b, corner.x, corner.y)];
    }
    if (overlapY) {
      const p1 = boundaryPoint(a, bc.x, ac.y), p4 = boundaryPoint(b, ac.x, bc.y), mx = (p1.x + p4.x) / 2;
      return [p1, { x: mx, y: p1.y }, { x: mx, y: p4.y }, p4];
    }
    const p1 = boundaryPoint(a, ac.x, bc.y), p4 = boundaryPoint(b, bc.x, ac.y), my = (p1.y + p4.y) / 2;
    return [p1, { x: p1.x, y: my }, { x: p4.x, y: my }, p4];
  }
  return [boundaryPoint(a, bc.x, bc.y), boundaryPoint(b, ac.x, ac.y)];
}

export function edgeSvg(e: DEdge, nodes: DNode[], all: DEdge[] = []): string {
  const pts = edgePoints(e, nodes, all);
  if (!pts) return "";
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  const mk = (v: EdgeEnd) => (v === "none" ? "" : `url(#fd-${v})`);
  let out = `<path d="${d}" fill="none" stroke="${STROKE}" stroke-width="1.5"${e.dashed ? ` stroke-dasharray="7 5"` : ""}${e.start !== "none" ? ` marker-start="${mk(e.start)}"` : ""}${e.end !== "none" ? ` marker-end="${mk(e.end)}"` : ""}/>`;
  if (e.label.trim()) {
    const mid = pts.length === 4 ? { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }
      : pts.length === 3 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      : { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const lines = wrap(e.label, 140, 12);
    const bw = Math.max(...lines.map((l) => l.length)) * 6.6 + 10, bh = lines.length * 15 + 4;
    out += `<rect x="${mid.x - bw / 2}" y="${mid.y - bh / 2}" width="${bw}" height="${bh}" rx="3" fill="#ffffff"/>` + textBlock(lines, mid.x, mid.y, 12, INK_2);
  }
  return out;
}

export function diagramBounds(spec: DiagramSpec) {
  if (!spec.nodes.length) return { x: 0, y: 0, w: 400, h: 200 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of spec.nodes) { x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h); }
  const pad = 24;
  return { x: x1 - pad, y: y1 - pad - (spec.title.trim() ? 34 : 0), w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 + (spec.title.trim() ? 34 : 0) };
}

export function diagramSvg(spec: DiagramSpec): { svg: string; width: number; height: number } {
  const b = diagramBounds(spec);
  const title = spec.title.trim() ? textBlock([spec.title.trim()], b.x + b.w / 2, b.y + 22, 16, INK, "bold") : "";
  const body = spec.edges.map((e) => edgeSvg(e, spec.nodes, spec.edges)).join("") + spec.nodes.map(shapeSvg).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">${markerDefs()}<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffffff"/>${title}${body}</svg>`;
  return { svg, width: b.w, height: b.h };
}

export const newDiagram = (): DiagramSpec => ({ kind: "diagram", title: "", nodes: [], edges: [] });

// ── The graphic as an <img> in the document ────────────────────────────────
export type GraphicSpec = ChartSpec | DiagramSpec;

export async function graphicToImgHtml(spec: GraphicSpec): Promise<string> {
  const { svg, width, height } = spec.kind === "chart" ? chartSvg(spec) : diagramSvg(spec);
  const png = await svgToPng(svg, width, height);
  // In the document it's at most a page wide (the PDF scales by `width`).
  const shown = Math.round(Math.min(720, width));
  const alt = spec.kind === "chart" ? `Chart${spec.title ? ": " + spec.title : ""}` : `Diagram${spec.title ? ": " + spec.title : ""}`;
  return `<img src="${png}" width="${shown}" alt="${esc(alt)}" title="Double-click to edit" data-fd-graphic="${encodeURIComponent(JSON.stringify(spec))}">`;
}

export function readGraphicSpec(img: HTMLImageElement): GraphicSpec | null {
  const raw = img.getAttribute("data-fd-graphic");
  if (!raw) return null;
  try { const s = JSON.parse(decodeURIComponent(raw)); return s?.kind === "chart" || s?.kind === "diagram" ? s : null; } catch { return null; }
}

// ── Modal shell ─────────────────────────────────────────────────────────────
function Modal({ title, sub, onClose, children, footer }: { title: string; sub: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="ep-modal-overlay" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="ep-modal" style={{ maxWidth: 1180, width: "96vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h3 className="ep-modal-title">{title}</h3>
            <p className="ep-modal-sub">{sub}</p>
          </div>
        </div>
        <div className="ep-modal-body" style={{ maxHeight: "72vh", overflow: "auto" }}>{children}</div>
        <div className="ep-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

const small: CSSProperties = { fontSize: 12, padding: "4px 8px" };
const cellInput: CSSProperties = { width: "100%", minWidth: 70, border: "1px solid var(--border, #e5e7eb)", borderRadius: 4, padding: "3px 6px", fontSize: 12, background: "transparent", color: "inherit" };

// ── Chart editor ────────────────────────────────────────────────────────────
export function ChartEditor({ initial, onCancel, onSave }: { initial?: ChartSpec | null; onCancel: () => void; onSave: (spec: ChartSpec) => void }) {
  const [spec, setSpec] = useState<ChartSpec>(() => initial ? { ...newChart(), ...initial } : newChart());
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const preview = useMemo(() => chartSvg(spec), [spec]);
  const isPie = spec.type === "pie" || spec.type === "doughnut";
  const up = (p: Partial<ChartSpec>) => setSpec((s) => ({ ...s, ...p }));
  const setCell = (si: number, ci: number, raw: string) => setSpec((s) => ({
    ...s, series: s.series.map((x, i) => i !== si ? x : { ...x, values: s.categories.map((_c, j) => j === ci ? (raw.trim() === "" || isNaN(Number(raw)) ? null : Number(raw)) : x.values[j] ?? null) })
  }));

  return (
    <Modal
      title={initial ? "Edit chart" : "Insert chart"}
      sub="Type the numbers or paste them from Excel. The chart goes into the document as a picture - double-click it later to change it."
      onClose={onCancel}
      footer={<>
        <button type="button" className="ep-btn-outline" onClick={onCancel}>Cancel</button>
        <button type="button" className="ep-btn" onClick={() => onSave(spec)} disabled={!spec.categories.length || !spec.series.length}>{initial ? "Update chart" : "Insert chart"}</button>
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 420px) 1fr", gap: 16, alignItems: "start" }}>
        <div>
          <div className="ep-form-group">
            <label>Chart type</label>
            <select className="ep-form-select" value={spec.type} onChange={(e) => up({ type: e.target.value as ChartType })}>
              <option value="bar">Column (vertical bars)</option>
              <option value="hbar">Bar (horizontal)</option>
              <option value="stacked">Stacked column</option>
              <option value="line">Line</option>
              <option value="area">Area</option>
              <option value="pie">Pie</option>
              <option value="doughnut">Doughnut</option>
            </select>
          </div>
          <div className="ep-form-group"><label>Title</label><input className="ep-form-input" value={spec.title} onChange={(e) => up({ title: e.target.value })} placeholder="e.g. Monthly transactions" /></div>
          {!isPie && (
            <div style={{ display: "flex", gap: 8 }}>
              <div className="ep-form-group" style={{ flex: 1 }}><label>Category axis label</label><input className="ep-form-input" value={spec.xLabel} onChange={(e) => up({ xLabel: e.target.value })} /></div>
              <div className="ep-form-group" style={{ flex: 1 }}><label>Value axis label</label><input className="ep-form-input" value={spec.yLabel} onChange={(e) => up({ yLabel: e.target.value })} /></div>
            </div>
          )}
          <label className="ep-checkbox-label" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={spec.showValues} onChange={(e) => up({ showValues: e.target.checked })} /> Show the values on the chart
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div className="ep-form-group" style={{ flex: 1 }}><label>Width</label>
              <select className="ep-form-select" value={spec.width} onChange={(e) => up({ width: Number(e.target.value) })}>
                <option value={480}>Narrow</option><option value={600}>Medium</option><option value={720}>Full page width</option>
              </select>
            </div>
            <div className="ep-form-group" style={{ flex: 1 }}><label>Height</label>
              <select className="ep-form-select" value={spec.height} onChange={(e) => up({ height: Number(e.target.value) })}>
                <option value={280}>Short</option><option value={400}>Normal</option><option value={520}>Tall</option>
              </select>
            </div>
          </div>

          <div style={{ fontWeight: 700, fontSize: 13, margin: "6px 0" }}>Data {isPie && <span style={{ fontWeight: 400, color: "var(--muted)" }}>- a pie uses the first series; more than 7 slices fold into "Other"</span>}</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ padding: 2, textAlign: "left", color: "var(--muted)" }}>Category</th>
                  {spec.series.map((s, si) => (
                    <th key={si} style={{ padding: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: SERIES_COLORS[si], flex: "none" }} />
                        <input style={cellInput} value={s.name} onChange={(e) => setSpec((x) => ({ ...x, series: x.series.map((q, i) => i === si ? { ...q, name: e.target.value } : q) }))} />
                        {spec.series.length > 1 && <button type="button" className="ep-icon-btn" title="Remove this series" onClick={() => setSpec((x) => ({ ...x, series: x.series.filter((_q, i) => i !== si) }))}>×</button>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.categories.map((c, ci) => (
                  <tr key={ci}>
                    <td style={{ padding: 2 }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <input style={cellInput} value={c} onChange={(e) => setSpec((x) => ({ ...x, categories: x.categories.map((q, i) => i === ci ? e.target.value : q) }))} />
                        {spec.categories.length > 1 && <button type="button" className="ep-icon-btn" title="Remove this row" onClick={() => setSpec((x) => ({ ...x, categories: x.categories.filter((_q, i) => i !== ci), series: x.series.map((q) => ({ ...q, values: q.values.filter((_v, i) => i !== ci) })) }))}>×</button>}
                      </div>
                    </td>
                    {spec.series.map((s, si) => (
                      <td key={si} style={{ padding: 2 }}>
                        <input style={{ ...cellInput, textAlign: "right" }} inputMode="decimal" value={s.values[ci] ?? ""} onChange={(e) => setCell(si, ci, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button type="button" className="ep-btn-outline" style={small} onClick={() => setSpec((x) => ({ ...x, categories: [...x.categories, `Item ${x.categories.length + 1}`], series: x.series.map((q) => ({ ...q, values: [...q.values, null] })) }))}>+ Row</button>
            <button type="button" className="ep-btn-outline" style={small} disabled={spec.series.length >= SERIES_COLORS.length} title={spec.series.length >= SERIES_COLORS.length ? "Eight series at most - more can't be told apart" : undefined}
              onClick={() => setSpec((x) => ({ ...x, series: [...x.series, { name: `Series ${x.series.length + 1}`, values: x.categories.map(() => null) }] }))}>+ Series</button>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>Paste a table from Excel</summary>
            <textarea className="ep-form-textarea" rows={5} style={{ marginTop: 6, fontFamily: "monospace", fontSize: 12 }} value={paste} onChange={(e) => setPaste(e.target.value)}
              placeholder={"Month\tSales\tTarget\nJan\t120\t100\nFeb\t150\t110"} />
            {pasteError && <div style={{ color: "#b91c1c", fontSize: 12 }}>{pasteError}</div>}
            <button type="button" className="ep-btn-outline" style={{ ...small, marginTop: 6 }} onClick={() => {
              const t = parseTable(paste);
              if (!t) { setPasteError("Paste at least a header row and one data row: the first column is the category, the other columns are the series."); return; }
              setPasteError(null); setPaste("");
              up({ categories: t.categories, series: t.series.slice(0, SERIES_COLORS.length) });
            }}>Use this data</button>
          </details>
        </div>
        <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, background: "#ffffff", padding: 8, position: "sticky", top: 0 }}>
          <div style={{ width: "100%" }} dangerouslySetInnerHTML={{ __html: preview.svg.replace(`width="${preview.width}" height="${preview.height}"`, `width="100%" style="display:block;height:auto"`) }} />
        </div>
      </div>
    </Modal>
  );
}

// ── Diagram editor ──────────────────────────────────────────────────────────
type Drag =
  | { kind: "move"; id: string; dx: number; dy: number; moved: boolean }
  | { kind: "resize"; id: string; ox: number; oy: number; ow: number; oh: number }
  | { kind: "connect"; from: string; x: number; y: number };

const snap = (v: number) => Math.round(v / 10) * 10;

export function DiagramEditor({ initial, onCancel, onSave }: { initial?: DiagramSpec | null; onCancel: () => void; onSave: (spec: DiagramSpec) => void }) {
  const [spec, setSpecRaw] = useState<DiagramSpec>(() => initial ? JSON.parse(JSON.stringify(initial)) : newDiagram());
  const [history, setHistory] = useState<DiagramSpec[]>([]);
  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [newEdge, setNewEdge] = useState<Pick<DEdge, "dashed" | "start" | "end" | "route">>({ dashed: false, start: "none", end: "arrow", route: "straight" });
  const svgRef = useRef<SVGSVGElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const W = Math.max(1100, ...spec.nodes.map((n) => n.x + n.w + 200));
  const H = Math.max(640, ...spec.nodes.map((n) => n.y + n.h + 160));

  const setSpec = (next: DiagramSpec | ((s: DiagramSpec) => DiagramSpec), record = true) => {
    const v = typeof next === "function" ? next(spec) : next;
    if (record) setHistory((h) => [...h.slice(-49), spec]);
    setSpecRaw(v);
  };
  const undo = () => {
    if (!history.length) return;
    setSpecRaw(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setSel(null);
  };

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };
  const nodeAt = (x: number, y: number) => [...spec.nodes].reverse().find((n) => x >= n.x - 4 && x <= n.x + n.w + 4 && y >= n.y - 4 && y <= n.y + n.h + 4);

  function addShape(item: (typeof SHAPES)[number]["items"][number]) {
    // Placed below/right of the selected shape (or in the next free spot) and
    // joined to it, so a flowchart builds up quickly.
    const from = sel?.type === "node" ? spec.nodes.find((n) => n.id === sel.id) : null;
    const n: DNode = {
      id: uid(), shape: item.shape, w: item.w, h: item.h, text: item.text, fill: item.fill || "#ffffff", stroke: STROKE,
      x: from ? snap(from.x + from.w / 2 - item.w / 2) : snap(60 + (spec.nodes.length % 5) * 40),
      y: from ? snap(from.y + from.h + 50) : snap(40 + (spec.nodes.length % 8) * 30)
    };
    const autoLink = from && !["note", "text"].includes(item.shape) && !["note", "text"].includes(from.shape);
    setSpec((s) => ({
      ...s, nodes: [...s.nodes, n],
      edges: autoLink ? [...s.edges, { id: uid(), from: from!.id, to: n.id, label: "", ...newEdge }] : s.edges
    }));
    setSel({ type: "node", id: n.id });
  }

  function remove() {
    if (!sel) return;
    if (sel.type === "node") setSpec((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== sel.id), edges: s.edges.filter((e) => e.from !== sel.id && e.to !== sel.id) }));
    else setSpec((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== sel.id) }));
    setSel(null);
  }
  function duplicate() {
    if (sel?.type !== "node") return;
    const n = spec.nodes.find((x) => x.id === sel.id);
    if (!n) return;
    const c = { ...n, id: uid(), x: n.x + 30, y: n.y + 30 };
    setSpec((s) => ({ ...s, nodes: [...s.nodes, c] }));
    setSel({ type: "node", id: c.id });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); remove(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); }
      else if (sel?.type === "node" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const [dx, dy] = e.key === "ArrowLeft" ? [-d, 0] : e.key === "ArrowRight" ? [d, 0] : e.key === "ArrowUp" ? [0, -d] : [0, d];
        setSpec((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === sel.id ? { ...n, x: n.x + dx, y: n.y + dy } : n) }));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onPointerDownNode(e: ReactPointerEvent, n: DNode) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toLocal(e);
    setSel({ type: "node", id: n.id });
    setHistory((h) => [...h.slice(-49), spec]);
    setDrag({ kind: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false });
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (!drag) return;
    const p = toLocal(e);
    if (drag.kind === "move") {
      setSpec((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === drag.id ? { ...n, x: snap(p.x - drag.dx), y: snap(p.y - drag.dy) } : n) }), false);
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else if (drag.kind === "resize") {
      setSpec((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === drag.id ? { ...n, w: Math.max(20, snap(p.x - n.x)), h: Math.max(n.shape === "bar" ? 6 : 20, snap(p.y - n.y)) } : n) }), false);
    } else setDrag({ ...drag, x: p.x, y: p.y });
  }
  function onPointerUp(e: ReactPointerEvent) {
    if (drag?.kind === "connect") {
      const p = toLocal(e);
      const target = nodeAt(p.x, p.y);
      if (target && target.id !== drag.from) {
        const id = uid();
        setSpec((s) => ({ ...s, edges: [...s.edges, { id, from: drag.from, to: target.id, label: "", ...newEdge }] }));
        setSel({ type: "edge", id });
      }
    } else if (drag?.kind === "move" && !drag.moved) {
      setHistory((h) => h.slice(0, -1)); // a click, not a move
    }
    setDrag(null);
  }

  const selNode = sel?.type === "node" ? spec.nodes.find((n) => n.id === sel.id) : null;
  const selEdge = sel?.type === "edge" ? spec.edges.find((x) => x.id === sel.id) : null;
  const upNode = (p: Partial<DNode>) => selNode && setSpec((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selNode.id ? { ...n, ...p } : n) }));
  const upEdge = (p: Partial<DEdge>) => selEdge && setSpec((s) => ({ ...s, edges: s.edges.map((x) => x.id === selEdge.id ? { ...x, ...p } : x) }));
  const endOptions: Array<[EdgeEnd, string]> = [["none", "None"], ["arrow", "Arrow"], ["open", "Open arrow"], ["triangle", "Hollow triangle (inheritance)"], ["diamond", "Filled diamond (composition)"], ["odiamond", "Hollow diamond (aggregation)"]];
  const connectFrom = drag?.kind === "connect" ? spec.nodes.find((n) => n.id === drag.from) : null;

  return (
    <Modal
      title={initial ? "Edit diagram" : "Insert diagram"}
      sub="Click a shape to add it (it joins the selected shape). Drag to move, drag the blue dot to connect, the corner to resize. Delete removes, Ctrl+Z undoes, Ctrl+D duplicates."
      onClose={onCancel}
      footer={<>
        <button type="button" className="ep-btn-outline" onClick={onCancel}>Cancel</button>
        <button type="button" className="ep-btn" disabled={!spec.nodes.length} onClick={() => onSave(spec)}>{initial ? "Update diagram" : "Insert diagram"}</button>
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 240px", gap: 12, alignItems: "start" }}>
        <div style={{ maxHeight: "66vh", overflowY: "auto" }}>
          {SHAPES.map((g) => (
            <div key={g.group} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", margin: "4px 0" }}>{g.group}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                {g.items.map((it) => {
                  const sw = 60, sh = 40;
                  const k = Math.min((sw - 8) / it.w, (sh - 8) / it.h);
                  const icon = shapeSvg({ id: "", shape: it.shape, x: 0, y: 0, w: it.w, h: it.h, text: "", fill: it.fill || "#ffffff", stroke: STROKE });
                  return (
                    <button key={it.shape} type="button" title={it.label} onClick={() => addShape(it)}
                      style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, background: "#ffffff", padding: 2, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <svg width={sw} height={sh} viewBox={`0 0 ${sw} ${sh}`}>
                        <g transform={`translate(${(sw - it.w * k) / 2} ${(sh - it.h * k) / 2}) scale(${k})`} dangerouslySetInnerHTML={{ __html: it.shape === "text" ? `<text x="${it.w / 2}" y="${it.h / 2}" font-size="40" font-family="${FONT}" text-anchor="middle" dominant-baseline="central" fill="${INK}">T</text>` : icon }} />
                      </svg>
                      <span style={{ fontSize: 10, color: "#374151", lineHeight: 1.1, textAlign: "center" }}>{it.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <input className="ep-form-input" style={{ flex: 1, minWidth: 180 }} value={spec.title} onChange={(e) => setSpec((s) => ({ ...s, title: e.target.value }), false)} placeholder="Diagram title (optional)" />
            <button type="button" className="ep-btn-outline" style={small} onClick={undo} disabled={!history.length}>Undo</button>
            <button type="button" className="ep-btn-outline" style={small} onClick={duplicate} disabled={sel?.type !== "node"}>Duplicate</button>
            <button type="button" className="ep-btn-outline" style={{ ...small, color: "#dc2626" }} onClick={remove} disabled={!sel}>Delete</button>
          </div>
          <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, overflow: "auto", maxHeight: "60vh", background: "#ffffff" }}>
            <svg ref={svgRef} width={W} height={H} style={{ display: "block", touchAction: "none", userSelect: "none" }}
              onPointerDown={() => setSel(null)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
              <defs>
                <pattern id="fd-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#e5e7eb" /></pattern>
              </defs>
              <rect width={W} height={H} fill="url(#fd-grid)" />
              <g dangerouslySetInnerHTML={{ __html: markerDefs() }} />
              {spec.edges.map((e) => {
                const pts = edgePoints(e, spec.nodes, spec.edges);
                if (!pts) return null;
                const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join("");
                const on = sel?.type === "edge" && sel.id === e.id;
                return (
                  <g key={e.id} onPointerDown={(ev) => { ev.stopPropagation(); setSel({ type: "edge", id: e.id }); }} style={{ cursor: "pointer" }}>
                    {on && <path d={d} fill="none" stroke="#2a78d6" strokeOpacity={0.35} strokeWidth={8} />}
                    <g dangerouslySetInnerHTML={{ __html: edgeSvg(e, spec.nodes, spec.edges) }} />
                    <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                  </g>
                );
              })}
              {spec.nodes.map((n) => {
                const on = sel?.type === "node" && sel.id === n.id;
                return (
                  <g key={n.id}>
                    <g onPointerDown={(e) => onPointerDownNode(e, n)} onDoubleClick={() => textRef.current?.focus()} style={{ cursor: "move" }}>
                      <rect x={n.x} y={n.y} width={n.w} height={n.h} fill="transparent" />
                      <g dangerouslySetInnerHTML={{ __html: shapeSvg(n) }} />
                    </g>
                    {on && (
                      <>
                        <rect x={n.x - 3} y={n.y - 3} width={n.w + 6} height={n.h + 6} fill="none" stroke="#2a78d6" strokeDasharray="4 3" pointerEvents="none" />
                        <rect x={n.x + n.w - 5} y={n.y + n.h - 5} width={10} height={10} fill="#ffffff" stroke="#2a78d6" style={{ cursor: "nwse-resize" }}
                          onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setHistory((h) => [...h.slice(-49), spec]); setDrag({ kind: "resize", id: n.id, ox: n.x, oy: n.y, ow: n.w, oh: n.h }); }} />
                        <circle cx={n.x + n.w + 14} cy={n.y + n.h / 2} r={7} fill="#2a78d6" stroke="#ffffff" strokeWidth={2} style={{ cursor: "crosshair" }}
                          onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); const p = toLocal(e); setDrag({ kind: "connect", from: n.id, x: p.x, y: p.y }); }}>
                          <title>Drag to another shape to connect</title>
                        </circle>
                      </>
                    )}
                  </g>
                );
              })}
              {connectFrom && drag?.kind === "connect" && (
                <line x1={connectFrom.x + connectFrom.w / 2} y1={connectFrom.y + connectFrom.h / 2} x2={drag.x} y2={drag.y} stroke="#2a78d6" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" />
              )}
              {!spec.nodes.length && (
                <text x={W / 2} y={160} textAnchor="middle" fill="#9ca3af" fontSize={14} fontFamily={FONT}>Pick a shape on the left to start</text>
              )}
            </svg>
          </div>
        </div>

        <div style={{ fontSize: 13 }}>
          {selNode ? (
            <>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Shape</div>
              {!["start", "end", "bar"].includes(selNode.shape) && (
                <div className="ep-form-group">
                  <label>Text</label>
                  <textarea ref={textRef} className="ep-form-textarea" rows={selNode.shape === "class" || selNode.shape === "interface" ? 7 : 3} value={selNode.text}
                    onChange={(e) => setSpec((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selNode.id ? { ...n, text: e.target.value } : n) }), false)} />
                  {(selNode.shape === "class" || selNode.shape === "interface") && <div style={{ fontSize: 11, color: "var(--muted)" }}>A line with just -- starts the next compartment (attributes, then operations).</div>}
                  {selNode.shape === "package" && <div style={{ fontSize: 11, color: "var(--muted)" }}>The first line is the package name on the tab.</div>}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Fill <input type="color" value={selNode.fill || "#ffffff"} onChange={(e) => upNode({ fill: e.target.value })} /></label>
                <label style={{ fontSize: 12 }}>Line <input type="color" value={selNode.stroke || STROKE} onChange={(e) => upNode({ stroke: e.target.value })} /></label>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                {["#ffffff", "#dbeafe", "#dcfce7", "#fef3c7", "#fee2e2", "#ede9fe", "#f3f4f6"].map((c) => (
                  <button key={c} type="button" title={c} onClick={() => upNode({ fill: c })} style={{ width: 22, height: 22, borderRadius: 4, border: "1px solid #d1d5db", background: c, cursor: "pointer" }} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <label style={{ fontSize: 12 }}>W <input type="number" style={{ ...cellInput, width: 64 }} value={selNode.w} onChange={(e) => upNode({ w: Math.max(6, Number(e.target.value) || 0) })} /></label>
                <label style={{ fontSize: 12 }}>H <input type="number" style={{ ...cellInput, width: 64 }} value={selNode.h} onChange={(e) => upNode({ h: Math.max(6, Number(e.target.value) || 0) })} /></label>
              </div>
            </>
          ) : selEdge ? (
            <>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Connector</div>
              <div className="ep-form-group"><label>Label</label><input className="ep-form-input" value={selEdge.label} onChange={(e) => setSpec((s) => ({ ...s, edges: s.edges.map((x) => x.id === selEdge.id ? { ...x, label: e.target.value } : x) }), false)} placeholder="e.g. Yes / No / 1..*" /></div>
              <EdgeStyleFields value={selEdge} onChange={(p) => { upEdge(p); setNewEdge((v) => ({ ...v, ...p })); }} endOptions={endOptions} />
              <button type="button" className="ep-btn-outline" style={small} onClick={() => upEdge({ from: selEdge.to, to: selEdge.from })}>Reverse direction</button>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>New connectors</div>
              <EdgeStyleFields value={newEdge} onChange={(p) => setNewEdge((v) => ({ ...v, ...p }))} endOptions={endOptions} />
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Select a shape or a connector to change it.</div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function EdgeStyleFields({ value, onChange, endOptions }: { value: Pick<DEdge, "dashed" | "start" | "end" | "route">; onChange: (p: Partial<DEdge>) => void; endOptions: Array<[EdgeEnd, string]> }) {
  return (
    <>
      <div className="ep-form-group"><label>Line</label>
        <select className="ep-form-select" value={value.dashed ? "dashed" : "solid"} onChange={(e) => onChange({ dashed: e.target.value === "dashed" })}>
          <option value="solid">Solid</option><option value="dashed">Dashed (dependency / return)</option>
        </select>
      </div>
      <div className="ep-form-group"><label>Path</label>
        <select className="ep-form-select" value={value.route} onChange={(e) => onChange({ route: e.target.value as DEdge["route"] })}>
          <option value="straight">Straight</option><option value="elbow">Right angles</option>
        </select>
      </div>
      <div className="ep-form-group"><label>Start</label>
        <select className="ep-form-select" value={value.start} onChange={(e) => onChange({ start: e.target.value as EdgeEnd })}>
          {endOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="ep-form-group"><label>End</label>
        <select className="ep-form-select" value={value.end} onChange={(e) => onChange({ end: e.target.value as EdgeEnd })}>
          {endOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
    </>
  );
}
