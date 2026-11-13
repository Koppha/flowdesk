import PDFDocument from "pdfkit";
import fs from "fs";
import sharp from "sharp";
import type { PdfLetterhead } from "./genericPdfRenderer.js";
import { DEFAULT_ECONET_LOGO_DATA_URI } from "./assets/econetLogo.js";

// BRS PDF in Econet's Business Requirement Specification layout (as in the
// signed "EcoAI bundling" BRS): a cover with the department band, version and
// reviewer tables and the "previous versions are null and void" note; the
// logo on every page, a faint logo watermark, and "Title  ...  Page X of Y" in
// the footer; a numbered Table of Contents; blue numbered section headings;
// and an "Approval of implementation" table with the approvers' signatures.
//
// Section content is the rich text written in BRS Studio and is drawn as
// written - paragraphs with bold/italic/underline, bulleted and lettered
// lists, headings (numbered N.M), tables (navy header row, repeated across
// pages) and images (pasted screenshots and charts) - not flattened to text.

export interface BrsPdfSection {
  title: string;
  content_html: string | null;
}

export interface BrsPdfApprover {
  position_name: string | null;
  approver_name: string | null;
  status?: string | null;
  acted_at?: string | null;
  // A data: URL of the approver's saved signature, once they've approved.
  signature_image?: string | null;
}

export interface BrsPdfReviewer {
  name: string;
}

export interface BrsPdfData {
  title: string;
  reference_no: string | null;
  requester_name: string | null;
  phase: string;
  baselined_at: string | null;
  sections: BrsPdfSection[];
  brs_type_name?: string | null;
  // The requesting department - the cover's band ("Products and Services").
  department?: string | null;
  product_owner?: string | null;
  target_quarter?: string | null;
  departments_included?: string[];
  approvers?: BrsPdfApprover[];
  version_label?: string | null;
  changed_on?: string | null;
  changed_by?: string | null;
  reviewers?: BrsPdfReviewer[];
}

// ── Look ──────────────────────────────────────────────────────────────────
const NAVY = "#002060";        // cover band, table headers
const HEADING = "#2E74B5";     // section headings and TOC title
const INK = "#111111";
const MUTED = "#555555";
const GRID = "#333333";
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 72;
const TOP = 112;               // below the logo
const BOTTOM = 770;            // above the footer
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BODY = 10.5;

// ── A small, forgiving HTML reader (the editor's own output and pasted
// Word/Excel/web HTML) ────────────────────────────────────────────────────
type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text?: string };
const VOID = new Set(["br", "img", "hr", "col", "meta", "link", "input", "wbr", "area", "source"]);
const DROP = new Set(["script", "style", "head", "title", "xml", "o:p", "colgroup"]);

function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—")
    .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&rdquo;|&ldquo;/gi, '"').replace(/&bull;/gi, "•").replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

export function parseHtml(html: string): Node {
  const root: Node = { tag: "root", attrs: {}, children: [] };
  const stack: Node[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<!(?:doctype)?[^>]*>|<\/\s*([a-zA-Z0-9:]+)\s*>|<([a-zA-Z0-9:]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  let dropDepth = 0;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      if (!dropDepth) top.children.push({ tag: "#text", attrs: {}, children: [], text: decode(m[4]) });
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (DROP.has(tag)) { if (!/\/\s*$/.test(m[3] || "")) dropDepth++; continue; }
      if (dropDepth) continue;
      const node: Node = { tag, attrs: parseAttrs(m[3] || ""), children: [] };
      top.children.push(node);
      if (!VOID.has(tag) && !/\/\s*$/.test(m[3] || "")) stack.push(node);
    } else if (m[1]) {
      const tag = m[1].toLowerCase();
      if (DROP.has(tag)) { dropDepth = Math.max(0, dropDepth - 1); continue; }
      if (dropDepth) continue;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    }
  }
  return root;
}

