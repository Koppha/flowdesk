import PDFDocument from "pdfkit";
import fs from "fs";
import type { PdfLetterhead } from "./genericPdfRenderer.js";

export interface BrsPdfSection {
  title: string;
  content_html: string | null;
}

export interface BrsPdfApprover {
  position_name: string | null;
  approver_name: string | null;
  status?: string | null;
  acted_at?: string | null;
}

export interface BrsPdfData {
  title: string;
  reference_no: string | null;
  requester_name: string | null;
  phase: string;
  baselined_at: string | null;
  sections: BrsPdfSection[];
  // Cover-page-only extras - optional so callers that don't have them (or
  // ever add a second BRS PDF caller later) don't have to fabricate values.
  brs_type_name?: string | null;
  department?: string | null;
  product_owner?: string | null;
  target_quarter?: string | null;
  // Every department that contributed a Department Input section (distinct,
  // derived from that section's assignees) - separate from `department`
  // above, which is just the single requesting department from Intake.
  departments_included?: string[];
  // The approval chain once this BRS has actually been routed - omitted
  // (or empty) before that, in which case the cover page leaves the whole
  // block out rather than showing an empty "Approvers" heading.
  approvers?: BrsPdfApprover[];
}

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const ACCENT = "#0b4dea";
const ACCENT_SOFT = "#eef2ff";

const PAGE_WIDTH = 595.28;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function stripEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export type BrsContentLine = { text: string; heading: number | null };

// A BRS document doesn't need the admin-designed pdf_templates mechanism —
// there's no scalar-field layout to design, since its section titles are
// already fully described by the per-document snapshot. This renders
// directly with pdfkit instead. Rich-text content is flattened to plain
// text (paragraph/list structure kept, inline bold/italic styling is not) —
// a deliberate v1 simplification, not a rendering bug. Headings (H1-H6,
// from the RichTextField's paragraph-style dropdown) are pulled out
// separately rather than flattened like every other block, so the caller
// can both style them distinctly in the body and list them in the Table of
// Contents as sub-entries of their section.
function htmlToStructuredLines(html: string | null): BrsContentLine[] {
  if (!html) return [{ text: "—", heading: null }];
  const headings: { level: number; text: string }[] = [];
  const withMarkers = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
    const idx = headings.length;
    headings.push({ level: Number(level), text: stripEntities(String(inner).replace(/<[^>]*>/g, "")).trim() });
    return `\n@@HEADING_${idx}@@\n`;
  });
  const withBreaks = withMarkers
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  const text = stripEntities(withBreaks.replace(/<[^>]*>/g, ""));
  const rawLines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const lines: BrsContentLine[] = rawLines.map((line) => {
    const m = /^@@HEADING_(\d+)@@$/.exec(line);
    if (!m) return { text: line, heading: null };
    const h = headings[Number(m[1])];
    return { text: h?.text || "—", heading: h?.level ?? null };
  });
  return lines.length ? lines : [{ text: "—", heading: null }];
}

function countHeadings(html: string | null): number {
  if (!html) return 0;
  return (html.match(/<h[1-6][^>]*>/gi) || []).length;
}

function resolveLogoSource(letterhead: PdfLetterhead): string | null {
  return letterhead.logo_data || (letterhead.logo_path && fs.existsSync(letterhead.logo_path) ? letterhead.logo_path : null);
}

// A single label/value row for the cover page's metadata card - skipped
// entirely when the value is missing, so an optional field (product owner,
// target quarter) never leaves a blank row behind. Every value here is a
// short label/name/date, never more than one line, so rows advance by a
// fixed height rather than measuring wrapped text - keeps this a single
// drawing pass instead of a measure-then-redraw dance.
const META_ROW_HEIGHT = 34;
function metaRow(doc: PDFKit.PDFDocument, x: number, y: number, width: number, label: string, value: string | null | undefined): number {
  if (!value) return y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, { width, characterSpacing: 0.4, lineBreak: false });
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(value, x, y + 11, { width, lineBreak: false, ellipsis: true });
  return y + META_ROW_HEIGHT;
}

// How many of a side's rows will actually be drawn (i.e. have a value) -
// lets the panel's height be computed up front, before anything is drawn.
function countMetaRows(values: Array<string | null | undefined>): number {
  return values.filter(Boolean).length;
}

