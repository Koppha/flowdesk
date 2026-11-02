import PDFDocument from "pdfkit";
import fs from "fs";
import type { PdfLetterhead } from "./genericPdfRenderer.js";

// A Change Request's comments and full history as one document to download
// and keep - the workspace's Comments and History tabs on paper, oldest
// first so it reads as the record of how the request got where it is.
// Values arrive already formatted (names, option labels); this only lays out.

export interface CrRecordChange { label: string; before: string; after: string }
export interface CrRecordComment { author: string; role: string | null; section: string | null; body: string; created_at: string }
export interface CrRecordEvent {
  actor: string;
  role: string | null;
  kind: string;
  section: string | null;
  summary: string;
  created_at: string;
  changes: CrRecordChange[];
}
export interface CrRecordPdfData {
  reference: string;
  title: string;
  status: string;
  creator: string | null;
  created_at: string;
  owners: string[];
  co_writers: Array<{ label: string; access: string }>;
  downloaded_by: string | null;
  comments: CrRecordComment[];
  history: CrRecordEvent[];
}

const INK = "#111827";
const BODY = "#1f2937";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const ACCENT = "#0b4dea";
const ACCENT_SOFT = "#eef2ff";
const BEFORE = "#b91c1c";
const AFTER = "#15803d";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
// Content stays between these, leaving room for the running header (pages
// 2+) and the footer, both drawn once every page exists.
const TOP = 72;
const BOTTOM = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = PAGE_HEIGHT - BOTTOM;

const ROLE_LABEL: Record<string, string> = {
  CREATOR: "Creator", OWNER: "Co-owner", CO_WRITER: "Co-writer", CONTRIBUTOR: "Contributor", APPROVER: "Approver", ADMIN: "Admin"
};
const KIND_LABEL: Record<string, string> = {
  CREATED: "Submitted", DRAFT_CREATED: "Started the draft", SUBMITTED: "Submitted for approval", FIELDS_SAVED: "Edited",
  SECTION_ADDED: "Added a section", SECTION_REMOVED: "Removed a section", SECTION_SAVED: "Edited a section",
  PEOPLE_CHANGED: "People", COMMENTED: "Comment", ASSIGNEE_ADDED: "Assignee added", ASSIGNEE_CONFIRMED: "Assignee confirmed",
  APPROVAL_ACTION: "Approval", CANCELLED: "Cancelled", CLOSED: "Closed", DISTRIBUTED: "Distributed", RAID_CHANGED: "RAID log"
};

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Maseru", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

// The built-in Helvetica only has WinAnsi glyphs; anything else (emoji,
// arrows) would print as garbage, so swap it for something that prints.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const SWAP: Record<string, string> = { "→": "->", "←": "<-" };
function printable(s: string | null | undefined): string {
  let out = "";
  for (const ch of String(s ?? "").replace(/\r\n?/g, "\n").replace(/[​-‍︀-️]/g, "")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n" || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch === "\t") out += "    ";
    else out += SWAP[ch] ?? "?";
  }
  return out;
}

function resolveLogoSource(letterhead: PdfLetterhead): string | null {
  return letterhead.logo_data || (letterhead.logo_path && fs.existsSync(letterhead.logo_path) ? letterhead.logo_path : null);
}

// One line, cut short with an ellipsis rather than wrapping.
function oneLine(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, font: string, size: number, color: string, align: "left" | "right" = "left") {
  doc.font(font).fontSize(size).fillColor(color).text(printable(text), x, y, { width, height: size * 1.5, ellipsis: true, align });
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height > CONTENT_BOTTOM) doc.addPage();
  doc.x = MARGIN;
}

function divider(doc: PDFKit.PDFDocument) {
  doc.y += 8;
  if (doc.y < CONTENT_BOTTOM) doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y += 10;
  doc.x = MARGIN;
}