// ── Turn the tree into blocks to draw ────────────────────────────────────
type Run = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string };
type Cell = { runs: Run[]; header: boolean; colspan: number; bg?: string };
type Block =
  | { kind: "para"; runs: Run[]; align: "left" | "center" | "right" | "justify"; quote?: boolean; mono?: boolean; tight?: boolean }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; runs: Run[]; marker: string; depth: number }
  | { kind: "table"; rows: Cell[][] }
  | { kind: "image"; src: string; width?: number }
  | { kind: "rule" };

const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "blockquote", "pre", "hr", "section", "article", "header", "footer"]);
type Style = { bold?: boolean; italic?: boolean; underline?: boolean; color?: string };

function styleFrom(node: Node, base: Style): Style {
  const s: Style = { ...base };
  const t = node.tag;
  if (t === "b" || t === "strong" || t === "th") s.bold = true;
  if (t === "i" || t === "em") s.italic = true;
  if (t === "u") s.underline = true;
  const css = (node.attrs.style || "").toLowerCase();
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(css)) s.bold = true;
  if (/font-weight\s*:\s*(normal|[1-4]00)/.test(css)) s.bold = false;
  if (/font-style\s*:\s*italic/.test(css)) s.italic = true;
  if (/text-decoration[^;]*underline/.test(css)) s.underline = true;
  const color = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,6}|rgb\([^)]*\))/.exec(css)?.[1] || node.attrs.color;
  if (color) s.color = toHex(color);
  return s;
}

function toHex(c: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map((x) => x + x).join("");
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return undefined;
}

function inlineRuns(nodes: Node[], style: Style, out: Run[]) {
  for (const n of nodes) {
    if (n.tag === "#text") {
      const text = (n.text || "").replace(/\s+/g, " ");
      if (text) out.push({ text, ...style });
    } else if (n.tag === "br") {
      out.push({ text: "\n", ...style });
    } else if (n.tag === "img") {
      // Inline images are pulled out as their own blocks by the caller.
    } else {
      inlineRuns(n.children, styleFrom(n, style), out);
    }
  }
}

function trimRuns(runs: Run[]): Run[] {
  const r = runs.map((x) => ({ ...x }));
  while (r.length && !r[0].text.replace(/^\s+/, "")) r.shift();
  if (r.length) r[0].text = r[0].text.replace(/^[ \t]+/, "");
  while (r.length && !r[r.length - 1].text.replace(/\s+$/, "")) r.pop();
  if (r.length) r[r.length - 1].text = r[r.length - 1].text.replace(/[ \t]+$/, "");
  return r;
}

const plain = (runs: Run[]) => runs.map((r) => r.text).join("").trim();
const alignOf = (n: Node): "left" | "center" | "right" | "justify" | null => {
  const a = (/text-align\s*:\s*(left|center|right|justify)/i.exec(n.attrs.style || "")?.[1] || n.attrs.align || "").toLowerCase();
  return (["left", "center", "right", "justify"] as const).find((x) => x === a) ?? null;
};

