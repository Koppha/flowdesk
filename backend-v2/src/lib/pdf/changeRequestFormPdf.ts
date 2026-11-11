import PDFDocument from "pdfkit";
import fs from "fs";
import type { PdfLetterhead } from "./genericPdfRenderer.js";
import { pdfSafeText } from "./pdfHelpers.js";

// A Change Request printed as ETL's paper Change Control form ("CHANGE
// REQUEST FORM", Change Control Procedure v2.0): the boxed header on every
// page, pink label cells, ticked change types and categories, implementation
// details on page 2, approvals and closure on page 3. Its own renderer, like
// the BRS one, because the admin-designed templates can't draw this grid.
// Layout is placed by hand (margins 0, no auto page breaks); long text is
// split across pages by line, with the section title repeated.

export interface CrFormCheck { label: string; checked: boolean }
export interface CrFormApproval {
  position: string;
  name: string | null;
  decision: "APPROVE" | "NOTE";
  status: string | null;
  acted_at: string | null;
  comment: string | null;
  current: boolean;
}
export interface CrFormPdfData {
  reference: string;
  date: string;
  status: string;
  requested_by: string | null;
  department: string | null;
  related_brs: string | null;
  date_requested: string | null;
  assignees: string | null;
  change_types: CrFormCheck[];
  categories: CrFormCheck[];
  urgent: boolean;
  description: string | null;
  justification: string | null;
  affected_areas: string | null;
  priority: string | null;
  component: string | null;
  platform: string | null;
  dependencies: string | null;
  number_of_changes: string | null;
  implementation_date: string | null;
  implementor: string | null;
  time_required: string | null;
  time_scheduled: string | null;
  risk: string | null;
  impact: string | null;
  implementation_plan: string | null;
  back_out_plan: string | null;
  callout_person: string | null;
  callout_contact: string | null;
  documentation: string | null;
  business_implications: string | null;
  extra_sections: Array<{ title: string; content: string }>;
  approvals: CrFormApproval[];
  closure: { closed_at: string | null; closed_by: string | null; implementation_date: string | null; notes: string | null } | null;
}

const PINK = "#fcc8c8";
const LINE = "#000000";
const INK = "#000000";
const MUTED = "#6b7280";
const FOOTER = "#9ca3af";
const APPROVED = "#15803d";
const NOTED = "#1d4ed8";
const REJECTED = "#b91c1c";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const X = 57;
const W = PAGE_WIDTH - X * 2;
const CONTENT_BOTTOM = PAGE_HEIGHT - 66;
const PAD_X = 4;
const PAD_Y = 3;

const LABEL_FONT = "Helvetica-Bold";
const LABEL_SIZE = 10;
const VALUE_FONT = "Times-Roman";
const VALUE_SIZE = 10;
const CHECK_INDENT = 13;
const CHECK_LINE = 11.8;
const CHECK_GAP = 1.2;

const longDate = (v: string | null | undefined) => {
  if (!v) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-GB", { timeZone: "Africa/Maseru", day: "numeric", month: "long", year: "numeric" });
};
const stampDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Maseru", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "");

function resolveLogoSource(letterhead: PdfLetterhead): string | null {
  return letterhead.logo_data || (letterhead.logo_path && fs.existsSync(letterhead.logo_path) ? letterhead.logo_path : null);
}

// Text broken into lines that fit `width`, keeping the writer's own line breaks.
function wrapLines(doc: PDFKit.PDFDocument, text: string, width: number, font: string, size: number): string[] {
  doc.font(font).fontSize(size);
  const out: string[] = [];
  for (const para of pdfSafeText(text).split("\n")) {
    let line = "";
    // Split on single spaces so a run of spaces inside a line is kept.
    for (const word of para.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) { line = candidate; continue; }
      if (line) out.push(line);
      // A word wider than the cell (a URL, a path) is broken by characters.
      let rest = word;
      while (doc.widthOfString(rest) > width) {
        let i = rest.length - 1;
        while (i > 1 && doc.widthOfString(rest.slice(0, i)) > width) i--;
        out.push(rest.slice(0, i));
        rest = rest.slice(i);
      }
      line = rest;
    }
    out.push(line);
  }
  while (out.length > 1 && !out[out.length - 1]) out.pop();
  return out;
}

