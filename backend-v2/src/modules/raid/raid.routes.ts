import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import {
  DOC_LABEL, RAID_DOC_TYPES, RAID_LEVELS, RAID_STATUSES, RAID_TYPES, loadRaidDoc, raidAccess, raidRef, recordRaidHistory, type RaidDocType
} from "./raid.service.js";
import { buildRaidWorkbook, type RaidExportRow } from "./raid.excel.js";

// RAID logs on BRS, Change Request and Computer Request, with Excel export
// of one document's log or a register across every document you can open.
export const raidRouter = Router();
raidRouter.use(requireAuth);

const DocTypeParam = z.enum(RAID_DOC_TYPES);
const nullableText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const ItemSchema = z.object({
  item_type: z.enum(RAID_TYPES),
  title: z.string().trim().min(1, "Give the item a title").max(200),
  description: nullableText(4000),
  likelihood: z.enum(RAID_LEVELS).nullish(),
  impact: z.enum(RAID_LEVELS).nullish(),
  action: nullableText(4000),
  owner_user_id: z.string().uuid().nullish(),
  owner_text: nullableText(120),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  status: z.enum(RAID_STATUSES).default("OPEN")
});
const PatchSchema = ItemSchema.partial().omit({ item_type: true });

const LABEL: Record<string, string> = {
  title: "Title", description: "Description", likelihood: "Likelihood", impact: "Impact", action: "Action / mitigation",
  owner_user_id: "Owner", owner_text: "Owner", due_date: "Due date", status: "Status"
};

const ITEM_SELECT = `
  SELECT r.*, o.full_name AS owner_name, cb.full_name AS created_by_name, ub.full_name AS updated_by_name
    FROM raid_items r
    LEFT JOIN users o ON o.id = r.owner_user_id
    LEFT JOIN users cb ON cb.id = r.created_by_id
    LEFT JOIN users ub ON ub.id = r.updated_by_id`;
const ITEM_ORDER = `ORDER BY CASE r.item_type WHEN 'RISK' THEN 1 WHEN 'ASSUMPTION' THEN 2 WHEN 'ISSUE' THEN 3 ELSE 4 END, r.ref_no`;

async function openDoc(req: AuthedRequest) {
  const docType = DocTypeParam.parse(req.params.docType) as RaidDocType;
  if (!z.string().uuid().safeParse(req.params.docId).success) throw notFound();
  const doc = await loadRaidDoc(docType, req.params.docId);
  const access = await raidAccess(doc, req.user!);
  if (!access.view) throw forbidden(`You don't have access to this ${DOC_LABEL[docType]}`);
  return { doc, access };
}

async function assertOwner(id: string | null | undefined) {
  if (!id) return;
  if (!(await query(`SELECT 1 FROM users WHERE id = $1 AND is_active = true`, [id]))[0]) throw badRequest("The owner must be an active FlowDesk user");
}

function sendWorkbook(res: any, filename: string, wb: Awaited<ReturnType<typeof buildRaidWorkbook>>) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, "-")}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

