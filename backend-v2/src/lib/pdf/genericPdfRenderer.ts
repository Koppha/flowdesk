import PDFDocument from "pdfkit";
import fs from "fs";
import type { ResolvedPdfData } from "./pdfFieldCatalog.js";

export interface PdfLetterhead {
  logo_path: string | null;
  company_name: string | null;
  address_lines: string[];
  contact_line: string | null;
  footer_confidentiality_text: string | null;
}

export interface PdfTemplateField {
  fieldKey: string;
  labelOverride?: string;
  // two_column_table only: if set, this field renders as a ☑/☐ checkbox
  // instead of its raw value — checked when the field's scalar equals this.
  checkboxValue?: string;
}

export interface PdfTemplateSection {
  id: string;
  type: "heading" | "field_grid" | "table" | "two_column_table" | "approval_summary" | "disclaimer" | "spacer";
  numbered?: boolean;
  title?: string;
  columns?: 1 | 2 | 3 | 4;
  fields?: PdfTemplateField[];
  tableKey?: string;
  tableColumns?: { key: string; label: string }[];
  leftHeader?: string;
  rightHeader?: string;
  leftFields?: PdfTemplateField[];
  rightFields?: PdfTemplateField[];
  disclaimerItems?: string[];
}

export interface PdfTemplateRow {
  id: string;
  name: string;
  request_type: string;
  show_letterhead: boolean;
  header_title: string | null;
  footer_text_override: string | null;
  accent_color: string | null;
  sections: PdfTemplateSection[];
}

// Reserved scalar keys already surfaced elsewhere for custom requests — kept
// out of the dynamic "all remaining fields" fallback used when a field_grid
// section has no explicit field picks configured yet.
const CUSTOM_REQUEST_META_KEYS = new Set(["request_type_name", "requester_name", "submitted_at", "status"]);

const LABEL_COLOR = "#6b7280";
const RULE_COLOR = "#e2e8f0";
const HEADING_COLOR = "#1d4ed8";

function labelFor(fieldKey: string, catalog: { key: string; label: string }[] | undefined, override?: string) {
  if (override) return override;
  return catalog?.find((c) => c.key === fieldKey)?.label || fieldKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Standard PDF fonts (Helvetica/WinAnsi) don't reliably render the ☑/☐
// Unicode glyphs, so checkboxes are drawn as vector shapes instead.
function drawCheckbox(doc: PDFKit.PDFDocument, x: number, y: number, checked: boolean) {
  const size = 9;
  doc.lineWidth(0.75).strokeColor("#111").rect(x, y, size, size).stroke();
  if (checked) {
    doc.strokeColor("#111").lineWidth(1.2);
    doc.moveTo(x + 1.5, y + 4.5).lineTo(x + 3.5, y + 7).lineTo(x + 7.5, y + 1.5).stroke();
  }
  doc.strokeColor("#000").lineWidth(0.75);
}

// Measures the taller of two header labels (accounting for word-wrap within
// their own column width) so bordered-table headers never overflow their box.
function measureHeaderHeight(doc: PDFKit.PDFDocument, labels: string[], colWidth: number, fontSize: number, padding: number) {
  doc.font("Helvetica-Bold").fontSize(fontSize);
  const tallest = Math.max(...labels.map((l) => doc.heightOfString(l, { width: colWidth - 16 })));
  return Math.max(20, tallest + padding);
}

function hr(doc: PDFKit.PDFDocument, contentWidth: number, color = RULE_COLOR) {
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + contentWidth, doc.y).strokeColor(color).lineWidth(0.75).stroke();
}

// Renders text with **bold** spans parsed out (simple markdown-style emphasis),
// so disclaimer/policy copy can highlight key phrases without a rich editor.
function textWithBoldSpans(doc: PDFKit.PDFDocument, text: string, x: number, width: number, baseFont: string, boldFont: string, size: number) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  doc.fontSize(size);
  doc.x = x;
  parts.forEach((part, i) => {
    const isBold = part.startsWith("**") && part.endsWith("**");
    doc.font(isBold ? boldFont : baseFont).text(isBold ? part.slice(2, -2) : part, { continued: i < parts.length - 1, width });
  });
}

