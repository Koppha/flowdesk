import ExcelJS from "exceljs";
import { DOC_LABEL, raidRef, type RaidDocType } from "./raid.service.js";

// RAID log workbooks: one document's log, or a register across many.
// Real Excel dates, a frozen filtered header, dropdowns on the coded
// columns so the sheet stays usable when edited offline, and a Summary sheet.

export type RaidExportRow = {
  item_type: string; ref_no: number; title: string; description: string | null;
  likelihood: string | null; impact: string | null; action: string | null;
  owner_name: string | null; owner_text: string | null; due_date: string | null; status: string;
  created_by_name: string | null; created_at: string; updated_by_name: string | null; updated_at: string; closed_at: string | null;
  // register only
  doc_type?: RaidDocType; doc_reference?: string; doc_title?: string;
};

const TYPE_LABEL: Record<string, string> = { RISK: "Risk", ASSUMPTION: "Assumption", ISSUE: "Issue", DEPENDENCY: "Dependency" };
const LEVEL_LABEL: Record<string, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const STATUS_LABEL: Record<string, string> = { OPEN: "Open", IN_PROGRESS: "In progress", MONITORING: "Monitoring", CLOSED: "Closed" };
const SCORE: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const FILL: Record<string, string> = { High: "FFFEE2E2", Medium: "FFFEF3C7", Low: "FFDCFCE7" };

// Risks: likelihood x impact (1-9). Other items: their impact alone.
export function raidRating(r: { item_type: string; likelihood: string | null; impact: string | null }) {
  if (!r.impact) return null;
  if (r.item_type === "RISK" && r.likelihood) {
    const score = SCORE[r.likelihood] * SCORE[r.impact];
    return { label: score >= 6 ? "High" : score >= 3 ? "Medium" : "Low", score };
  }
  return { label: LEVEL_LABEL[r.impact], score: SCORE[r.impact] * SCORE[r.impact] };
}

const asDate = (v: string | null) => (v ? new Date(v) : null);

