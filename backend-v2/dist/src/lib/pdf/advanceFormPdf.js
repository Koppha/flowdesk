import PDFDocument from "pdfkit";
function formatDate(value) {
    if (!value)
        return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function formatMoney(value, currency) {
    const amount = Number(value || 0);
    return `${currency} ${amount.toFixed(2)}`;
}
function dottedLine(doc, label, value, width) {
    const labelWidth = doc.widthOfString(label);
    doc.text(label, { continued: true });
    const remaining = Math.max(0, width - labelWidth - doc.widthOfString(value) - 10);
    const dots = ".".repeat(Math.max(0, Math.floor(remaining / doc.widthOfString("."))));
    doc.text(` ${dots} `, { continued: true });
    doc.text(value);
}
export function buildAdvanceRequestPdf(advance, lines) {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const currency = advance.currency || "LSL";
    const chain = Array.isArray(advance.approval_chain) ? advance.approval_chain : [];
    const countersigner = chain[0]?.approver_name || "";
    const approverStep = chain.find((step) => step.final_approval) || chain[chain.length - 1];
    const approver = approverStep?.approver_name || "";
    const onBehalfOf = advance.created_by_id !== advance.requester_id ? (advance.created_by_name || "") : "";
    const dates = lines
        .map((line) => line.line_date)
        .filter(Boolean)
        .sort();
    const dateFrom = dates[0];
    const dateTo = dates[dates.length - 1];
    const locations = Array.from(new Set(lines.map((line) => line.location).filter(Boolean)));
    const reasonForTravel = [advance.purpose, locations.length ? `Location(s): ${locations.join(", ")}` : ""]
        .filter(Boolean)
        .join(" — ");
    const amount = formatMoney(advance.approved_total || advance.requested_total, currency);
    const payable = advance.payment_method === "BANK"
        ? `Bank — ${advance.payment_account || ""}`
        : `EcoCash — ${advance.payment_account || ""}`;
    doc.font("Helvetica-Bold").fontSize(14).text("ADVANCE REQUEST FORM", { align: "center" });
    doc.moveDown(1.5);
    doc.font("Helvetica").fontSize(11);
    const halfWidth = contentWidth / 2;
    const startY = doc.y;
    dottedLine(doc, "Requester Name: ", advance.requester_name || "", halfWidth - 10);
    doc.x = doc.page.margins.left + halfWidth;
    doc.y = startY;
    dottedLine(doc, "Dept: ", advance.department || "", halfWidth);
    doc.x = doc.page.margins.left;
    doc.moveDown(1.5);
    dottedLine(doc, "On behalf of: ", onBehalfOf, contentWidth - 110);
    doc.text(" (If necessary)", { continued: false });
    doc.moveDown(1.5);
    doc.text("Location and Reason for Travel:");
    doc.moveDown(0.3);
    doc.text(reasonForTravel || " ", { width: contentWidth });
    doc.moveDown(1.5);
    const dateColWidth = contentWidth / 2;
    const dateY = doc.y;
    dottedLine(doc, "Date From: ", formatDate(dateFrom), dateColWidth - 10);
    doc.x = doc.page.margins.left + dateColWidth;
    doc.y = dateY;
    dottedLine(doc, "To: ", formatDate(dateTo), dateColWidth);
    doc.x = doc.page.margins.left;
    doc.moveDown(2);
    dottedLine(doc, "Total amount: ", amount, contentWidth);
    doc.moveDown(1.5);
    dottedLine(doc, "Payable to Bank/Ecocash: ", payable, contentWidth);
    doc.moveDown(2);
    dottedLine(doc, "Countersigner: ", countersigner, contentWidth);
    doc.moveDown(1.5);
    dottedLine(doc, "Approver: ", approver, contentWidth);
    return doc;
}