export function renderPdfTemplate(
  template: PdfTemplateRow,
  letterhead: PdfLetterhead,
  data: ResolvedPdfData,
  fieldCatalog: { key: string; label: string }[]
): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let sectionCounter = 0;

  const headerTop = doc.y;
  const leftWidth = contentWidth * 0.6;
  const rightWidth = contentWidth * 0.4;
  const rightX = doc.page.margins.left + leftWidth;

  // Left: document title + reference code
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#111").text(template.header_title || template.name, doc.page.margins.left, headerTop, { width: leftWidth });
  if (data.scalars.reference_code) {
    doc.font("Helvetica").fontSize(8).fillColor(LABEL_COLOR).text(`${data.scalars.reference_code}  |`, doc.page.margins.left, doc.y + 2, { width: leftWidth });
  }

  // Right: letterhead (logo + company block), right-aligned. Every line is
  // drawn with an explicit x/y (pdfkit resets doc.x to the page margin after
  // a standalone positioned .text() call, so relying on the "continued
  // cursor" here would drift back under the left title block).
  if (template.show_letterhead) {
    let rightY = headerTop;
    if (letterhead.logo_path && fs.existsSync(letterhead.logo_path)) {
      try {
        // `fit` scales within this box preserving aspect ratio (rather than a
        // fixed width), so both wide wordmarks and square icon logos come out
        // a sane height instead of overlapping the text below them.
        const logoBox: [number, number] = [70, 32];
        doc.image(letterhead.logo_path, rightX + rightWidth - logoBox[0], rightY, { fit: logoBox, align: "right" });
        rightY += logoBox[1] + 4;
      } catch {
        // corrupt/unreadable logo file — fall back to text-only header
      }
    }
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111").text(letterhead.company_name || "", rightX, rightY, { align: "right", width: rightWidth });
    rightY += 12;
    doc.font("Helvetica").fontSize(7).fillColor(LABEL_COLOR);
    for (const line of letterhead.address_lines || []) {
      doc.text(line, rightX, rightY, { align: "right", width: rightWidth });
      rightY += 9;
    }
    if (letterhead.contact_line) {
      doc.text(letterhead.contact_line, rightX, rightY, { align: "right", width: rightWidth });
      rightY += 9;
    }
    doc.y = Math.max(doc.y, rightY);
  }

  doc.fillColor("#000");
  doc.y = Math.max(doc.y, headerTop + 40);
  doc.x = doc.page.margins.left;
  doc.moveDown(0.4);
  hr(doc, contentWidth, "#999");
  doc.moveDown(0.6);

  for (const section of template.sections || []) {
    renderSection(doc, section, data, fieldCatalog, contentWidth, () => ++sectionCounter);
  }

  doc.moveDown(0.4);
  hr(doc, contentWidth, "#999");
  doc.moveDown(0.4);

  const footerLine = [letterhead.company_name, ...(letterhead.address_lines || []), letterhead.contact_line].filter(Boolean).join("  |  ");
  const generatedLine = `Generated: ${new Date(data.meta.generatedAt).toLocaleString("en-GB")}`;
  const footerY = doc.y;
  doc.font("Helvetica").fontSize(7.5).fillColor(LABEL_COLOR);
  doc.text(footerLine, doc.page.margins.left, footerY, { width: contentWidth * 0.7 });
  doc.text(generatedLine, doc.page.margins.left + contentWidth * 0.7, footerY, { width: contentWidth * 0.3, align: "right" });
  doc.moveDown(0.4);
  const confidentiality = template.footer_text_override || letterhead.footer_confidentiality_text;
  if (confidentiality) {
    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#999").text(confidentiality, doc.page.margins.left, doc.y, { width: contentWidth, align: "center" });
  }
  doc.fillColor("#000");

  return doc;
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string | undefined, numbered: boolean | undefined, nextNumber: () => number) {
  if (!title) return;
  const prefix = numbered ? `${nextNumber()}. ` : "";
  doc.font("Helvetica-Bold").fontSize(11).fillColor(HEADING_COLOR).text(`${prefix}${title}`);
  doc.fillColor("#000").font("Helvetica").fontSize(9.5);
  doc.moveDown(0.25);
}