// Department name "chips" - a wrapping row of small filled pills, since a
// plain comma-joined list reads poorly once there are more than two or
// three contributing departments.
function drawChips(doc: PDFKit.PDFDocument, x: number, y: number, maxWidth: number, labels: string[]): number {
  const chipHeight = 18;
  const chipGapX = 6;
  const chipGapY = 8;
  const padX = 8;
  doc.font("Helvetica").fontSize(8.5);
  let cx = x;
  let cy = y;
  for (const label of labels) {
    const w = doc.widthOfString(label) + padX * 2;
    if (cx + w > x + maxWidth) { cx = x; cy += chipHeight + chipGapY; }
    doc.roundedRect(cx, cy, w, chipHeight, 9).fill(ACCENT_SOFT);
    doc.fillColor(ACCENT).text(label, cx + padX, cy + 4.5, { lineBreak: false });
    cx += w + chipGapX;
  }
  return cy + chipHeight;
}

function drawCoverPage(doc: PDFKit.PDFDocument, letterhead: PdfLetterhead, data: BrsPdfData) {
  // Thin brand rule across the very top of the page - the one spot of
  // color on an otherwise restrained, text-led cover.
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(ACCENT);

  const logoSource = resolveLogoSource(letterhead);
  const headY = 46;
  // The logo IS the company's identity mark - only fall back to printing
  // the name in bold when there's no logo to show instead of it, so a
  // configured letterhead never shows the company name twice in the header.
  if (logoSource) {
    try { doc.image(logoSource, MARGIN, headY, { width: 96 }); } catch { /* ignore bad logo data */ }
  } else if (letterhead.company_name) {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(letterhead.company_name, MARGIN, headY);
  }
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  let addressY = 148;
  for (const line of letterhead.address_lines || []) {
    doc.text(line, MARGIN, addressY, { width: 300 });
    addressY = doc.y;
  }
  if (letterhead.contact_line) doc.text(letterhead.contact_line, MARGIN, doc.y, { width: 300 });

  // Document identity block - vertically anchored a bit below center so the
  // title always has room to wrap without crowding the header or the
  // metadata card beneath it.
  const titleTop = 240;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(ACCENT)
    .text((data.brs_type_name || "Business Requirement Specification").toUpperCase(), MARGIN, titleTop, { width: CONTENT_WIDTH, characterSpacing: 1.2 });
  doc.font("Helvetica-Bold").fontSize(27).fillColor(INK)
    .text(data.title, MARGIN, doc.y + 10, { width: CONTENT_WIDTH, lineGap: 2 });

  // Metadata card - a light-tinted panel with label/value pairs, the one
  // piece of real structure on the page besides the title itself.
  const cardTop = Math.max(doc.y + 26, 390);
  const cardPadding = 22;
  const col2X = MARGIN + cardPadding + (CONTENT_WIDTH - cardPadding * 2) / 2;
  const colWidth = col2X - MARGIN - cardPadding - 16;
  const col2Width = MARGIN + CONTENT_WIDTH - cardPadding - col2X;

  const baselinedLabel = data.baselined_at
    ? new Date(data.baselined_at).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const leftValues = [data.reference_no, data.department, data.product_owner];
  const rightValues = [data.requester_name, data.phase.replace(/_/g, " "), data.target_quarter, baselinedLabel];
  const rowCount = Math.max(countMetaRows(leftValues), countMetaRows(rightValues));
  const cardHeight = cardPadding * 2 + rowCount * META_ROW_HEIGHT - (META_ROW_HEIGHT - 24);
  doc.roundedRect(MARGIN, cardTop, CONTENT_WIDTH, cardHeight, 6).fill(ACCENT_SOFT);

  let leftY = cardTop + cardPadding;
  let rightY = cardTop + cardPadding;
  leftY = metaRow(doc, MARGIN + cardPadding, leftY, colWidth, "Reference", data.reference_no);
  leftY = metaRow(doc, MARGIN + cardPadding, leftY, colWidth, "Requesting Department", data.department);
  leftY = metaRow(doc, MARGIN + cardPadding, leftY, colWidth, "Product Owner", data.product_owner);
  rightY = metaRow(doc, col2X, rightY, col2Width, "Requester", data.requester_name);
  rightY = metaRow(doc, col2X, rightY, col2Width, "Status", data.phase.replace(/_/g, " "));
  rightY = metaRow(doc, col2X, rightY, col2Width, "Target Quarter", data.target_quarter);
  metaRow(doc, col2X, rightY, col2Width, "Baselined", baselinedLabel);

  // Departments Included - the distinct departments that actually
  // contributed a Department Input section, as chips. Skipped entirely
  // before any section has been assigned to anyone.
  let belowY = cardTop + cardHeight + 26;
  const departments = (data.departments_included || []).filter(Boolean);
  if (departments.length) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("DEPARTMENTS INCLUDED", MARGIN, belowY, { characterSpacing: 0.4 });
    belowY = drawChips(doc, MARGIN, doc.y + 6, CONTENT_WIDTH, departments) + 20;
  }

  // Approval Chain - who signs this off, in order, plus exactly when each
  // one actually acted (a real audit-trail timestamp, not just a name) -
  // still shown as "Awaiting approval" for anyone further down the chain
  // whose turn hasn't come yet. Skipped entirely before the document has
  // actually been routed for approval.
  const approvers = (data.approvers || []).filter((a) => a.approver_name);
  if (approvers.length && belowY < 690) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("APPROVAL CHAIN", MARGIN, belowY, { characterSpacing: 0.4 });
    let ay = doc.y + 6;
    approvers.forEach((a, i) => {
      if (ay > 690) return; // hard stop before the footer - realistically never hit
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(`${i + 1}.`, MARGIN, ay, { width: 16, lineBreak: false });
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(a.approver_name || "—", MARGIN + 16, ay, { width: 220, lineBreak: false });
      doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(a.position_name || "", MARGIN + 240, ay, { width: CONTENT_WIDTH - 240, lineBreak: false });
      const actionLabel = a.status === "REJECTED" ? "Rejected" : a.status === "NOTED" ? "Noted" : "Approved";
      const stampLabel = a.acted_at
        ? `${actionLabel} — ${new Date(a.acted_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : "Awaiting approval";
      doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED).text(stampLabel, MARGIN + 16, ay + 12, { width: CONTENT_WIDTH - 16, lineBreak: false });
      ay += 27;
    });
  }

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Generated ${new Date().toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`, MARGIN, 760, { width: CONTENT_WIDTH, align: "center" });
  if (letterhead.footer_confidentiality_text) {
    doc.text(letterhead.footer_confidentiality_text, MARGIN, 772, { width: CONTENT_WIDTH, align: "center" });
  }
}

