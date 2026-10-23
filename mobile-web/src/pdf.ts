// pdf.js legacy build: Android System WebView versions vary from phone to
// phone, and the modern build needs newer JS features (e.g.
// Promise.withResolvers) than an un-updated WebView has.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

export function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  // pdf.js transfers (detaches) the buffer it's given - copy it so the
  // caller can open the same bytes again (e.g. after switching pages).
  // isEvalSupported: the backend's CSP (helmet) blocks eval anyway.
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise;
}

export function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