// GET /raid/register.xlsx?doc_type=CHANGE_REQUEST&include_closed=true - every
// RAID item on the documents of that kind you can open, in one workbook.
// Registered before the /:docType/:docId routes.
raidRouter.get("/register.xlsx", async (req: AuthedRequest, res, next) => {
  try {
    const docType = DocTypeParam.parse(req.query.doc_type) as RaidDocType;
    const includeClosed = String(req.query.include_closed || "") === "true";
    const rows = await query<any>(`${ITEM_SELECT} WHERE r.doc_type = $1 ${includeClosed ? "" : "AND r.status <> 'CLOSED'"} ORDER BY r.doc_id, r.item_type, r.ref_no`, [docType]);
    const out: RaidExportRow[] = [];
    const docIds = [...new Set(rows.map((r) => r.doc_id as string))];
    for (const id of docIds) {
      const doc = await loadRaidDoc(docType, id).catch(() => null);
      if (!doc || !(await raidAccess(doc, req.user!)).view) continue;
      for (const r of rows.filter((x) => x.doc_id === id)) out.push({ ...r, doc_type: docType, doc_reference: doc.reference, doc_title: doc.title });
    }
    const wb = await buildRaidWorkbook({
      heading: `${DOC_LABEL[docType]} RAID register`,
      subheading: `${out.length} ${includeClosed ? "" : "open "}items across ${new Set(out.map((r) => r.doc_reference)).size} ${DOC_LABEL[docType]}s you can open · exported ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Maseru" })} by ${req.user!.fullName || "FlowDesk"}`,
      rows: out,
      register: true
    });
    return sendWorkbook(res, `${DOC_LABEL[docType]}-RAID-register-${new Date().toISOString().slice(0, 10)}.xlsx`, wb);
  } catch (err) {
    return next(err);
  }
});

// GET /raid/:docType/:docId - the log, plus what the viewer may do.
raidRouter.get("/:docType/:docId", async (req: AuthedRequest, res, next) => {
  try {
    const { doc, access } = await openDoc(req);
    const items = await query<any>(`${ITEM_SELECT} WHERE r.doc_type = $1 AND r.doc_id = $2 ${ITEM_ORDER}`, [doc.docType, doc.id]);
    return res.json({
      doc: { type: doc.docType, id: doc.id, reference: doc.reference, title: doc.title },
      can_edit: access.edit, can_manage: access.manage,
      items: items.map((i) => ({ ...i, ref: raidRef(i), can_delete: access.manage || (access.edit && i.created_by_id === req.user!.userId) }))
    });
  } catch (err) {
    return next(err);
  }
});

raidRouter.post("/:docType/:docId", async (req: AuthedRequest, res, next) => {
  try {
    const { doc, access } = await openDoc(req);
    if (!access.edit) throw forbidden("You can view this RAID log but not change it");
    const parsed = ItemSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid RAID item", parsed.error.flatten());
    const d = parsed.data;
    await assertOwner(d.owner_user_id);
    const refNo = (await query<{ n: number }>(
      `SELECT coalesce(max(ref_no), 0) + 1 AS n FROM raid_items WHERE doc_type = $1 AND doc_id = $2 AND item_type = $3`, [doc.docType, doc.id, d.item_type]
    ))[0].n;
    const item = (await query<any>(
      `INSERT INTO raid_items (doc_type, doc_id, item_type, ref_no, title, description, likelihood, impact, action, owner_user_id, owner_text, due_date, status, closed_at, created_by_id, updated_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13 = 'CLOSED' THEN now() END, $14, $14) RETURNING *`,
      [doc.docType, doc.id, d.item_type, refNo, d.title, d.description, d.item_type === "RISK" ? d.likelihood ?? null : null, d.impact ?? null,
       d.action, d.owner_user_id ?? null, d.owner_user_id ? null : d.owner_text, d.due_date ?? null, d.status, req.user!.userId]
    ))[0];
    await recordRaidHistory(doc, req.user!, `RAID log: added ${raidRef(item)} "${item.title}"`).catch(() => {});
    return res.status(201).json({ id: item.id, ref: raidRef(item) });
  } catch (err) {
    return next(err);
  }
});