// Compact running header for the Table of Contents and every content page -
// deliberately much smaller than the cover page's own letterhead, so the
// document's actual content stays the visual focus from page 2 onward.
function drawRunningHeader(doc: PDFKit.PDFDocument, letterhead: PdfLetterhead, data: BrsPdfData) {
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(data.title, MARGIN, 38, { width: 340 });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(data.reference_no || "", MARGIN, 38, { width: CONTENT_WIDTH, align: "right" });
  doc.moveTo(MARGIN, 54).lineTo(MARGIN + CONTENT_WIDTH, 54).strokeColor(RULE).lineWidth(1).stroke();
  doc.x = MARGIN;
  doc.y = 68;
}

function drawContentFooter(doc: PDFKit.PDFDocument, letterhead: PdfLetterhead, pageLabel: string) {
  doc.moveTo(MARGIN, 762).lineTo(MARGIN + CONTENT_WIDTH, 762).strokeColor(RULE).lineWidth(0.5).stroke();
  const footerLine = [letterhead.company_name, ...(letterhead.address_lines || []), letterhead.contact_line].filter(Boolean).join("  ·  ");
  doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(footerLine, MARGIN, 770, { width: CONTENT_WIDTH - 70, align: "left" });
  doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(pageLabel, MARGIN + CONTENT_WIDTH - 70, 770, { width: 70, align: "right" });
  if (letterhead.footer_confidentiality_text) {
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(letterhead.footer_confidentiality_text, MARGIN, 781, { width: CONTENT_WIDTH, align: "left" });
  }
}

type TocEntry = { text: string; page: number; level: 0 | 1 };

function drawTocPageHeader(doc: PDFKit.PDFDocument, isFirst: boolean): number {
  if (isFirst) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(ACCENT).text("CONTENTS", MARGIN, 60, { characterSpacing: 1.2 });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text("Table of Contents", MARGIN, doc.y + 4);
    return doc.y + 20;
  }
  doc.font("Helvetica-Bold").fontSize(12).fillColor(MUTED).text("Table of Contents (continued)", MARGIN, 60);
  return doc.y + 16;
}

function drawTocEntry(doc: PDFKit.PDFDocument, y: number, entry: TocEntry) {
  const indent = entry.level === 1 ? 20 : 0;
  const x = MARGIN + indent;
  const width = CONTENT_WIDTH - indent;
  doc.font(entry.level === 0 ? "Helvetica" : "Helvetica-Oblique").fontSize(entry.level === 0 ? 11 : 9.5)
    .fillColor(entry.level === 0 ? INK : MUTED);
  const pageLabel = String(entry.page);
  const labelWidth = doc.widthOfString(entry.text);
  const pageLabelWidth = doc.widthOfString(pageLabel);
  doc.text(entry.text, x, y, { lineBreak: false });
  doc.text(pageLabel, MARGIN + CONTENT_WIDTH - pageLabelWidth, y, { lineBreak: false });
  // Dotted leader filling the gap between the title and its page number -
  // the classic TOC connector, drawn as a run of small circular dots
  // rather than a solid rule so it reads as a guide, not a divider.
  const dotsStart = x + labelWidth + 6;
  const dotsEnd = MARGIN + CONTENT_WIDTH - pageLabelWidth - 6;
  if (dotsEnd > dotsStart) {
    doc.fillColor(RULE);
    const dotY = y + (entry.level === 0 ? 5.5 : 5);
    for (let dx = dotsStart; dx < dotsEnd; dx += 4) doc.circle(dx, dotY, 0.6).fill();
  }
}

