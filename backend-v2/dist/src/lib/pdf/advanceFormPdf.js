import PDFDocument from "pdfkit";
import { dottedLine, formatDate, formatMoney } from "./pdfHelpers.js";
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
