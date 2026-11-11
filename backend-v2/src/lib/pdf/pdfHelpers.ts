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

// pdfkit's built-in fonts only have WinAnsi glyphs; anything else (emoji,
// arrows) would print as garbage, so swap it for something that prints.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const WIN_ANSI_SWAP: Record<string, string> = { "→": "->", "←": "<-" };
export function pdfSafeText(s: string | null | undefined): string {
  let out = "";
  for (const ch of String(s ?? "").replace(/\r\n?/g, "\n").replace(/[​-‍︀-️]/g, "")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n" || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch === "\t") out += "    ";
    else out += WIN_ANSI_SWAP[ch] ?? "?";
  }
  return out;
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

// Builds the downloaded filename for a captured advance's PDF, e.g.
// "Mampho Mosakeng - EMP1023 - Travel Advance Request - 001.pdf". sequenceNo
// is the request's persistent, gap-free counter (advance_requests.sequence_no),
// not the uuid-derived reference shown on screen (formatRequestNumber above).
export function buildAdvancePdfFilename(employeeName: string | null | undefined, employeeNo: string | null | undefined, sequenceNo: number | null | undefined) {
  const clean = (s: string | null | undefined) => String(s ?? "").replace(/["\\/:*?<>|]/g, "").trim();
  const seq = sequenceNo ? String(sequenceNo).padStart(3, "0") : "000";
  const parts = [clean(employeeName), clean(employeeNo), "Travel Advance Request", seq].filter(Boolean);
  return `${parts.join(" - ")}.pdf`;
}

export function formatPaymentReference(seq: number, year = new Date().getFullYear()) {
  return `PAY-${year}-${String(seq).padStart(4, "0")}`;
}

export function dottedLine(doc: PDFKit.PDFDocument, label: string, value: string, width: number) {
  const labelWidth = doc.widthOfString(label);
  doc.text(label, { continued: true });
  const remaining = Math.max(0, width - labelWidth - doc.widthOfString(value) - 10);
  const dots = ".".repeat(Math.max(0, Math.floor(remaining / doc.widthOfString("."))));
  doc.text(` ${dots} `, { continued: true });
  doc.text(value);
}