function statusLabel(status: string) {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function drawFirstPageHead(doc: PDFKit.PDFDocument, letterhead: PdfLetterhead, data: CrRecordPdfData) {
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(ACCENT);
  const logo = resolveLogoSource(letterhead);
  if (logo) {
    try { doc.image(logo, MARGIN, 28, { fit: [130, 46] }); } catch { /* ignore bad logo data */ }
  } else if (letterhead.company_name) {
    oneLine(doc, letterhead.company_name, MARGIN, 40, 260, "Helvetica-Bold", 13, INK);
  }
  oneLine(doc, `Downloaded ${stamp(new Date().toISOString())}`, MARGIN + CONTENT_WIDTH - 220, 36, 220, "Helvetica", 8, MUTED, "right");
  if (data.downloaded_by) oneLine(doc, `by ${data.downloaded_by}`, MARGIN + CONTENT_WIDTH - 220, 47, 220, "Helvetica", 8, MUTED, "right");

  doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT)
    .text("CHANGE REQUEST  ·  COMMENTS & HISTORY", MARGIN, 100, { width: CONTENT_WIDTH, characterSpacing: 1.1 });
  doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text(printable(data.title), MARGIN, doc.y + 6, { width: CONTENT_WIDTH, lineGap: 1 });

  // Reference, status and who started it, in a tinted card.
  const top = doc.y + 14;
  const pad = 16;
  const rowHeight = 30;
  const colWidth = (CONTENT_WIDTH - pad * 2) / 2;
  const rows: Array<[string, string, string, string]> = [
    ["Reference", data.reference, "Status", statusLabel(data.status)],
    ["Started by", data.creator || "—", "Started on", stamp(data.created_at)]
  ];
  const height = pad * 2 + rows.length * rowHeight - 6;
  doc.roundedRect(MARGIN, top, CONTENT_WIDTH, height, 6).fill(ACCENT_SOFT);
  rows.forEach(([l1, v1, l2, v2], i) => {
    const y = top + pad + i * rowHeight;
    for (const [x, label, value] of [[MARGIN + pad, l1, v1], [MARGIN + pad + colWidth, l2, v2]] as const) {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colWidth - 12, characterSpacing: 0.4, lineBreak: false });
      oneLine(doc, value, x, y + 10, colWidth - 12, "Helvetica", 10, INK);
    }
  });
  doc.x = MARGIN;
  doc.y = top + height + 18;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("PEOPLE", MARGIN, doc.y, { characterSpacing: 0.4 });
  doc.y += 4;
  const people: Array<[string, string]> = [
    ["Creator", data.creator || "—"],
    ["Co-owners", data.owners.length ? data.owners.join(", ") : "None"],
    ["Co-writers", data.co_writers.length ? data.co_writers.map((c) => `${c.label} (${c.access})`).join(", ") : "None"]
  ];
  for (const [label, value] of people) {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(label, MARGIN, y, { width: 76, lineBreak: false });
    doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(printable(value), MARGIN + 76, y, { width: CONTENT_WIDTH - 76 });
    doc.x = MARGIN;
    doc.y += 4;
  }
}