export function renderBrsPdf(letterhead: PdfLetterhead, data: BrsPdfData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });

  // ---- Page 1: cover ----
  drawCoverPage(doc, letterhead, data);

  // ---- Table of Contents — reserved up front, right after the cover,
  // before any content page exists. PDFKit can't insert a page into the
  // middle of an already-buffered document later, so the number of TOC
  // pages has to be decided now, from a cheap pre-scan of how many
  // section + in-content-heading entries there will actually be, rather
  // than counted precisely as they're laid out below. ----
  const totalEntries = data.sections.length + data.sections.reduce((sum, s) => sum + countHeadings(s.content_html), 0);
  const ENTRIES_PER_TOC_PAGE = 24;
  const tocPageCount = Math.max(1, Math.ceil(totalEntries / ENTRIES_PER_TOC_PAGE));
  const tocPageIndices: number[] = [];
  for (let i = 0; i < tocPageCount; i++) {
    doc.addPage();
    tocPageIndices.push(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
  }

  // ---- Content pages ----
  type ContentPage = { pdfIndex: number; humanPage: number };
  const contentPages: ContentPage[] = [];
  const tocEntries: TocEntry[] = [];

  function startContentPage() {
    doc.addPage();
    const pdfIndex = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const humanPage = contentPages.length + 1;
    contentPages.push({ pdfIndex, humanPage });
    drawRunningHeader(doc, letterhead, data);
    return humanPage;
  }

  startContentPage();
  data.sections.forEach((section, sectionIdx) => {
    if (doc.y > 690) startContentPage();
    const sectionNumber = sectionIdx + 1;
    tocEntries.push({ text: `${sectionNumber}.  ${section.title}`, page: contentPages[contentPages.length - 1].humanPage, level: 0 });

    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(INK).text(section.title, { width: CONTENT_WIDTH });
    doc.moveDown(0.3);

    let headingIdx = 0;
    let isFirstLine = true;
    for (const line of htmlToStructuredLines(section.content_html)) {
      if (doc.y > 710) startContentPage();
      if (line.heading) {
        headingIdx += 1;
        if (!isFirstLine) doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(line.heading <= 2 ? 10.5 : 10).fillColor(INK).text(line.text, { width: CONTENT_WIDTH });
        doc.moveDown(0.15);
        tocEntries.push({ text: `${sectionNumber}.${headingIdx}  ${line.text}`, page: contentPages[contentPages.length - 1].humanPage, level: 1 });
      } else {
        doc.font("Helvetica").fontSize(10).fillColor("#1f2937").text(line.text, { width: CONTENT_WIDTH });
      }
      isFirstLine = false;
    }
    doc.moveDown(0.9);
  });

  // Stamp "Page X of Y" (and the running footer) onto every content page
  // now that the total is finally known — bufferPages:true keeps every
  // page revisitable with switchToPage until the document is ended.
  const totalContentPages = contentPages.length;
  for (const cp of contentPages) {
    doc.switchToPage(cp.pdfIndex);
    drawContentFooter(doc, letterhead, `Page ${cp.humanPage} of ${totalContentPages}`);
  }

  // ---- Back-fill the Table of Contents, spilling onto the next reserved
  // TOC page whenever the current one runs out of room. ----
  let tocPageCursor = 0;
  doc.switchToPage(tocPageIndices[0]);
  let entryY = drawTocPageHeader(doc, true);
  const ROW_HEIGHT = { 0: 22, 1: 18 } as const;
  for (const entry of tocEntries) {
    const rowHeight = ROW_HEIGHT[entry.level];
    if (entryY + rowHeight > 745 && tocPageCursor < tocPageIndices.length - 1) {
      tocPageCursor += 1;
      doc.switchToPage(tocPageIndices[tocPageCursor]);
      entryY = drawTocPageHeader(doc, false);
    }
    drawTocEntry(doc, entryY, entry);
    entryY += rowHeight;
  }

  return doc;
}
