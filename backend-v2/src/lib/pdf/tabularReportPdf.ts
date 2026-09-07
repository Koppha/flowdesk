import PDFDocument from "pdfkit";
import type { Response } from "express";

// Generic multi-row report PDF — distinct from genericPdfRenderer.ts, which
// renders one configurable single-record document (a Request/Claim) from an
// admin-designed template. This instead renders a plain landscape table for
// a report's already-filtered row set, so a report's "Export PDF" always
// matches its on-screen/CSV rows exactly.
export function renderTabularReportPdf(
  res: Response,
  opts: {
    title: string;
    subtitle?: string;
    columns: { label: string; width?: number }[];
    rows: (string | number | null | undefined)[][];
    filename: string;
  }
) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}"`);
  doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const defaultWidth = pageWidth / opts.columns.length;
  const widths = opts.columns.map((c) => c.width ?? defaultWidth);

  function drawHeader() {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#334155");
    let x = doc.page.margins.left;
    const y = doc.y;
    opts.columns.forEach((c, i) => {
      doc.text(c.label, x, y, { width: widths[i] });
      x += widths[i];
    });
    doc.moveDown(0.9);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor("#cbd5e1")
      .stroke();
    doc.moveDown(0.4);
  }

  doc.font("Helvetica-Bold").fontSize(15).fillColor("#0f172a").text(opts.title);
  if (opts.subtitle) doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(opts.subtitle);
  doc.moveDown(0.8);
  drawHeader();

  doc.font("Helvetica").fontSize(8).fillColor("#0f172a");
  for (const row of opts.rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage({ size: "A4", layout: "landscape", margin: 36 });
      drawHeader();
      doc.font("Helvetica").fontSize(8).fillColor("#0f172a");
    }
    let x = doc.page.margins.left;
    const y = doc.y;
    row.forEach((val, i) => {
      doc.text(val === null || val === undefined || val === "" ? "—" : String(val), x, y, { width: widths[i] });
      x += widths[i];
    });
    doc.moveDown(0.7);
  }
  if (opts.rows.length === 0) {
    doc.font("Helvetica-Oblique").fillColor("#64748b").text("No records match.");
  }

  doc.end();
}