function renderFieldCell(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, width: number) {
  doc.font("Helvetica").fontSize(7.5).fillColor(LABEL_COLOR).text(label, x, y, { width });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text(value || " ", x, doc.y + 1, { width });
  doc.fillColor("#000").font("Helvetica").fontSize(9.5);
}

function renderSection(
  doc: PDFKit.PDFDocument,
  section: PdfTemplateSection,
  data: ResolvedPdfData,
  fieldCatalog: { key: string; label: string }[],
  contentWidth: number,
  nextNumber: () => number
) {
  switch (section.type) {
    case "spacer":
      doc.moveDown(1);
      return;

    case "heading":
      sectionTitle(doc, section.title, section.numbered, nextNumber);
      doc.moveDown(0.5);
      return;

    case "field_grid": {
      let fields = section.fields || [];
      // Custom requests: an unconfigured field_grid falls back to every
      // remaining scalar the resolver produced (all the submission's own fields).
      if (fields.length === 0 && data.meta.requestType === "CUSTOM_REQUEST") {
        fields = Object.keys(data.scalars)
          .filter((k) => !CUSTOM_REQUEST_META_KEYS.has(k))
          .map((fieldKey) => ({ fieldKey }));
      }
      // Fields with nothing to show (common for optional fields like Duty
      // Station / Vehicle Reg on a given claim) are dropped rather than
      // rendered as an empty labelled row — the remaining fields re-pack
      // into the grid instead of leaving blank cells and wasted rows.
      fields = fields.filter((f) => (data.scalars[f.fieldKey] || "").trim() !== "");
      // Nothing left to show at all — skip the section (and its number)
      // entirely rather than printing a heading over an empty grid.
      if (fields.length === 0) return;
      sectionTitle(doc, section.title, section.numbered, nextNumber);
      const columns = section.columns && section.columns >= 1 && section.columns <= 4 ? section.columns : 3;
      const colWidth = contentWidth / columns;
      const cellPad = 8;
      for (let i = 0; i < fields.length; i += columns) {
        const rowY = doc.y;
        let maxRowBottom = rowY;
        for (let c = 0; c < columns; c++) {
          const f = fields[i + c];
          if (!f) continue;
          const label = labelFor(f.fieldKey, fieldCatalog, f.labelOverride);
          const value = data.scalars[f.fieldKey] || "";
          renderFieldCell(doc, label, value, doc.page.margins.left + c * colWidth, rowY, colWidth - cellPad);
          maxRowBottom = Math.max(maxRowBottom, doc.y);
        }
        doc.x = doc.page.margins.left;
        doc.y = maxRowBottom + 5;
        hr(doc, contentWidth);
        doc.moveDown(0.35);
      }
      doc.moveDown(0.15);
      return;
    }

    case "table": {
      sectionTitle(doc, section.title, section.numbered, nextNumber);
      const rows = (section.tableKey && data.tables[section.tableKey]) || [];
      const cols = section.tableColumns || [];
      if (cols.length === 0) return;
      const colWidth = contentWidth / cols.length;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(LABEL_COLOR);
      const headerY = doc.y;
      cols.forEach((c, i) => {
        doc.text(c.label.toUpperCase(), doc.page.margins.left + i * colWidth, headerY, { width: colWidth });
      });
      doc.fillColor("#000");
      doc.moveDown(0.4);
      hr(doc, contentWidth, "#999");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9);
      if (rows.length === 0) {
        doc.fillColor(LABEL_COLOR).text("No entries.", { width: contentWidth });
        doc.fillColor("#000");
      } else {
        for (const row of rows) {
          const rowY = doc.y;
          // A long "From"/"Location" value word-wraps onto 2+ lines — measure
          // the tallest cell in the row so the next row (and any section
          // after this table) never overlaps it.
          const rowHeight = Math.max(...cols.map((c) => doc.heightOfString(row[c.key] ?? "", { width: colWidth })));
          cols.forEach((c, i) => {
            doc.text(row[c.key] ?? "", doc.page.margins.left + i * colWidth, rowY, { width: colWidth });
          });
          doc.y = rowY + rowHeight + 4;
          doc.x = doc.page.margins.left;
          hr(doc, contentWidth);
          doc.moveDown(0.2);
        }
      }
      doc.moveDown(0.4);
      return;
    }

    // A two-body-column bordered table (e.g. "EcoCash Wallet" vs "Bank Account"
    // disbursement details), each side its own header + stacked label/value rows,
    // with optional ☑/☐ rendering for a field flagged as a checkbox.
    case "two_column_table": {
      sectionTitle(doc, section.title, section.numbered, nextNumber);
      const halfWidth = contentWidth / 2;
      const left = section.leftFields || [];
      const right = section.rightFields || [];
      const rowCount = Math.max(left.length, right.length);
      const tableTop = doc.y;
      const headerHeight = measureHeaderHeight(doc, [section.leftHeader || "", section.rightHeader || ""], halfWidth, 9, 12);

      doc.rect(doc.page.margins.left, tableTop, contentWidth, headerHeight).fillAndStroke("#eef2ff", "#c7d2fe");
      doc.fillColor("#1e293b").font("Helvetica-Bold").fontSize(9);
      doc.text((section.leftHeader || "").toUpperCase(), doc.page.margins.left + 8, tableTop + 6, { width: halfWidth - 16 });
      doc.text((section.rightHeader || "").toUpperCase(), doc.page.margins.left + halfWidth + 8, tableTop + 6, { width: halfWidth - 16 });
      doc.fillColor("#000").font("Helvetica").fontSize(9.5);

      let rowY = tableTop + headerHeight + 8;
      for (let i = 0; i < rowCount; i++) {
        const lf = left[i];
        const rf = right[i];
        let rowBottom = rowY;
        if (lf) {
          const label = labelFor(lf.fieldKey, fieldCatalog, lf.labelOverride);
          if (lf.checkboxValue !== undefined) {
            const checked = data.scalars[lf.fieldKey] === lf.checkboxValue;
            doc.font("Helvetica").fontSize(7.5).fillColor(LABEL_COLOR).text(label, doc.page.margins.left + 8, rowY, { width: halfWidth - 24 });
            drawCheckbox(doc, doc.page.margins.left + 8, rowY + 11, checked);
            doc.y = rowY + 22;
          } else {
            renderFieldCell(doc, label, data.scalars[lf.fieldKey] || "", doc.page.margins.left + 8, rowY, halfWidth - 24);
          }
          rowBottom = Math.max(rowBottom, doc.y);
        }
        if (rf) {
          const label = labelFor(rf.fieldKey, fieldCatalog, rf.labelOverride);
          if (rf.checkboxValue !== undefined) {
            const checked = data.scalars[rf.fieldKey] === rf.checkboxValue;
            doc.font("Helvetica").fontSize(7.5).fillColor(LABEL_COLOR).text(label, doc.page.margins.left + halfWidth + 8, rowY, { width: halfWidth - 24 });
            drawCheckbox(doc, doc.page.margins.left + halfWidth + 8, rowY + 11, checked);
            doc.y = rowY + 22;
          } else {
            renderFieldCell(doc, label, data.scalars[rf.fieldKey] || "", doc.page.margins.left + halfWidth + 8, rowY, halfWidth - 24);
          }
          rowBottom = Math.max(rowBottom, doc.y);
        }
        rowY = rowBottom + 8;
      }

      const tableBottom = rowY;
      doc.strokeColor("#c7d2fe").lineWidth(0.75);
      doc.rect(doc.page.margins.left, tableTop, contentWidth, tableBottom - tableTop).stroke();
      doc.moveTo(doc.page.margins.left + halfWidth, tableTop).lineTo(doc.page.margins.left + halfWidth, tableBottom).stroke();
      doc.moveTo(doc.page.margins.left, tableTop + headerHeight).lineTo(doc.page.margins.left + contentWidth, tableTop + headerHeight).stroke();

      doc.y = tableBottom + 8;
      doc.x = doc.page.margins.left;
      doc.fillColor("#000").font("Helvetica").fontSize(9.5);
      return;
    }

    case "approval_summary": {
      sectionTitle(doc, section.title, section.numbered, nextNumber);
      if (data.approvalChain.length === 0) {
        doc.fillColor(LABEL_COLOR).text("No approval chain recorded.", { width: contentWidth });
        doc.fillColor("#000");
        doc.moveDown(0.6);
        return;
      }
      const cols = data.approvalChain;
      const colWidth = contentWidth / cols.length;
      const tableTop = doc.y;
      const headerHeight = measureHeaderHeight(doc, cols.map((c) => c.title.toUpperCase()), colWidth, 8.5, 12);

      doc.rect(doc.page.margins.left, tableTop, contentWidth, headerHeight).fillAndStroke("#eef2ff", "#c7d2fe");
      doc.fillColor("#1e293b").font("Helvetica-Bold").fontSize(8.5);
      cols.forEach((step, i) => {
        doc.text(step.title.toUpperCase(), doc.page.margins.left + i * colWidth + 8, tableTop + 6, { width: colWidth - 16 });
      });

      let rowY = tableTop + headerHeight + 8;
      let maxBottom = rowY;
      doc.font("Helvetica").fontSize(9.5).fillColor("#000");
      cols.forEach((step, i) => {
        const x = doc.page.margins.left + i * colWidth + 8;
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text(step.approverName || "—", x, rowY, { width: colWidth - 16 });
        if (step.decision || step.decidedAt) {
          doc.font("Helvetica").fontSize(7.5).fillColor(LABEL_COLOR).text([step.decision, step.decidedAt].filter(Boolean).join(" — "), x, doc.y + 2, { width: colWidth - 16 });
        }
        maxBottom = Math.max(maxBottom, doc.y);
      });

      const tableBottom = maxBottom + 8;
      doc.strokeColor("#c7d2fe").lineWidth(0.75);
      doc.rect(doc.page.margins.left, tableTop, contentWidth, tableBottom - tableTop).stroke();
      for (let i = 1; i < cols.length; i++) {
        const x = doc.page.margins.left + i * colWidth;
        doc.moveTo(x, tableTop).lineTo(x, tableBottom).stroke();
      }
      doc.moveTo(doc.page.margins.left, tableTop + headerHeight).lineTo(doc.page.margins.left + contentWidth, tableTop + headerHeight).stroke();

      doc.y = tableBottom + 8;
      doc.x = doc.page.margins.left;
      doc.fillColor("#000").font("Helvetica").fontSize(9.5);
      return;
    }

    case "disclaimer": {
      if (section.title) {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#b91c1c").text(section.title);
        doc.fillColor("#000").font("Helvetica").fontSize(8.5);
        doc.moveDown(0.4);
      }
      (section.disclaimerItems || []).forEach((item) => {
        textWithBoldSpans(doc, item, doc.page.margins.left, contentWidth, "Helvetica", "Helvetica-Bold", 8.5);
        doc.moveDown(0.15);
      });
      doc.moveDown(0.2);
      return;
    }
  }
}
