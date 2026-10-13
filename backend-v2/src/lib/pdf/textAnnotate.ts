import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// A small, standalone "add text to an existing PDF" utility - deliberately
// separate from signatureStamp.ts (which is about signing, with all the
// consent/audit baggage that implies). This is nothing more than: place
// some text where the user clicked. No persistence, no verification code -
// the caller gets back a stamped PDF in the same request and nothing is
// kept server-side beyond the upload's lifetime.

export interface TextAnnotationInput {
  pageNumber: number; // 1-indexed
  // Fraction of the page, top-left origin (matches a browser click on a
  // <canvas>) - converted to pdf-lib's bottom-left origin at stamp time.
  xPct: number;
  yPct: number;
  text: string;
  fontSize: number;
  color: string; // "#rrggbb"
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export async function stampTextAnnotations(originalPdf: Buffer, annotations: TextAnnotationInput[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(originalPdf);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const a of annotations) {
    const pageIndex = Math.min(Math.max(a.pageNumber - 1, 0), pages.length - 1);
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const [r, g, b] = hexToRgb(a.color);
    const x = a.xPct * width;
    const topY = height - a.yPct * height;
    const lineHeight = a.fontSize * 1.25;
    a.text.split("\n").forEach((line, i) => {
      page.drawText(line, { x, y: topY - a.fontSize - i * lineHeight, size: a.fontSize, font, color: rgb(r, g, b) });
    });
  }

  const outBytes = await pdfDoc.save();
  return Buffer.from(outBytes);
}