type Cell =
  | { w: number; label: string; size?: number }
  | { w: number; value: string | null; font?: string; size?: number; align?: "left" | "center" }
  | { w: number; checks: CrFormCheck[] }
  | { w: number; stamp: CrFormApproval }
  | { w: number; pink: true }
  | { w: number; blank: true };

class FormWriter {
  y = 0;
  constructor(private doc: PDFKit.PDFDocument, private letterhead: PdfLetterhead, private data: CrFormPdfData) {}

  newPage(first = false) {
    if (!first) this.doc.addPage({ size: "A4", margin: 0 });
    this.drawHeader();
    this.y = 132;
  }

  // The boxed "CHANGE CONTROL PROCEDURE" header from the paper form.
  private drawHeader() {
    const doc = this.doc;
    const top = 36;
    const r1 = 44;
    const r2 = 26;
    const c = [X, X + 120, X + 165, X + 280, X + 377, X + W];
    doc.lineWidth(0.8).strokeColor(LINE);
    doc.rect(X, top, W, r1 + r2).stroke();
    for (const x of [c[1], c[3], c[4]]) doc.moveTo(x, top).lineTo(x, top + r1 + r2).stroke();
    doc.moveTo(c[2], top + r1).lineTo(c[2], top + r1 + r2).stroke();
    doc.moveTo(c[1], top + r1).lineTo(X + W, top + r1).stroke();

    const logo = resolveLogoSource(this.letterhead);
    if (logo) {
      try { doc.image(logo, X + 8, top + 12, { fit: [104, 46], align: "center", valign: "center" }); } catch { /* ignore bad logo data */ }
    } else {
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(pdfSafeText(this.letterhead.company_name || "ECONET"), X + 6, top + 28, { width: 108, align: "center", lineBreak: false });
    }
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text("CHANGE  CONTROL", c[1], top + 11, { width: c[3] - c[1], align: "center", lineBreak: false });
    doc.text("PROCEDURE", c[1], top + 25, { width: c[3] - c[1], align: "center", lineBreak: false });
    doc.fontSize(7.5).text("REFERENCE:", c[3] + 5, top + 6, { width: c[4] - c[3] - 8, characterSpacing: 0.3, lineBreak: false });
    doc.font("Helvetica").fontSize(9).text(this.data.reference, c[4] + 5, top + 17, { width: X + W - c[4] - 8, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7.5).text("DATE:", X + 125, top + r1 + 9, { width: 40, characterSpacing: 0.3, lineBreak: false });
    doc.font("Helvetica").fontSize(10.5).text(longDate(this.data.date), c[2] + 4, top + r1 + 7, { width: c[3] - c[2] - 8, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(7.5).text("CONFIDENTIALITY", c[3] + 5, top + r1 + 9, { width: c[4] - c[3] - 8, characterSpacing: 0.3, lineBreak: false });
    doc.fontSize(8).text("CONFIDENTIAL", c[4] + 6, top + r1 + 9, { width: X + W - c[4] - 8, lineBreak: false });
  }

  drawFooter(page: number, total: number) {
    const doc = this.doc;
    const y = PAGE_HEIGHT - 52;
    doc.moveTo(X + 30, y).lineTo(X + W, y).strokeColor(LINE).lineWidth(0.6).stroke();
    const company = (this.letterhead.company_name || "Econet Telecom Lesotho").toUpperCase();
    doc.font("Helvetica").fontSize(8).fillColor(FOOTER);
    doc.text(pdfSafeText(company), X + 30, y + 5, { width: 250, lineBreak: false });
    doc.text("Change Control Procedure", X + W - 200, y + 5, { width: 200, align: "right", lineBreak: false });
    doc.text("Information Systems", X + 30, y + 21, { width: 150, lineBreak: false });
    doc.text(`Page ${page} of ${total}`, X, y + 21, { width: W, align: "center", lineBreak: false });
    doc.text("Version: 2.0", X + W - 150, y + 21, { width: 150, align: "right", lineBreak: false });
  }

  gap(h: number) { this.y += h; }

  ensure(h: number) {
    if (this.y + h > CONTENT_BOTTOM) this.newPage();
  }

  heading(text: string, size = 12.5) {
    this.ensure(40);
    this.doc.font("Helvetica-Bold").fontSize(size).fillColor(INK).text(text, X + 14, this.y, { width: W - 14, lineBreak: false });
    this.y += size + 12;
  }

  private cellLines(cell: Cell): string[] {
    const inner = cell.w - PAD_X * 2;
    if ("label" in cell) return wrapLines(this.doc, cell.label, inner, LABEL_FONT, cell.size ?? LABEL_SIZE);
    if ("value" in cell) return wrapLines(this.doc, cell.value || "", inner, cell.font ?? VALUE_FONT, cell.size ?? VALUE_SIZE);
    return [];
  }

  private checkLines(items: CrFormCheck[], width: number) {
    return items.map((item) => wrapLines(this.doc, item.label, width - CHECK_INDENT, item.checked ? "Times-Bold" : "Times-Roman", VALUE_SIZE));
  }

  private cellHeight(cell: Cell): number {
    if ("checks" in cell) {
      return this.checkLines(cell.checks, cell.w - PAD_X * 2 - 2).reduce((h, lines) => h + lines.length * CHECK_LINE + CHECK_GAP, 0) + PAD_Y * 2 + 2;
    }
    if ("stamp" in cell) return 40;
    if ("pink" in cell || "blank" in cell) return 0;
    const size = ("label" in cell ? cell.size ?? LABEL_SIZE : cell.size ?? VALUE_SIZE);
    return this.cellLines(cell).length * size * 1.18 + PAD_Y * 2;
  }

  // One row of the grid; widths are in points and must add up to W.
  row(cells: Cell[], minHeight = 17) {
    const doc = this.doc;
    const h = Math.max(minHeight, ...cells.map((c) => this.cellHeight(c)));
    this.ensure(h);
    let x = X;
    for (const cell of cells) {
      if ("label" in cell || "pink" in cell) doc.rect(x, this.y, cell.w, h).fill(PINK);
      if ("label" in cell || "value" in cell) {
        const size = "label" in cell ? cell.size ?? LABEL_SIZE : cell.size ?? VALUE_SIZE;
        const font = "label" in cell ? LABEL_FONT : cell.font ?? VALUE_FONT;
        const align = "value" in cell ? cell.align ?? "left" : "left";
        doc.font(font).fontSize(size).fillColor(INK);
        this.cellLines(cell).forEach((line, i) => doc.text(line, x + PAD_X, this.y + PAD_Y + 1 + i * size * 1.18, { width: cell.w - PAD_X * 2, align, lineBreak: false }));
      }
      if ("checks" in cell) this.drawChecks(cell.checks, x + PAD_X + 2, this.y + PAD_Y + 2, cell.w - PAD_X * 2 - 2);
      if ("stamp" in cell) this.drawStamp(cell.stamp, x + PAD_X + 2, this.y + 5, cell.w - PAD_X * 2 - 2);
      doc.rect(x, this.y, cell.w, h).lineWidth(0.8).strokeColor(LINE).stroke();
      x += cell.w;
    }
    this.y += h;
  }

  // A box per item, ticked and bold when chosen; long labels wrap under themselves.
  private drawChecks(items: CrFormCheck[], x: number, y: number, width: number) {
    const doc = this.doc;
    const wrapped = this.checkLines(items, width);
    let top = y;
    items.forEach((item, i) => {
      doc.rect(x, top + 1, 8, 8).lineWidth(0.6).strokeColor(LINE).stroke();
      if (item.checked) {
        doc.moveTo(x + 1.6, top + 5.2).lineTo(x + 3.5, top + 7.4).lineTo(x + 7.2, top + 2.2).lineWidth(1.3).strokeColor(INK).stroke();
      }
      doc.font(item.checked ? "Times-Bold" : "Times-Roman").fontSize(VALUE_SIZE).fillColor(INK);
      wrapped[i].forEach((line, j) => doc.text(line, x + CHECK_INDENT, top + j * CHECK_LINE, { lineBreak: false }));
      top += wrapped[i].length * CHECK_LINE + CHECK_GAP;
    });
  }

  // Approved in FlowDesk, not on paper: the decision, by whom and when.
  private drawStamp(a: CrFormApproval, x: number, y: number, width: number) {
    const doc = this.doc;
    if (!a.acted_at) {
      doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTED).text(a.current ? "Awaiting approval" : "Not yet reached", x, y + 9, { width, lineBreak: false });
      return;
    }
    const label = a.status === "REJECTED" ? "REJECTED" : a.status === "NOTED" ? "NOTED" : "APPROVED";
    const color = a.status === "REJECTED" ? REJECTED : a.status === "NOTED" ? NOTED : APPROVED;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(color).text(label, x, y, { width, lineBreak: false, characterSpacing: 0.6 });
    doc.font("Helvetica").fontSize(6.8).fillColor(MUTED).text("electronically in FlowDesk", x, y + 11, { width, lineBreak: false });
    doc.font("Times-Roman").fontSize(9.5).fillColor(INK).text(stampDate(a.acted_at), x, y + 20, { width, lineBreak: false });
  }

  // A pink full-width title row with free text below, split across pages
  // when it is longer than what is left of the page.
  textBlock(title: string, text: string | null, opts: { titleSize?: number; minLines?: number } = {}) {
    const doc = this.doc;
    const titleSize = opts.titleSize ?? 11;
    const lh = VALUE_SIZE * 1.18;
    const lines = wrapLines(doc, text || "", W - PAD_X * 2, VALUE_FONT, VALUE_SIZE);
    while (lines.length < (opts.minLines ?? 1)) lines.push("");
    let first = true;
    let i = 0;
    while (i < lines.length) {
      this.ensure(titleSize + 10 + lh + PAD_Y * 2);
      this.row([{ w: W, label: first ? title : `${title} (continued)`, size: titleSize }], titleSize + 6);
      first = false;
      const fit = Math.max(1, Math.floor((CONTENT_BOTTOM - this.y - PAD_Y * 2) / lh));
      const chunk = lines.slice(i, i + fit);
      const h = chunk.length * lh + PAD_Y * 2;
      doc.font(VALUE_FONT).fontSize(VALUE_SIZE).fillColor(INK);
      chunk.forEach((line, j) => doc.text(line, X + PAD_X, this.y + PAD_Y + 1 + j * lh, { width: W - PAD_X * 2, lineBreak: false }));
      doc.rect(X, this.y, W, h).lineWidth(0.8).strokeColor(LINE).stroke();
      this.y += h;
      i += chunk.length;
      if (i < lines.length) this.newPage();
    }
  }
}

export function renderChangeRequestFormPdf(letterhead: PdfLetterhead, data: CrFormPdfData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `${data.reference} Change Request Form` } });
  const f = new FormWriter(doc, letterhead, data);

  // ---- Page 1: the request ----
  f.newPage(true);
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text("CHANGE REQUEST FORM", X + 14, f.y, { lineBreak: false });
  const status = data.status.replace(/_/g, " ").toLowerCase();
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
    .text(`Status: ${status.charAt(0).toUpperCase()}${status.slice(1)}`, X, f.y + 5, { width: W, align: "right", lineBreak: false });
  f.gap(30);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(
    "By approving or declining this change control request you acknowledge that you are fully aware of the implications of the required change and therefore accept the Responsibilities of Change Approvers as outlined in the Change Management Standards and Procedures",
    X + 24, f.y, { width: W - 48, align: "center", lineGap: 1 }
  );
  f.y = doc.y + 16;

  f.row([
    { w: 88, label: "Requested by" }, { w: 100, value: data.requested_by },
    { w: 46, label: "Date" }, { w: 92, value: longDate(data.date) },
    { w: 62, label: "Ref No:" }, { w: W - 388, value: data.reference }
  ]);
  f.row([{ w: 88, label: "Department" }, { w: W - 88, value: data.department }]);
  if (data.related_brs) f.row([{ w: 88, label: "Related BRS" }, { w: W - 88, value: data.related_brs }]);
  f.row([
    { w: 136, label: "Date Requested" }, { w: 112, value: longDate(data.date_requested) },
    { w: 92, label: "Change Assignee" }, { w: W - 340, value: data.assignees }
  ]);
  f.row([
    { w: 136, label: "Change type" }, { w: 112, checks: data.change_types },
    { w: 92, label: "Change Category" }, { w: W - 340, checks: data.categories }
  ]);
  f.row([
    { w: 136, label: "Is this Urgent?" }, { w: 112, value: data.urgent ? "Yes" : "No" },
    { w: 92, pink: true }, { w: W - 340, blank: true }
  ]);
  f.textBlock("Description of proposed change?", data.description);
  f.textBlock("Business Justification / Reason for Change", data.justification);
  f.textBlock("Which IS /IT / Business areas will be affected?", data.affected_areas, { titleSize: 10 });
  f.row([{ w: 58, label: "Priority" }, { w: W - 58, value: data.priority, size: 11 }]);

  f.gap(22);
  f.ensure(80);
  f.row([{ w: W, label: "Technical Details", size: 11 }]);
  f.row([
    { w: 136, label: "Component(s) name" }, { w: 112, value: data.component },
    { w: 92, label: "Platform" }, { w: W - 340, value: data.platform }
  ]);
  f.row([
    { w: 136, label: "Dependencies" }, { w: 112, value: data.dependencies },
    { w: 92, label: "Number of Changes" }, { w: W - 340, value: data.number_of_changes }
  ]);

  // ---- Page 2: implementation ----
  f.newPage();
  f.row([
    { w: 136, label: "Implementation Date", size: 11 }, { w: 112, value: longDate(data.implementation_date) },
    { w: 92, label: "Change Implementor", size: 11 }, { w: W - 340, value: data.implementor }
  ]);
  f.row([
    { w: 136, label: "Time Required", size: 11 }, { w: 112, value: data.time_required },
    { w: 92, label: "Time Scheduled", size: 11 }, { w: W - 340, value: data.time_scheduled }
  ]);
  f.gap(14);
  f.row([{ w: 38, label: "Risk", size: 11 }, { w: 202, value: data.risk }, { w: 54, label: "Impact", size: 11 }, { w: W - 294, value: data.impact }]);
  f.gap(14);
  f.textBlock("Implementation Plan", data.implementation_plan, { minLines: 2 });
  f.textBlock("Back-out Plan", data.back_out_plan, { minLines: 2 });
  f.row([
    { w: 116, label: "Callout person", size: 11 }, { w: 122, value: data.callout_person },
    { w: 94, label: "Contact No", size: 11 }, { w: W - 332, value: data.callout_contact }
  ]);
  f.gap(14);
  f.textBlock("Documentation / Procedures required", data.documentation, { minLines: 2 });
  f.gap(14);
  f.textBlock("Business Implications", data.business_implications);
  for (const s of data.extra_sections) {
    f.gap(14);
    f.textBlock(s.title, s.content);
  }

  // ---- Page 3: approvals and closure ----
  f.newPage();
  f.heading("APPROVALS");
  f.row([
    { w: 150, label: "Change Approvers", size: 11 }, { w: 182, label: "Name / Alternate", size: 11 }, { w: W - 332, label: "Signature and Date", size: 11 }
  ]);
  const approvers = data.approvals.filter((a) => a.decision === "APPROVE");
  const noted = data.approvals.filter((a) => a.decision === "NOTE");
  for (const a of approvers) {
    f.row([
      { w: 150, label: a.position.toUpperCase(), size: 9.5 },
      { w: 182, value: `${a.name || "—"}${a.comment ? `\n"${a.comment}"` : ""}`, font: "Helvetica", size: 9.5, align: "center" },
      { w: W - 332, stamp: a }
    ], 40);
  }
  if (!approvers.length) f.row([{ w: 150, pink: true }, { w: 182, value: "No approvers yet", font: "Helvetica-Oblique", size: 9, align: "center" }, { w: W - 332, blank: true }], 30);

  f.gap(22);
  f.heading("Change Control Approval", 11);
  for (const a of noted) {
    f.row([
      { w: 254, label: `Change control noted (${a.position})` },
      { w: 100, value: a.acted_at ? `${a.name || ""}\n${a.status === "REJECTED" ? "Rejected" : "Noted"}` : a.name, font: "Helvetica", size: 8.5 },
      { w: 38, label: "Date" }, { w: W - 392, value: a.acted_at ? stampDate(a.acted_at) : "", size: 9.5 }
    ]);
    f.row([{ w: 254, label: "Comments" }, { w: W - 254, value: a.comment, size: 9.5 }]);
  }
  const decided = data.approvals.filter((a) => a.acted_at).sort((p, q) => String(p.acted_at).localeCompare(String(q.acted_at)));
  const last = decided[decided.length - 1];
  const outcome = ["APPROVED", "CLOSED"].includes(data.status) ? "Approved" : data.status === "REJECTED" ? "Rejected" : data.status === "CANCELLED" ? "Cancelled" : "Pending";
  if (noted.length) f.gap(10);
  f.row([
    { w: 254, label: "Change control approved" },
    { w: 100, value: outcome, font: "Helvetica-Bold", size: 9.5 },
    { w: 38, label: "Date" }, { w: W - 392, value: outcome !== "Pending" && outcome !== "Cancelled" && last?.acted_at ? stampDate(last.acted_at) : "", size: 9.5 }
  ]);
  f.row([{ w: 254, label: "Comments" }, { w: W - 254, value: data.status === "REJECTED" ? last?.comment ?? null : null, size: 9.5 }]);

  f.gap(22);
  f.heading("CHANGE CLOSURE", 11);
  const closure = data.closure;
  f.row([{ w: W, pink: true }], 15);
  f.row([{ w: W, value: "Was the change successful?                    Yes / No", font: "Helvetica", size: 10 }]);
  f.row([{ w: W, value: "If No, please state Incident Number (Inc No______________) give a brief description of problem(s) encountered.", font: "Helvetica", size: 10 }]);
  f.row([{
    w: W,
    value: closure ? [closure.implementation_date ? `Implemented on ${longDate(closure.implementation_date)}.` : "", closure.notes || ""].filter(Boolean).join(" ") : "",
    size: 10
  }]);
  f.row([
    { w: 158, label: "Date Closed" }, { w: 113, value: closure?.closed_at ? longDate(closure.closed_at) : "" },
    { w: 92, label: "Signature" }, { w: W - 363, value: closure?.closed_at ? `Closed electronically${closure.closed_by ? ` by ${closure.closed_by}` : ""}` : "", font: "Helvetica", size: 8.5 }
  ]);

  // Every page exists now, so the totals are known.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    f.drawFooter(i - range.start + 1, range.count);
  }
  return doc;
}
