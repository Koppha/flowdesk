import { PDFDocument, StandardFonts, rgb, PDFString, type PDFPage } from "pdf-lib";
import crypto from "crypto";

// pdf-lib has no high-level "make this text clickable" helper (unlike
// pdfkit) - a real hyperlink is a Link annotation, built by hand via the
// low-level object API and attached to the page's /Annots. Used instead of
// printing the verification URL as plain text, so the short "Verify: <code>"
// label itself is the tappable link rather than a long, easy-to-mistype URL
// sitting next to it.
function addLinkAnnotation(page: PDFPage, rect: [number, number, number, number], url: string): void {
  const context = page.doc.context;
  const annotRef = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: rect,
      Border: [0, 0, 0],
      A: context.obj({
        Type: "Action",
        S: "URI",
        URI: PDFString.of(url)
      })
    })
  );
  page.node.addAnnot(annotRef);
}

// Tier A ("electronic signature") stamping - overlays a signature block onto
// an EXISTING PDF (one FlowDesk generated, or one someone uploaded) rather
// than generating a document from scratch, which is what every other PDF
// renderer in this codebase does. pdf-lib is the only library here able to
// load and modify a PDF that already exists; pdfkit (used everywhere else)
// can only build a new one.
export interface SignatureStampInput {
  signerName: string;
  // Set only when signing under someone else's authority (a delegate acting
  // for the named approver) - both identities get shown, never just the
  // delegate's, so the record never silently reads as if the named
  // approver signed it personally.
  authorityName?: string | null;
  notation?: "AI" | "PP" | null;
  signedAt: Date;
  verificationCode: string;
  verificationUrl: string;
  // Exactly one of these should be set - a drawn signature (PNG/JPEG data
  // URL from the signing canvas) or a typed name rendered in a signature-
  // style font. Neither is required; a document can be signed with just the
  // consent record and no visual mark, though the UI always collects one.
  signatureImageDataUrl?: string | null;
  typedSignatureText?: string | null;
}

export interface SignatureStampResult {
  buffer: Buffer;
  contentHash: string;
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; isPng: boolean } {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error("Unsupported signature image format - expected a PNG or JPEG data URL");
  return { bytes: Buffer.from(match[2], "base64"), isPng: match[1].toLowerCase() === "png" };
}