export async function buildRaidWorkbook(args: {
  heading: string;
  subheading: string;
  rows: RaidExportRow[];
  register: boolean;
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FlowDesk";
  wb.created = new Date();
  const ws = wb.addWorksheet("RAID log", { views: [{ state: "frozen", ySplit: 4 }] });

  const cols: Array<{ header: string; key: string; width: number }> = [
    ...(args.register ? [
      { header: "Module", key: "module", width: 16 },
      { header: "Reference", key: "reference", width: 16 },
      { header: "Document", key: "document", width: 34 }
    ] : []),
    { header: "ID", key: "ref", width: 7 },
    { header: "Type", key: "type", width: 13 },
    { header: "Title", key: "title", width: 34 },
    { header: "Description", key: "description", width: 44 },
    { header: "Likelihood", key: "likelihood", width: 11 },
    { header: "Impact", key: "impact", width: 10 },
    { header: "Rating", key: "rating", width: 12 },
    { header: "Action / mitigation", key: "action", width: 44 },
    { header: "Owner", key: "owner", width: 22 },
    { header: "Due date", key: "due", width: 12 },
    { header: "Status", key: "status", width: 13 },
    { header: "Raised by", key: "raised_by", width: 20 },
    { header: "Raised on", key: "raised_on", width: 12 },
    { header: "Last updated by", key: "updated_by", width: 20 },
    { header: "Last updated", key: "updated_on", width: 12 },
    { header: "Closed on", key: "closed_on", width: 12 }
  ];
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));

  ws.mergeCells(1, 1, 1, Math.min(cols.length, 8));
  ws.getCell(1, 1).value = args.heading;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, Math.min(cols.length, 8));
  ws.getCell(2, 1).value = args.subheading;
  ws.getCell(2, 1).font = { color: { argb: "FF64748B" }, size: 10 };

  const header = ws.getRow(4);
  cols.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 22;
  header.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } }; });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const colIndex = (key: string) => cols.findIndex((c) => c.key === key) + 1;
  args.rows.forEach((r, i) => {
    const rating = raidRating(r);
    const row = ws.getRow(5 + i);
    const values: Record<string, unknown> = {
      module: r.doc_type ? DOC_LABEL[r.doc_type] : null,
      reference: r.doc_reference ?? null,
      document: r.doc_title ?? null,
      ref: raidRef(r),
      type: TYPE_LABEL[r.item_type] || r.item_type,
      title: r.title,
      description: r.description || null,
      likelihood: r.item_type === "RISK" && r.likelihood ? LEVEL_LABEL[r.likelihood] : null,
      impact: r.impact ? LEVEL_LABEL[r.impact] : null,
      rating: rating ? `${rating.label} (${rating.score})` : null,
      action: r.action || null,
      owner: r.owner_name || r.owner_text || null,
      due: asDate(r.due_date),
      status: STATUS_LABEL[r.status] || r.status,
      raised_by: r.created_by_name,
      raised_on: asDate(r.created_at),
      updated_by: r.updated_by_name,
      updated_on: asDate(r.updated_at),
      closed_on: asDate(r.closed_at)
    };
    cols.forEach((c, ci) => { row.getCell(ci + 1).value = values[c.key] as ExcelJS.CellValue; });
    row.alignment = { vertical: "top", wrapText: true };
    for (const k of ["due", "raised_on", "updated_on", "closed_on"]) row.getCell(colIndex(k)).numFmt = "dd mmm yyyy";
    if (rating) row.getCell(colIndex("rating")).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[rating.label] } };
    if (r.status === "CLOSED") row.font = { color: { argb: "FF94A3B8" } };
    else if (r.due_date && new Date(r.due_date) < today) row.getCell(colIndex("due")).font = { bold: true, color: { argb: "FFB91C1C" } };
    row.eachCell({ includeEmpty: true }, (cell) => { cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } }; });
  });

  // Dropdowns on the coded columns (kept for 500 rows so new rows get them too).
  const lastRow = Math.max(5 + args.rows.length + 200, 505);
  const list = (key: string, values: string[]) => {
    const letter = ws.getColumn(colIndex(key)).letter;
    for (let n = 5; n <= lastRow; n++) {
      ws.getCell(`${letter}${n}`).dataValidation = { type: "list", allowBlank: true, formulae: [`"${values.join(",")}"`] };
    }
  };
  list("type", Object.values(TYPE_LABEL));
  list("likelihood", Object.values(LEVEL_LABEL));
  list("impact", Object.values(LEVEL_LABEL));
  list("status", Object.values(STATUS_LABEL));
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + Math.max(args.rows.length, 1), column: cols.length } };

  // Summary: type x status, plus what needs attention.
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ width: 18 }, { width: 10 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 10 }];
  sum.getCell("A1").value = "Summary"; sum.getCell("A1").font = { bold: true, size: 14 };
  sum.getCell("A2").value = args.heading; sum.getCell("A2").font = { color: { argb: "FF64748B" }, size: 10 };
  const statuses = Object.keys(STATUS_LABEL);
  const head = sum.getRow(4);
  ["Type", ...statuses.map((s) => STATUS_LABEL[s]), "Total"].forEach((h, i) => { head.getCell(i + 1).value = h; });
  head.font = { bold: true };
  Object.keys(TYPE_LABEL).forEach((t, i) => {
    const row = sum.getRow(5 + i);
    row.getCell(1).value = TYPE_LABEL[t] + "s";
    statuses.forEach((s, si) => { row.getCell(2 + si).value = args.rows.filter((r) => r.item_type === t && r.status === s).length; });
    row.getCell(2 + statuses.length).value = args.rows.filter((r) => r.item_type === t).length;
  });
  const totals = sum.getRow(9);
  totals.getCell(1).value = "Total"; totals.font = { bold: true };
  statuses.forEach((s, si) => { totals.getCell(2 + si).value = args.rows.filter((r) => r.status === s).length; });
  totals.getCell(2 + statuses.length).value = args.rows.length;
  const open = args.rows.filter((r) => r.status !== "CLOSED");
  sum.getCell("A11").value = "Open and rated High"; sum.getCell("B11").value = open.filter((r) => raidRating(r)?.label === "High").length;
  sum.getCell("A12").value = "Open and overdue"; sum.getCell("B12").value = open.filter((r) => r.due_date && new Date(r.due_date) < today).length;
  sum.getCell("A11").font = { bold: true }; sum.getCell("A12").font = { bold: true };

  return wb;
}
