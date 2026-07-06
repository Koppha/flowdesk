export function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

export function formatMoney(value: string | number | null | undefined, currency = "LSL") {
  const amount = Number(value || 0);
  return `${currency} ${amount.toFixed(2)}`;
}

// Mirrors the frontend's client-side "ADV-2026-00123" / "CL-2026-00123" style
// request-number formatting (MyAdvances.tsx/MyClearances.tsx) so the PDF's
// displayed reference matches what the requester sees on screen.
export function formatRequestNumber(prefix: string, id: string, createdAt: string | null | undefined) {
  const created = new Date(createdAt || Date.now());
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  const digits = String(id || "").replace(/\D/g, "").slice(-5);
  const fallback = String(id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
  return `${prefix}-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
}

export function dottedLine(doc: PDFKit.PDFDocument, label: string, value: string, width: number) {
  const labelWidth = doc.widthOfString(label);
  doc.text(label, { continued: true });
  const remaining = Math.max(0, width - labelWidth - doc.widthOfString(value) - 10);
  const dots = ".".repeat(Math.max(0, Math.floor(remaining / doc.widthOfString("."))));
  doc.text(` ${dots} `, { continued: true });
  doc.text(value);
}
