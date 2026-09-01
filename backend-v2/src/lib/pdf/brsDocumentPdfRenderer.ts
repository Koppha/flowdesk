import PDFDocument from "pdfkit";
import fs from "fs";
import type { PdfLetterhead } from "./genericPdfRenderer.js";

export interface BrsPdfSection {
  title: string;
  content_html: string | null;
}

export interface BrsPdfData {
  title: string;
  reference_no: string | null;
  requester_name: string | null;
  phase: string;
  baselined_at: string | null;
  sections: BrsPdfSection[];
}

// A BRS document doesn't need the admin-designed pdf_templates mechanism —
// there's no scalar-field layout to design, since its section titles are
// already fully described by the per-document snapshot. This renders
// directly with pdfkit instead. Rich-text content is flattened to plain
// text (paragraph/list structure kept, inline bold/italic styling is not) —
// a deliberate v1 simplification, not a rendering bug.
function htmlToPlainLines(html: string | null): string[] {
  if (!html) return ["—"];
  const withBreaks = html
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  const text = withBreaks
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length ? lines : ["—"];
}

export function renderBrsPdf(letterhead: PdfLetterhead, data: BrsPdfData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  const logoSource = letterhead.logo_data || (letterhead.logo_path && fs.existsSync(letterhead.logo_path) ? letterhead.logo_path : null);
  if (logoSource) {
    try { doc.image(logoSource, 50, 40, { width: 90 }); } catch { /* ignore bad logo data */ }
  }
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#111").text(letterhead.company_name || "", 300, 45, { align: "right", width: 245 });
  doc.font("Helvetica").fontSize(8).fillColor("#444");
  for (const line of letterhead.address_lines || []) {
    doc.text(line, 300, doc.y, { align: "right", width: 245 });
  }
  if (letterhead.contact_line) doc.text(letterhead.contact_line, 300, doc.y, { align: "right", width: 245 });

  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text("Business Requirement Specification");
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(data.title);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(9).fillColor("#444");
  doc.text(`Reference: ${data.reference_no || "—"}    Requester: ${data.requester_name || "—"}    Status: ${data.phase}${data.baselined_at ? `    Baselined: ${new Date(data.baselined_at).toLocaleDateString()}` : ""}`);
  doc.moveDown(1.2);

  for (const section of data.sections) {
    if (doc.y > 700) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text(section.title);
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#222");
    for (const line of htmlToPlainLines(section.content_html)) {
      if (doc.y > 720) doc.addPage();
      doc.text(line, { width: 495 });
    }
    doc.moveDown(0.8);
  }

  doc.font("Helvetica").fontSize(7).fillColor("#888");
  const footerLine = [letterhead.company_name, ...(letterhead.address_lines || []), letterhead.contact_line].filter(Boolean).join("  |  ");
  if (footerLine) doc.text(footerLine, 50, 780, { align: "center", width: 495 });
  if (letterhead.footer_confidentiality_text) {
    doc.text(letterhead.footer_confidentiality_text, 50, 792, { align: "center", width: 495 });
  }

  return doc;
}