raidRouter.patch("/:docType/:docId/:itemId", async (req: AuthedRequest, res, next) => {
  try {
    const { doc, access } = await openDoc(req);
    if (!access.edit) throw forbidden("You can view this RAID log but not change it");
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid RAID item", parsed.error.flatten());
    const before = (await query<any>(`${ITEM_SELECT} WHERE r.id = $1 AND r.doc_type = $2 AND r.doc_id = $3`, [req.params.itemId, doc.docType, doc.id]))[0];
    if (!before) throw notFound("RAID item not found");
    const d = { ...parsed.data };
    if (d.owner_user_id !== undefined) await assertOwner(d.owner_user_id);
    if (d.owner_user_id) d.owner_text = null;
    if (before.item_type !== "RISK") delete d.likelihood;

    const changes: Array<{ key: string; label: string; before: unknown; after: unknown }> = [];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(d)) {
      if (value === undefined) continue;
      const prev = before[key] instanceof Date ? before[key].toISOString().slice(0, 10) : before[key];
      if ((prev ?? null) === (value ?? null)) continue;
      params.push(value ?? null);
      sets.push(`${key} = $${params.length}`);
      changes.push({ key: `raid_${key}`, label: `${raidRef(before)} ${LABEL[key] || key}`, before: prev ?? null, after: value ?? null });
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    if (d.status && d.status !== before.status) sets.push(d.status === "CLOSED" ? "closed_at = now()" : "closed_at = NULL");
    params.push(req.user!.userId, before.id);
    await query(`UPDATE raid_items SET ${sets.join(", ")}, updated_by_id = $${params.length - 1}, updated_at = now() WHERE id = $${params.length}`, params);

    // Owner ids read better as names in the history.
    for (const c of changes) {
      if (c.key === "raid_owner_user_id") {
        const names = await query<{ id: string; n: string }>(`SELECT id, coalesce(full_name, email) AS n FROM users WHERE id = ANY($1::uuid[])`, [[c.before, c.after].filter(Boolean)]);
        c.before = names.find((x) => x.id === c.before)?.n ?? c.before;
        c.after = names.find((x) => x.id === c.after)?.n ?? c.after;
      }
    }
    const statusChange = changes.find((c) => c.key === "raid_status");
    await recordRaidHistory(doc, req.user!,
      `RAID log: ${statusChange ? `${raidRef(before)} ${String(statusChange.before).toLowerCase().replace("_", " ")} → ${String(statusChange.after).toLowerCase().replace("_", " ")}` : `updated ${raidRef(before)} (${changes.map((c) => c.label.replace(`${raidRef(before)} `, "")).join(", ")})`}`,
      changes).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

raidRouter.delete("/:docType/:docId/:itemId", async (req: AuthedRequest, res, next) => {
  try {
    const { doc, access } = await openDoc(req);
    const item = (await query<any>(`SELECT * FROM raid_items WHERE id = $1 AND doc_type = $2 AND doc_id = $3`, [req.params.itemId, doc.docType, doc.id]))[0];
    if (!item) throw notFound("RAID item not found");
    if (!access.manage && !(access.edit && item.created_by_id === req.user!.userId)) throw forbidden("Only whoever raised this item, or the document's owners, can delete it");
    await query(`DELETE FROM raid_items WHERE id = $1`, [item.id]);
    await recordRaidHistory(doc, req.user!, `RAID log: deleted ${raidRef(item)} "${item.title}"`,
      [{ key: "raid_deleted", label: `${raidRef(item)} ${item.title}`, before: item.description || item.title, after: null }]).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /raid/:docType/:docId/export.xlsx - this document's log as Excel.
raidRouter.get("/:docType/:docId/export.xlsx", async (req: AuthedRequest, res, next) => {
  try {
    const { doc } = await openDoc(req);
    const rows = await query<any>(`${ITEM_SELECT} WHERE r.doc_type = $1 AND r.doc_id = $2 ${ITEM_ORDER}`, [doc.docType, doc.id]);
    const open = rows.filter((r) => r.status !== "CLOSED").length;
    const wb = await buildRaidWorkbook({
      heading: `RAID log — ${DOC_LABEL[doc.docType]} ${doc.reference}: ${doc.title}`,
      subheading: `${rows.length} items, ${open} open · exported ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Maseru" })} by ${req.user!.fullName || "FlowDesk"}`,
      rows,
      register: false
    });
    return sendWorkbook(res, `RAID-${doc.reference || doc.docType}.xlsx`, wb);
  } catch (err) {
    return next(err);
  }
});