function partHeading(doc: PDFKit.PDFDocument, title: string, note: string) {
  ensureSpace(doc, 110);
  doc.y += 14;
  doc.font("Helvetica-Bold").fontSize(14).fillColor(INK).text(title, MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(note, MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
  const y = doc.y + 6;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor(INK).lineWidth(0.75).stroke();
  doc.x = MARGIN;
  doc.y = y + 12;
}

// "Name · Role" on the left, the time on the right, on one line.
function whoAndWhen(doc: PDFKit.PDFDocument, name: string, role: string | null, iso: string) {
  const y = doc.y;
  oneLine(doc, stamp(iso), MARGIN + CONTENT_WIDTH - 130, y + 1, 130, "Helvetica", 8, MUTED, "right");
  const roleLabel = role ? ROLE_LABEL[role] : null;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(printable(name), MARGIN, y, { width: CONTENT_WIDTH - 140, continued: !!roleLabel });
  if (roleLabel) doc.font("Helvetica").fillColor(MUTED).text(`  ·  ${roleLabel}`);
  doc.x = MARGIN;
}

function drawComment(doc: PDFKit.PDFDocument, c: CrRecordComment) {
  ensureSpace(doc, 60);
  whoAndWhen(doc, c.author, c.role, c.created_at);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(printable(`On ${c.section || "the whole request"}`), MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(10).fillColor(BODY).text(printable(c.body), MARGIN, doc.y + 5, { width: CONTENT_WIDTH, lineGap: 1.5 });
  divider(doc);
}

function drawValue(doc: PDFKit.PDFDocument, label: string, color: string, value: string) {
  ensureSpace(doc, 26);
  const x = MARGIN + 12;
  const y = doc.y + 3;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(color).text(label, x, y + 1.5, { width: 44, characterSpacing: 0.4, lineBreak: false });
  doc.font("Helvetica").fontSize(9.5).fillColor(BODY).text(printable(value), x + 46, y, { width: CONTENT_WIDTH - 58, lineGap: 1 });
  doc.x = MARGIN;
}

function drawEvent(doc: PDFKit.PDFDocument, e: CrRecordEvent) {
  ensureSpace(doc, 60);
  whoAndWhen(doc, e.actor, e.role, e.created_at);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
    .text(printable(`${KIND_LABEL[e.kind] || e.kind}${e.section ? `  ·  ${e.section}` : ""}`), MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(10).fillColor(BODY).text(printable(e.summary), MARGIN, doc.y + 4, { width: CONTENT_WIDTH, lineGap: 1.5 });
  for (const c of e.changes) {
    ensureSpace(doc, 48);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(printable(c.label), MARGIN + 12, doc.y + 7, { width: CONTENT_WIDTH - 12 });
    drawValue(doc, "BEFORE", BEFORE, c.before);
    drawValue(doc, "AFTER", AFTER, c.after);
  }
  divider(doc);
}

function drawRunningHeader(doc: PDFKit.PDFDocument, data: CrRecordPdfData) {
  oneLine(doc, data.title, MARGIN, 36, CONTENT_WIDTH - 190, "Helvetica-Bold", 8.5, INK);
  oneLine(doc, `${data.reference}  ·  Comments & history`, MARGIN + CONTENT_WIDTH - 180, 36.5, 180, "Helvetica", 8, MUTED, "right");
  doc.moveTo(MARGIN, 54).lineTo(MARGIN + CONTENT_WIDTH, 54).strokeColor(RULE).lineWidth(1).stroke();
}

function drawFooter(doc: PDFKit.PDFDocument, letterhead: PdfLetterhead, data: CrRecordPdfData, page: number, total: number) {
  // Below the bottom margin pdfkit would start a new page for any text.
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = PAGE_HEIGHT - 50;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor(RULE).lineWidth(0.5).stroke();
  const footerLine = [letterhead.company_name, ...(letterhead.address_lines || []), letterhead.contact_line].filter(Boolean).join("  ·  ");
  oneLine(doc, footerLine || data.reference, MARGIN, y + 8, CONTENT_WIDTH - 80, "Helvetica", 7, MUTED);
  oneLine(doc, `Page ${page} of ${total}`, MARGIN + CONTENT_WIDTH - 80, y + 8, 80, "Helvetica", 7, MUTED, "right");
  if (letterhead.footer_confidentiality_text) oneLine(doc, letterhead.footer_confidentiality_text, MARGIN, y + 19, CONTENT_WIDTH, "Helvetica", 7, MUTED);
  doc.page.margins.bottom = bottom;
}

export function renderChangeRequestRecordPdf(letterhead: PdfLetterhead, data: CrRecordPdfData): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: TOP, bottom: BOTTOM, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: `${data.reference} comments and history` }
  });

  drawFirstPageHead(doc, letterhead, data);

  partHeading(doc, "Comments", `${data.comments.length} ${data.comments.length === 1 ? "comment" : "comments"}, oldest first`);
  if (!data.comments.length) doc.font("Helvetica-Oblique").fontSize(10).fillColor(MUTED).text("No comments yet.", MARGIN, doc.y);
  for (const c of data.comments) drawComment(doc, c);

  partHeading(doc, "History", `${data.history.length} ${data.history.length === 1 ? "entry" : "entries"}, oldest first - who did what, with before and after values for every edit`);
  if (!data.history.length) doc.font("Helvetica-Oblique").fontSize(10).fillColor(MUTED).text("No history yet.", MARGIN, doc.y);
  for (const e of data.history) drawEvent(doc, e);

  // Every page exists now, so the totals are known.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i > range.start) drawRunningHeader(doc, data);
    drawFooter(doc, letterhead, data, i - range.start + 1, range.count);
  }
  return doc;
}