export async function stampSignature(originalPdf: Buffer, input: SignatureStampInput): Promise<SignatureStampResult> {
  const pdfDoc = await PDFDocument.load(originalPdf);
  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();

  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const marginX = 40;
  const boxWidth = width - marginX * 2;
  const boxHeight = 92;
  const boxY = 36;

  page.drawRectangle({
    x: marginX, y: boxY, width: boxWidth, height: boxHeight,
    borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 1
  });
  page.drawText("SIGNED", { x: marginX + 10, y: boxY + boxHeight - 16, size: 8, font: bold, color: rgb(0.55, 0.55, 0.55) });

  // The visual mark - a drawn signature image, or a typed name in a larger,
  // signature-style weight. Purely visual; the actual evidence is the
  // consent record and hash, not this rendering.
  const markY = boxY + boxHeight - 44;
  if (input.signatureImageDataUrl) {
    const { bytes, isPng } = dataUrlToBytes(input.signatureImageDataUrl);
    const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const maxWidth = 160;
    const scale = Math.min(1, maxWidth / image.width);
    page.drawImage(image, { x: marginX + 10, y: markY - image.height * scale + 14, width: image.width * scale, height: image.height * scale });
  } else if (input.typedSignatureText) {
    page.drawText(input.typedSignatureText, { x: marginX + 10, y: markY, size: 20, font: bold, color: rgb(0.11, 0.16, 0.42) });
  }

  // Who signed, and under whose authority - both names shown whenever this
  // was a delegated signature, with the admin-configured (or signer-chosen)
  // notation between them, never just the delegate's name alone.
  const authorityLine = input.authorityName && input.notation
    ? `${input.signerName}, ${input.notation === "AI" ? "a.i." : "p.p."} for ${input.authorityName}`
    : input.signerName;
  page.drawText(authorityLine, { x: marginX + 10, y: boxY + 16, size: 10, font: regular, color: rgb(0.07, 0.09, 0.13) });
  page.drawText(
    `Signed ${input.signedAt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    { x: marginX + 10, y: boxY + 5, size: 7.5, font: regular, color: rgb(0.45, 0.45, 0.45) }
  );

  // Verification code, right-aligned in the same block - what anyone
  // holding this document (with no FlowDesk account) uses to check it. The
  // label itself is the clickable link (see addLinkAnnotation) rather than
  // also printing the full URL as plain text next to it.
  const verifyLabel = `Verify: ${input.verificationCode}`;
  const verifyLabelWidth = regular.widthOfTextAtSize(verifyLabel, 8);
  const verifyLabelX = marginX + boxWidth - verifyLabelWidth - 10;
  const verifyLabelY = boxY + 16;
  page.drawText(verifyLabel, { x: verifyLabelX, y: verifyLabelY, size: 8, font: bold, color: rgb(0.07, 0.09, 0.13) });
  addLinkAnnotation(page, [verifyLabelX - 2, verifyLabelY - 2, verifyLabelX + verifyLabelWidth + 2, verifyLabelY + 10], input.verificationUrl);

  const outBytes = await pdfDoc.save();
  const buffer = Buffer.from(outBytes);
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { buffer, contentHash };
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Stamps a small "Verify: <code> <url>" line in the bottom-right corner of
// the last page once, when a routing document is first created - a single,
// stable code that stays valid as more signers add their mark, rather than
// re-stamping it on every signature (which would be redundant once it's
// already baked into the file each signer builds on).
export async function stampDocumentFooter(originalPdf: Buffer, input: { verificationCode: string; verificationUrl: string }): Promise<SignatureStampResult> {
  const pdfDoc = await PDFDocument.load(originalPdf);
  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // The label itself is the clickable link (see addLinkAnnotation) rather
  // than also printing the full URL as plain text next to it.
  const label = `Verify: ${input.verificationCode}`;
  const labelWidth = bold.widthOfTextAtSize(label, 8);
  const labelX = width - labelWidth - 14;
  const labelY = 22;
  page.drawText(label, { x: labelX, y: labelY, size: 8, font: bold, color: rgb(0.07, 0.09, 0.13) });
  addLinkAnnotation(page, [labelX - 2, labelY - 2, labelX + labelWidth + 2, labelY + 10], input.verificationUrl);

  const outBytes = await pdfDoc.save();
  const buffer = Buffer.from(outBytes);
  return { buffer, contentHash: crypto.createHash("sha256").update(buffer).digest("hex") };
}

export interface SignatureMarkPlacementInput {
  pageNumber: number; // 1-indexed, as shown to the user
  // Fraction of the rendered page, top-left origin (matches how a browser
  // reports a click on a canvas) - converted to pdf-lib's bottom-left
  // origin at stamp time.
  xPct: number;
  yPct: number;
  widthPct: number;
  signerName: string;
  signedAt: Date;
  signatureImageDataUrl?: string | null;
  typedSignatureText?: string | null;
}

// Places the visual mark (image or typed script) at a specific spot on a
// specific page, with the signer's printed name above it and the date
// below - all inside the clicked box, never spilling past its edges, so it
// can drop into an existing form's own signature cell without fighting
// that cell's own labels or bleeding into the row below.
export async function stampSignatureMarkAtPosition(originalPdf: Buffer, input: SignatureMarkPlacementInput): Promise<SignatureStampResult> {
  const pdfDoc = await PDFDocument.load(originalPdf);
  const pages = pdfDoc.getPages();
  const pageIndex = Math.min(Math.max(input.pageNumber - 1, 0), pages.length - 1);
  const page = pages[pageIndex];
  const { width, height } = page.getSize();

  // No floor here beyond what the slider itself already enforces
  // (min={0.08} in SignRoutingDocument.tsx) - a hardcoded minimum used to
  // sit here, silently making the stamped box wider than the on-screen
  // preview whenever the chosen width fell below it, which is exactly what
  // made placement look imprecise even though the click point was correct.
  const boxWidth = input.widthPct * width;
  const boxHeight = boxWidth / 2.6;
  // The click point is the box's TOP-LEFT corner, not its center - it grows
  // right and down from wherever was clicked. Centering it used to put half
  // the box to the left of and above the click, which is what made
  // placement look wrong even after the size/floor bugs were fixed: the
  // box was correctly sized and positioned around the click, just not
  // anchored the way "place it here" actually reads to someone using it.
  const boxX = input.xPct * width;
  const boxTopY = height - input.yPct * height;
  const boxBottomY = boxTopY - boxHeight;

  const nameStripHeight = boxHeight * 0.24;
  const dateStripHeight = boxHeight * 0.2;
  const markHeight = boxHeight - nameStripHeight - dateStripHeight;
  const markBottomY = boxBottomY + dateStripHeight;

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const nameSize = Math.min(nameStripHeight * 0.8, 9);
  page.drawText(input.signerName, { x: boxX, y: boxTopY - nameStripHeight * 0.8, size: nameSize, font: bold, color: rgb(0.11, 0.16, 0.42) });

  if (input.signatureImageDataUrl) {
    const { bytes, isPng } = dataUrlToBytes(input.signatureImageDataUrl);
    const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const scale = Math.min(boxWidth / image.width, markHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    page.drawImage(image, {
      x: boxX + (boxWidth - drawWidth) / 2,
      y: markBottomY + (markHeight - drawHeight) / 2,
      width: drawWidth, height: drawHeight
    });
  } else if (input.typedSignatureText) {
    const size = Math.min(markHeight * 0.7, 20);
    page.drawText(input.typedSignatureText, { x: boxX, y: markBottomY + markHeight * 0.15, size, font: bold, color: rgb(0.11, 0.16, 0.42) });
  }

  const dateLabel = input.signedAt.toLocaleDateString("en-GB");
  const dateSize = Math.min(dateStripHeight * 0.85, 7.5);
  page.drawText(dateLabel, { x: boxX, y: boxBottomY + dateStripHeight * 0.2, size: dateSize, font: regular, color: rgb(0.45, 0.45, 0.45) });

  const outBytes = await pdfDoc.save();
  const buffer = Buffer.from(outBytes);
  return { buffer, contentHash: crypto.createHash("sha256").update(buffer).digest("hex") };
}

// Short, typeable, unambiguous verification code - excludes characters
// that are easy to misread (0/O, 1/I/L) since this is meant to be read off
// a printed page and typed in, not just scanned.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateVerificationCode(): string {
  const bytes = crypto.randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