function letter(i: number) { let s = ""; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(97 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
function roman(i: number) {
  const map: Array<[number, string]> = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let n = i + 1; let s = "";
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; } return s;
}

function collectImages(n: Node, out: Block[]) {
  if (n.tag === "img" && n.attrs.src) out.push({ kind: "image", src: n.attrs.src, width: Number(n.attrs.width) || undefined });
  n.children.forEach((c) => collectImages(c, out));
}

function toBlocks(nodes: Node[], out: Block[], depth = 0, inherited: Style = {}) {
  let pending: Node[] = [];
  const flush = () => {
    if (!pending.length) return;
    const runs = trimRuns((() => { const r: Run[] = []; inlineRuns(pending, inherited, r); return r; })());
    if (plain(runs)) out.push({ kind: "para", runs, align: "justify" });
    pending.forEach((p) => collectImages(p, out));
    pending = [];
  };
  for (const n of nodes) {
    if (n.tag === "#text" || !BLOCK_TAGS.has(n.tag)) {
      if (n.tag === "img") { flush(); collectImages(n, out); continue; }
      if (n.tag !== "#text" && n.children.some((c) => BLOCK_TAGS.has(c.tag))) { flush(); toBlocks(n.children, out, depth, styleFrom(n, inherited)); continue; }
      pending.push(n);
      continue;
    }
    flush();
    const t = n.tag;
    if (/^h[1-6]$/.test(t)) {
      const r: Run[] = []; inlineRuns(n.children, {}, r);
      const text = plain(r);
      if (text) out.push({ kind: "heading", level: Number(t[1]), text });
    } else if (t === "ul" || t === "ol") {
      let i = 0;
      for (const li of n.children.filter((c) => c.tag === "li")) {
        const marker = t === "ol" ? (depth === 0 ? `${letter(i)})` : depth === 1 ? `${roman(i)}.` : `${i + 1}.`) : depth === 0 ? "•" : depth === 1 ? "–" : "·";
        const inner = li.children.filter((c) => c.tag !== "ul" && c.tag !== "ol");
        const r: Run[] = []; inlineRuns(inner.filter((c) => !BLOCK_TAGS.has(c.tag) || c.tag === "p" || c.tag === "div"), inherited, r);
        out.push({ kind: "item", runs: trimRuns(r), marker, depth });
        inner.forEach((c) => collectImages(c, out));
        li.children.filter((c) => c.tag === "ul" || c.tag === "ol").forEach((sub) => toBlocks([sub], out, depth + 1, inherited));
        i++;
      }
    } else if (t === "table") {
      const rows: Cell[][] = [];
      const walkRows = (node: Node, inHead: boolean) => {
        for (const c of node.children) {
          if (c.tag === "thead") walkRows(c, true);
          else if (c.tag === "tbody" || c.tag === "tfoot") walkRows(c, inHead);
          else if (c.tag === "tr") {
            const cells: Cell[] = [];
            for (const td of c.children.filter((x) => x.tag === "td" || x.tag === "th")) {
              const r: Run[] = []; inlineRuns(td.children, styleFrom(td, {}), r);
              const bg = toHex((/background(?:-color)?\s*:\s*(#[0-9a-f]{3,6}|rgb\([^)]*\))/i.exec(td.attrs.style || "")?.[1]) || td.attrs.bgcolor || "");
              cells.push({ runs: trimRuns(r), header: inHead || td.tag === "th", colspan: Math.max(1, Number(td.attrs.colspan) || 1), bg });
              collectImages(td, []); // images inside cells aren't drawn in cells
            }
            if (cells.length) rows.push(cells);
          }
        }
      };
      walkRows(n, false);
      if (rows.length > 1 && rows[0].every((c) => c.header || (c.runs.length > 0 && c.runs.every((r) => r.bold || !r.text.trim())))) rows[0].forEach((c) => { c.header = true; });
      if (rows.length) out.push({ kind: "table", rows });
    } else if (t === "hr") {
      out.push({ kind: "rule" });
    } else if (t === "blockquote" || t === "pre") {
      const r: Run[] = []; inlineRuns(n.children, inherited, r);
      const runs = t === "pre" ? r : trimRuns(r);
      if (plain(runs)) out.push({ kind: "para", runs, align: "left", quote: t === "blockquote", mono: t === "pre" });
    } else if (n.children.some((c) => BLOCK_TAGS.has(c.tag))) {
      toBlocks(n.children, out, depth, styleFrom(n, inherited));
    } else {
      const r: Run[] = []; inlineRuns(n.children, styleFrom(n, inherited), r);
      const runs = trimRuns(r);
      if (plain(runs)) out.push({ kind: "para", runs, align: alignOf(n) ?? "justify", tight: n.tag === "div" });
      else if (n.tag === "div" || n.tag === "p") out.push({ kind: "para", runs: [{ text: " " }], align: "left", tight: true }); // an empty line
      n.children.forEach((c) => collectImages(c, out));
    }
  }
  flush();
}

export function htmlToBlocks(html: string | null): Block[] {
  if (!html || !html.trim()) return [];
  const out: Block[] = [];
  toBlocks(parseHtml(html).children, out);
  return out;
}

// ── Images: data URLs only (pasted images are stored inline); webp/gif/svg
// are converted to PNG for pdfkit, big ones scaled down ──────────────────
async function loadImage(src: string): Promise<Buffer | null> {
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(src.trim());
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], "base64");
    const type = m[1].toLowerCase();
    if ((type === "png" || type === "jpeg" || type === "jpg") && buf.length < 1_500_000) return buf;
    return await sharp(buf, { density: 150 }).resize({ width: 1600, withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

function logoBuffer(letterhead: PdfLetterhead): Buffer | string {
  if (letterhead.logo_data && /^data:image\/(png|jpe?g);base64,/i.test(letterhead.logo_data)) return Buffer.from(letterhead.logo_data.split(",")[1], "base64");
  if (letterhead.logo_path && fs.existsSync(letterhead.logo_path)) return letterhead.logo_path;
  return Buffer.from(DEFAULT_ECONET_LOGO_DATA_URI.split(",")[1], "base64");
}

const fmtDay = (s: string | null | undefined) => {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Maseru" }).replace(/\//g, ".");
};

// ── Drawing ───────────────────────────────────────────────────────────────
function font(doc: PDFKit.PDFDocument, r: { bold?: boolean; italic?: boolean }, mono = false) {
  if (mono) return doc.font(r.bold ? "Courier-Bold" : "Courier");
  return doc.font(r.bold && r.italic ? "Helvetica-BoldOblique" : r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : "Helvetica");
}

function runsHeight(doc: PDFKit.PDFDocument, runs: Run[], width: number, size: number, mono = false): number {
  // Measure with the dominant style; good enough for page-break decisions.
  font(doc, { bold: runs.length > 0 && runs.every((r) => r.bold) }, mono).fontSize(size);
  return doc.heightOfString(runs.map((r) => r.text).join("") || " ", { width, lineGap: 2 });
}

function drawRuns(doc: PDFKit.PDFDocument, runs: Run[], x: number, y: number, width: number, opts: { size: number; align: string; color?: string; mono?: boolean }) {
  const list = runs.length ? runs : [{ text: " " }];
  const mixed = list.some((r) => Boolean(r.bold) !== Boolean(list[0].bold) || Boolean(r.italic) !== Boolean(list[0].italic) || Boolean(r.underline) !== Boolean(list[0].underline) || r.color !== list[0].color);
  if (mixed && opts.align === "justify") opts = { ...opts, align: "left" };
  list.forEach((r, i) => {
    font(doc, r, opts.mono).fontSize(opts.size).fillColor(r.color || opts.color || INK);
    const o: PDFKit.Mixins.TextOptions = { width, lineGap: 2, align: opts.align as any, underline: Boolean(r.underline), continued: i < list.length - 1 };
    if (i === 0) doc.text(r.text, x, y, o); else doc.text(r.text, o);
  });
}

export async function renderBrsPdf(letterhead: PdfLetterhead, data: BrsPdfData): Promise<PDFKit.PDFDocument> {
  const doc = new PDFDocument({ size: "A4", margins: { top: TOP, bottom: PAGE_H - BOTTOM, left: MARGIN_X, right: MARGIN_X }, bufferPages: true, autoFirstPage: true });
  const logo = logoBuffer(letterhead);
  const sections = data.sections.map((s) => ({ title: s.title, blocks: htmlToBlocks(s.content_html) }));

  // Images first (async conversion), keyed by src.
  const images = new Map<string, Buffer | null>();
  for (const s of sections) for (const b of s.blocks) if (b.kind === "image" && !images.has(b.src)) images.set(b.src, await loadImage(b.src));
  const signatures = new Map<string, Buffer | null>();
  for (const a of data.approvers || []) if (a.signature_image && !signatures.has(a.signature_image)) signatures.set(a.signature_image, await loadImage(a.signature_image));

  // ── Cover ──
  drawCover(doc, data);

  // ── Table of Contents: reserve pages now, fill in at the end ──
  const tocEntriesEstimate = sections.length + 1 + sections.reduce((t, s) => t + s.blocks.filter((b) => b.kind === "heading" && b.level <= 3).length, 0);
  const tocPages: number[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(tocEntriesEstimate / 30)); i++) { doc.addPage(); tocPages.push(currentPage(doc)); }

  // ── Content ──
  type Toc = { text: string; page: number; level: 0 | 1 };
  const toc: Toc[] = [];
  doc.addPage();
  let y = TOP;
  const ensure = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = TOP; return true; } return false; };

  sections.forEach((s, si) => {
    const n = si + 1;
    ensure(60);
    if (y > TOP) y += 10;
    toc.push({ text: `${n}.  ${s.title}`, page: currentPage(doc) + 1, level: 0 });
    doc.font("Helvetica-Bold").fontSize(14).fillColor(HEADING).text(`${n}.  ${s.title}`, MARGIN_X, y, { width: CONTENT_W });
    y = doc.y + 10;
    let sub = 0;
    for (const b of s.blocks) y = drawBlock(doc, b, y, n, () => ++sub, toc, images, ensure);
    y += 6;
  });

  // ── Approval of implementation ──
  const approvers = (data.approvers || []).filter((a) => a.approver_name || a.position_name);
  {
    const n = sections.length + 1;
    ensure(120);
    if (y > TOP) y += 10;
    toc.push({ text: `${n}.  Approval of implementation`, page: currentPage(doc) + 1, level: 0 });
    doc.font("Helvetica-Bold").fontSize(14).fillColor(HEADING).text(`${n}.  Approval of implementation`, MARGIN_X, y, { width: CONTENT_W });
    y = doc.y + 8;
    const cols = [CONTENT_W * 0.3, CONTENT_W * 0.26, CONTENT_W * 0.24, CONTENT_W * 0.2];
    const header = ["Designation", "Name", "Signature", "Date"];
    const drawHeader = () => {
      let x = MARGIN_X;
      header.forEach((h, i) => {
        doc.rect(x, y, cols[i], 20).fillAndStroke(NAVY, GRID);
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff").text(h, x + 6, y + 6, { width: cols[i] - 12, lineBreak: false });
        x += cols[i];
      });
      y += 20;
    };
    drawHeader();
    const rows = approvers.length ? approvers : [{ position_name: "", approver_name: "", status: null, acted_at: null }];
    for (const a of rows) {
      const h = 46;
      if (y + h > BOTTOM) { doc.addPage(); y = TOP; drawHeader(); }
      let x = MARGIN_X;
      const approved = Boolean(a.acted_at) && a.status !== "REJECTED";
      const sig = a.signature_image ? signatures.get(a.signature_image) : null;
      const cells = [a.position_name || "", a.approver_name || "", "", approved ? fmtDay(a.acted_at) : ""];
      cells.forEach((c, i) => {
        doc.rect(x, y, cols[i], h).lineWidth(0.6).strokeColor(GRID).stroke();
        if (i === 2) {
          if (approved && sig) {
            try { doc.image(sig, x + 6, y + 4, { fit: [cols[i] - 12, h - 8], align: "center", valign: "center" }); } catch { /* bad image */ }
          } else {
            doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
              .text(a.status === "REJECTED" ? "Rejected" : approved ? `Approved ${fmtDay(a.acted_at)}` : a.approver_name ? "Awaiting approval" : "", x + 6, y + 17, { width: cols[i] - 12, align: "center" });
          }
        } else {
          doc.font("Helvetica").fontSize(10).fillColor(INK).text(c, x + 6, y + 8, { width: cols[i] - 12, height: h - 10, ellipsis: true });
        }
        x += cols[i];
      });
      y += h;
    }
  }

  // ── Fill the Table of Contents ──
  {
    let ti = 0;
    doc.switchToPage(tocPages[ti]);
    let ty = TOP;
    doc.font("Helvetica").fontSize(13).fillColor(HEADING).text("Table of Contents", MARGIN_X, ty);
    ty = doc.y + 6;
    for (const e of toc) {
      if (ty + 18 > BOTTOM && ti < tocPages.length - 1) { doc.switchToPage(tocPages[++ti]); ty = TOP; }
      const indent = e.level ? 18 : 0;
      doc.font(e.level ? "Helvetica" : "Helvetica-Bold").fontSize(e.level ? 10 : 10.5).fillColor(INK);
      const label = e.text;
      const page = String(e.page);
      const lw = Math.min(doc.widthOfString(label), CONTENT_W - indent - 40);
      doc.text(label, MARGIN_X + indent, ty, { width: CONTENT_W - indent - 40, lineBreak: false, ellipsis: true });
      const pw = doc.widthOfString(page);
      doc.text(page, MARGIN_X + CONTENT_W - pw, ty, { lineBreak: false });
      doc.font("Helvetica").fontSize(9).fillColor(MUTED);
      const dot = doc.widthOfString(".");
      const from = MARGIN_X + indent + lw + 4;
      const to = MARGIN_X + CONTENT_W - pw - 4;
      if (to > from) doc.text(".".repeat(Math.max(0, Math.floor((to - from) / dot))), from, ty + 1, { lineBreak: false });
      ty += e.level ? 17 : 20;
    }
  }

  // ── Every page: logo, watermark, footer ──
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits below the body's bottom margin - lift it so pdfkit
    // doesn't start a new page for it.
    doc.page.margins.bottom = 0;
    try { doc.image(logo, MARGIN_X - 6, 34, { width: 120 }); } catch { /* bad logo */ }
    doc.save();
    doc.opacity(0.06);
    try { doc.image(logo, (PAGE_W - 440) / 2, PAGE_H / 2 - 110, { width: 440 }); } catch { /* bad logo */ }
    doc.restore();
    doc.opacity(1);
    doc.font("Helvetica").fontSize(9.5).fillColor(INK);
    doc.text(data.title, MARGIN_X, 792, { width: CONTENT_W - 120, lineBreak: false, ellipsis: true });
    const label = `Page ${i - range.start + 1} of ${total}`;
    const w = doc.widthOfString(label);
    doc.font("Helvetica").text("Page ", MARGIN_X + CONTENT_W - w, 792, { continued: true, lineBreak: false })
      .font("Helvetica-Bold").text(String(i - range.start + 1), { continued: true })
      .font("Helvetica").text(" of ", { continued: true })
      .font("Helvetica-Bold").text(String(total), { lineBreak: false });
  }
  return doc;
}

function currentPage(doc: PDFKit.PDFDocument) {
  const r = doc.bufferedPageRange();
  return r.start + r.count - 1;
}

function drawCover(doc: PDFKit.PDFDocument, data: BrsPdfData) {
  // Department band.
  const bandY = 188;
  doc.rect(MARGIN_X - 2, bandY, CONTENT_W + 4, 36).fill(NAVY);
  const band = data.department || data.brs_type_name || "Products and Services";
  let bandSize = 22;
  doc.font("Helvetica-Bold");
  while (bandSize > 11 && doc.fontSize(bandSize).widthOfString(band) > CONTENT_W - 16) bandSize -= 1;
  doc.fontSize(bandSize).fillColor("#ffffff").text(band, MARGIN_X, bandY + (36 - bandSize) / 2 + 1, { width: CONTENT_W, align: "center", lineBreak: false, ellipsis: true });
  doc.font("Helvetica-Bold").fontSize(21).fillColor(INK).text("Business Requirement Specification", MARGIN_X, bandY + 52, { width: CONTENT_W, align: "center" });
  doc.font("Helvetica-Bold").fontSize(24).fillColor(INK).text(data.title, MARGIN_X, bandY + 118, { width: CONTENT_W, align: "center" });

  // Version table.
  const tableX = MARGIN_X + 45;
  const labelW = 125;
  const valueW = CONTENT_W - 90 - labelW;
  let ty = Math.max(doc.y + 26, 372);
  const row = (label: string, value: string, opts: { boldLabel?: boolean; boldValue?: boolean; h?: number } = {}) => {
    const h = opts.h ?? 23;
    doc.rect(tableX, ty, labelW, h).fill(NAVY);
    doc.rect(tableX, ty, labelW + valueW, h).lineWidth(0.6).strokeColor(GRID).stroke();
    doc.moveTo(tableX + labelW, ty).lineTo(tableX + labelW, ty + h).stroke();
    doc.font(opts.boldLabel ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#ffffff").text(label, tableX + 6, ty + 7, { width: labelW - 12, lineBreak: false });
    doc.font(opts.boldValue ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(INK).text(value || "", tableX + labelW + 6, ty + 7, { width: valueW - 12, lineBreak: false, ellipsis: true });
    ty += h;
  };
  row("Version", data.version_label || "Draft");
  row("Changed on", data.changed_on ? fmtDay(data.changed_on) : "");
  row("Changed by", data.changed_by || "");
  row("Product Owner", data.product_owner || "", { boldLabel: true, boldValue: true });

  // Reviewers.
  ty += 46;
  row("Version", data.version_label || "Draft", { boldLabel: true, h: 28 });
  const reviewers = (data.reviewers || []).filter((r) => r.name);
  (reviewers.length ? reviewers : [{ name: "" }]).slice(0, 6).forEach((r) => row("Reviewed by", r.name, { boldLabel: true, h: 28 }));

  doc.font("Helvetica-BoldOblique").fontSize(10).fillColor(INK)
    .text("Please note that all previous versions of this document is null and void", MARGIN_X, Math.max(ty + 70, 668), { width: CONTENT_W, align: "center" })
    .moveDown(0.6)
    .text("as this document supersedes all prior related Business Requirement Specification", { width: CONTENT_W, align: "center" });
}

function drawBlock(
  doc: PDFKit.PDFDocument, b: Block, y: number, sectionNo: number, nextSub: () => number,
  toc: Array<{ text: string; page: number; level: 0 | 1 }>, images: Map<string, Buffer | null>, ensure: (h: number) => boolean
): number {
  const reset = () => (y = TOP);
  if (b.kind === "heading") {
    if (ensure(40)) reset(); else y += 4;
    // Heading 1/2 are numbered N.M and listed in the contents; smaller ones aren't.
    const subNo = b.level <= 2 ? nextSub() : 0;
    const label = subNo ? `${sectionNo}.${subNo}  ${b.text}` : b.text;
    if (subNo) toc.push({ text: label, page: currentPage(doc) + 1, level: 1 });
    doc.font("Helvetica-Bold").fontSize(b.level <= 2 ? 12.5 : 11).fillColor(HEADING).text(label, MARGIN_X, y, { width: CONTENT_W });
    return doc.y + 6;
  }
  if (b.kind === "para") {
    const indent = b.quote ? 18 : 0;
    const h = runsHeight(doc, b.runs, CONTENT_W - indent, BODY, b.mono);
    if (h > BOTTOM - TOP) {
      // Very long paragraph: let pdfkit flow it across pages.
      if (ensure(40)) reset();
      drawRuns(doc, b.runs, MARGIN_X + indent, y, CONTENT_W - indent, { size: BODY, align: b.align, mono: b.mono });
      return doc.y + 7;
    }
    if (ensure(h)) reset();
    if (b.quote) doc.rect(MARGIN_X, y, 3, h).fill("#9ca3af");
    drawRuns(doc, b.runs, MARGIN_X + indent, y, CONTENT_W - indent, { size: BODY, align: b.align, mono: b.mono, color: b.quote ? MUTED : undefined });
    return doc.y + (b.tight ? 1 : 7);
  }
  if (b.kind === "item") {
    const indent = 18 + b.depth * 18;
    const textW = CONTENT_W - indent - 4;
    const h = runsHeight(doc, b.runs, textW, BODY);
    if (ensure(Math.min(h, BOTTOM - TOP))) reset();
    doc.font("Helvetica").fontSize(BODY).fillColor(INK).text(b.marker, MARGIN_X + indent - 16, y, { width: 16, lineBreak: false });
    drawRuns(doc, b.runs, MARGIN_X + indent + 4, y, textW, { size: BODY, align: "left" });
    return doc.y + 3;
  }
  if (b.kind === "rule") {
    if (ensure(12)) reset();
    doc.moveTo(MARGIN_X, y + 4).lineTo(MARGIN_X + CONTENT_W, y + 4).lineWidth(0.7).strokeColor("#9ca3af").stroke();
    return y + 12;
  }
  if (b.kind === "image") {
    const img = images.get(b.src);
    if (!img) return y;
    let w = CONTENT_W;
    let h = 0;
    try {
      const probe = (doc as any).openImage(img);
      const natural = probe.width * 0.75; // px -> pt at 96 dpi
      w = Math.min(CONTENT_W, b.width ? b.width * 0.75 : natural);
      h = (probe.height / probe.width) * w;
      if (h > BOTTOM - TOP - 20) { h = BOTTOM - TOP - 20; w = (probe.width / probe.height) * h; }
      if (ensure(h + 8)) reset();
      doc.image(probe, MARGIN_X + (CONTENT_W - w) / 2, y, { width: w, height: h });
    } catch { return y; }
    return y + h + 10;
  }
  // Table.
  const cols = Math.max(...b.rows.map((r) => r.reduce((t, c) => t + c.colspan, 0)));
  // Column widths: by the longest text in each column, within limits.
  doc.font("Helvetica").fontSize(9.5);
  const want = Array.from({ length: cols }, () => 40);
  for (const r of b.rows) {
    let ci = 0;
    for (const c of r) {
      if (c.colspan === 1) want[ci] = Math.max(want[ci], Math.min(220, doc.widthOfString(plain(c.runs) || " ") + 14));
      ci += c.colspan;
    }
  }
  const sum = want.reduce((a, v) => a + v, 0);
  const widths = want.map((v) => (v / sum) * CONTENT_W);
  const headerRows = b.rows.filter((r, i) => i === 0 && r.every((c) => c.header));
  const rowHeight = (r: Cell[]) => {
    let ci = 0; let h = 18;
    for (const c of r) {
      const w = widths.slice(ci, ci + c.colspan).reduce((a, v) => a + v, 0);
      font(doc, { bold: c.header || c.runs.every((x) => x.bold) }).fontSize(9.5);
      h = Math.max(h, doc.heightOfString(plain(c.runs) || " ", { width: w - 10, lineGap: 1 }) + 10);
      ci += c.colspan;
    }
    return h;
  };
  const drawRow = (r: Cell[], h: number) => {
    let x = MARGIN_X; let ci = 0;
    for (const c of r) {
      const w = widths.slice(ci, ci + c.colspan).reduce((a, v) => a + v, 0);
      const fill = c.header ? NAVY : c.bg && c.bg.toLowerCase() !== "#ffffff" ? c.bg : null;
      if (fill) doc.rect(x, y, w, h).fill(fill);
      doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(GRID).stroke();
      const runs = c.header ? c.runs.map((run) => ({ ...run, bold: true, color: "#ffffff" })) : c.runs;
      drawRuns(doc, runs.length ? runs : [{ text: " " }], x + 5, y + 5, w - 10, { size: 9.5, align: "left" });
      x += w; ci += c.colspan;
    }
    y += h;
  };
  if (ensure(Math.min(rowHeight(b.rows[0]) + (b.rows[1] ? rowHeight(b.rows[1]) : 0), BOTTOM - TOP))) reset();
  y += 2;
  b.rows.forEach((r, i) => {
    const h = Math.min(rowHeight(r), BOTTOM - TOP - 40);
    if (y + h > BOTTOM) {
      doc.addPage(); y = TOP;
      // Repeat the header row on the new page.
      if (headerRows.length && i > 0) drawRow(headerRows[0], rowHeight(headerRows[0]));
    }
    drawRow(r, h);
  });
  return y + 10;
}
