import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { ensureLocalFile, persistentDiskStorage } from "../../lib/fileStore.js";
import { notifyMaintenanceEvent } from "../../lib/notifications.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { getBooleanSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { fileExtensionFilter, sanitizeUploadFilename } from "../../lib/uploads.js";
import {
  type Actor, OPEN_STATUSES, PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, WORKING_STATUSES,
  addWorkingDays, attachPhotos, canApproveCurrentStep, dbToday, isAnyAdminOffice, isInAdminOffice,
  nextRequestNo, notifyEvent, recordEvent, resolveAdminOffice, resolveApprovalChain, syncAssigneeWorkers, workerName
} from "./maintenance.service.js";

export const maintenanceRouter = Router();
maintenanceRouter.use(requireAuth);

const uploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "maintenance");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const uploadPhoto = multer({
  storage: persistentDiskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["jpg", "jpeg", "png", "heic", "heif", "webp"])
});

// Maintenance is a process an admin switches on under Process (off by
// default). While it's off nobody can log a request; requests already open
// can still be finished, and the Admin Office can prepare its lists.
const isEnabled = () => getBooleanSystemSetting(SYSTEM_SETTING_KEYS.maintenanceModuleEnabled, false);
async function assertEnabled() {
  if (!(await isEnabled())) throw badRequest("Maintenance requests are switched off. An administrator can switch them on under Process.");
}

const actorOf = (req: AuthedRequest): Actor => ({ userId: req.user!.userId, role: req.user!.role, fullName: req.user!.fullName ?? null, sectionId: req.user!.sectionId ?? null });

const REQUEST_SELECT = `
  SELECT r.*, u.full_name AS requester_name, u.email AS requester_email,
         w.user_id AS worker_user_id, coalesce(wu.full_name, w.contractor_name) AS worker_name,
         (w.id IS NOT NULL AND w.user_id IS NULL) AS worker_is_contractor, w.contractor_phone AS worker_phone,
         coalesce(st.staff_groups, '{}') AS site_staff_groups
    FROM maintenance_requests r
    JOIN users u ON u.id = r.requester_id
    LEFT JOIN maintenance_workers w ON w.id = r.worker_id
    LEFT JOIN users wu ON wu.id = w.user_id
    LEFT JOIN maintenance_sites st ON st.id = r.site_id`;

async function loadRequest(id: string) {
  return (await query<any>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]))[0] ?? null;
}

// Who this person is on this request, and so what they may see and do.
async function contextFor(r: any, actor: Actor, groups: string[]) {
  const isRequester = r.requester_id === actor.userId;
  const isOffice = await isInAdminOffice(r.admin_office, actor, groups);
  const isWorker = !!r.worker_user_id && r.worker_user_id === actor.userId;
  const canApprove = await canApproveCurrentStep(r, actor);
  const inChain = Array.isArray(r.approval_chain) && r.approval_chain.some((s: any) => (s.approver_ids?.length ? s.approver_ids : [s.approver_id]).includes(actor.userId));
  const isSiteStaff = (r.site_staff_groups || []).some((g: string) => groups.includes(g));
  return { isRequester, isOffice, isWorker, canApprove, isSiteStaff, canView: isRequester || isOffice || isWorker || canApprove || inChain || isSiteStaff };
}
type Ctx = Awaited<ReturnType<typeof contextFor>>;

// What each person may do now. The Admin Office also acts for a contractor
// with no FlowDesk login (accept, update, complete on their behalf).
function permissions(r: any, c: Ctx) {
  const s = r.status;
  const open = OPEN_STATUSES.includes(s);
  const forWorker = c.isWorker || (c.isOffice && r.worker_is_contractor);
  return {
    review: c.isOffice && s === "SUBMITTED",
    request_info: c.isOffice && ["SUBMITTED", "REVIEWED", "REOPENED"].includes(s),
    assign: c.isOffice && ["SUBMITTED", "REVIEWED", "ASSIGNED", "REOPENED", ...WORKING_STATUSES].includes(s),
    request_approval: (c.isOffice || forWorker) && ["REVIEWED", "ASSIGNED", "REOPENED", ...WORKING_STATUSES].includes(s),
    verify: c.isOffice && s === "COMPLETED_PENDING_VERIFICATION",
    send_back: c.isOffice && s === "COMPLETED_PENDING_VERIFICATION",
    cancel: (c.isOffice && open) || (c.isRequester && ["SUBMITTED", "PENDING_INFORMATION"].includes(s)),
    accept: forWorker && ["ASSIGNED", "REOPENED"].includes(s),
    decline: forWorker && ["ASSIGNED", "REOPENED"].includes(s),
    set_status: forWorker && WORKING_STATUSES.includes(s),
    complete: forWorker && WORKING_STATUSES.includes(s),
    approve: c.canApprove,
    reject_approval: c.canApprove,
    provide_info: c.isRequester && s === "PENDING_INFORMATION",
    request_update: (c.isRequester || c.isSiteStaff) && open && !["SUBMITTED", "PENDING_INFORMATION", "PENDING_CONFIRMATION"].includes(s) && !r.update_requested_at,
    confirm: c.isRequester && s === "PENDING_CONFIRMATION",
    reopen: c.isRequester && s === "PENDING_CONFIRMATION",
    comment: c.canView && open
  };
}

// The one thing this person should do next, for lists and the Approval Inbox.
function nextStepFor(r: any, c: Ctx): string | null {
  const s = r.status;
  const forWorker = c.isWorker || (c.isOffice && r.worker_is_contractor);
  if (c.canApprove) return "Approve or reject the spend";
  if (c.isRequester && s === "PENDING_INFORMATION") return "Answer the Admin Office's question";
  if (c.isRequester && s === "PENDING_CONFIRMATION") return "Confirm it's fixed or reopen";
  if (forWorker && ["ASSIGNED", "REOPENED"].includes(s)) return s === "REOPENED" ? "Reopened - accept and fix" : "Accept or decline";
  if (forWorker && r.update_requested_at && WORKING_STATUSES.includes(s)) return "Post an update";
  if (c.isOffice) {
    if (s === "SUBMITTED") return "Review and assign";
    if (s === "REVIEWED") return "Assign a worker";
    if (s === "COMPLETED_PENDING_VERIFICATION") return "Verify the work";
    if (s === "REOPENED" && !r.worker_id) return "Reassign";
    if (r.update_requested_at && OPEN_STATUSES.includes(s)) return "Reply to the user";
    if (r.approval_status === "REJECTED" && s !== "AWAITING_APPROVAL" && OPEN_STATUSES.includes(s)) return "Spend rejected - decide";
  }
  return null;
}

function summary(r: any, c: Ctx) {
  return {
    id: r.id, request_no: r.request_no, status: r.status, status_label: STATUS_LABELS[r.status] || r.status,
    priority: r.priority, priority_label: PRIORITY_LABELS[r.priority] || r.priority,
    site_name: r.site_name, district: r.district, location: r.location, category: r.category,
    description: r.description, requester_name: r.requester_name, worker_name: r.worker_name,
    target_date: r.target_date, update_requested: !!r.update_requested_at, created_at: r.created_at, updated_at: r.updated_at,
    next_step: nextStepFor(r, c)
  };
}

// For the Approval Inbox: requests where this person has the next move.
export async function maintenanceInboxItems(actor: Actor) {
  const rows = await query<any>(`${REQUEST_SELECT} WHERE r.status = ANY($1::text[]) ORDER BY r.created_at DESC`, [OPEN_STATUSES]);
  if (!rows.length) return [];
  const groups = await getUserGroups(actor.userId);
  const items: any[] = [];
  for (const r of rows) {
    const c = await contextFor(r, actor, groups);
    if (!c.canView) continue;
    const step = nextStepFor(r, c);
    if (!step) continue;
    items.push({
      doc_type: "MAINTENANCE_REQUEST", id: r.id, status: r.status, status_label: STATUS_LABELS[r.status],
      request_no: r.request_no, site_name: r.site_name, location: r.location, category: r.category,
      priority: r.priority, requester_name: r.requester_name, task_label: step,
      current_step_actionable_by_me: true, created_at: r.created_at
    });
  }
  return items;
}

// ── Lists and settings ───────────────────────────────────────────────────────
async function lists(includeInactive: boolean) {
  const where = includeInactive ? "" : "WHERE active";
  const [sites, categories, targets, settings] = await Promise.all([
    query(`SELECT id, name, district, kind, staff_groups, active FROM maintenance_sites ${where} ORDER BY name`),
    query(`SELECT id, name, photo_required, active, sort_order FROM maintenance_categories ${where} ORDER BY sort_order, name`),
    query(`SELECT priority, respond_hours::float AS respond_hours, fix_working_days FROM maintenance_priority_targets`),
    query<{ key: string; value: string }>(`SELECT key, value FROM maintenance_settings`)
  ]);
  return { sites, categories, targets, settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) };
}

// Who the Admin Office may assign: the workflow's "Assignee" step (plus
// outside contractors) when there is one, otherwise every active worker.
async function assignableWorkers() {
  const pool = await syncAssigneeWorkers();
  const all = await workers(false);
  return pool ? all.filter((w: any) => w.is_contractor || pool.includes(w.user_id)) : all;
}

async function workers(includeInactive: boolean) {
  return query(
    `SELECT w.id, w.user_id, coalesce(u.full_name, w.contractor_name) AS name, u.email, w.contractor_company, w.contractor_phone, w.contractor_email,
            (w.user_id IS NULL) AS is_contractor, w.active
       FROM maintenance_workers w LEFT JOIN users u ON u.id = w.user_id
      ${includeInactive ? "" : "WHERE w.active AND (u.id IS NULL OR u.is_active)"}
      ORDER BY 3`
  );
}

maintenanceRouter.get("/meta", async (req: AuthedRequest, res, next) => {
  try {
    const actor = actorOf(req);
    const groups = await getUserGroups(actor.userId);
    const [l, office, worker, route] = await Promise.all([
      lists(false),
      isAnyAdminOffice(actor, groups),
      query<{ id: string }>(`SELECT id FROM maintenance_workers WHERE user_id = $1 AND active`, [actor.userId]),
      resolveAdminOffice(actor.userId)
    ]);
    const mySites = (l.sites as any[]).filter((s) => (s.staff_groups || []).some((g: string) => groups.includes(g))).map((s) => s.id);
    return res.json({
      ...l, priorities: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })), status_labels: STATUS_LABELS, enabled: await isEnabled(),
      is_admin_office: office, is_worker: worker.length > 0, my_site_ids: mySites, has_route: !!route,
      workers: office ? await assignableWorkers() : []
    });
  } catch (err) { return next(err); }
});

async function assertListsAccess(req: AuthedRequest) {
  if (!(await isAnyAdminOffice(actorOf(req)))) throw forbidden("Only the Admin Office can change the maintenance lists");
}

maintenanceRouter.get("/admin/lists", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const orgGroups = await query<{ g: string }>(
      `SELECT 'Department: ' || name AS g FROM departments WHERE coalesce(active, true)
       UNION SELECT 'Section: ' || name FROM sections WHERE coalesce(active, true)
       UNION SELECT 'Team: ' || name FROM teams WHERE coalesce(active, true) ORDER BY 1`
    );
    const users = await query(`SELECT id, full_name, email FROM users WHERE is_active ORDER BY full_name NULLS LAST`);
    return res.json({ ...(await lists(true)), workers: await workers(true), org_groups: orgGroups.map((o) => o.g), users });
  } catch (err) { return next(err); }
});

const SiteSchema = z.object({
  name: z.string().trim().min(2).max(120), district: z.string().trim().max(80).default(""),
  kind: z.enum(["STORE", "OFFICE"]).default("STORE"), staff_groups: z.array(z.string().trim().min(1)).max(30).default([]), active: z.boolean().default(true)
});
maintenanceRouter.post("/admin/sites", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = SiteSchema.safeParse(req.body);
    if (!p.success) throw badRequest("Check the site's name and district", p.error.flatten());
    const row = (await query(`INSERT INTO maintenance_sites (name, district, kind, staff_groups, active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [p.data.name, p.data.district, p.data.kind, p.data.staff_groups, p.data.active]).catch((e) => { if (e?.code === "23505") throw badRequest("A site with that name already exists"); throw e; }))[0];
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});
maintenanceRouter.patch("/admin/sites/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = SiteSchema.partial().safeParse(req.body);
    if (!p.success) throw badRequest("Check the site's details", p.error.flatten());
    const d = p.data;
    const row = (await query(
      `UPDATE maintenance_sites SET name = coalesce($2, name), district = coalesce($3, district), kind = coalesce($4, kind),
              staff_groups = coalesce($5, staff_groups), active = coalesce($6, active), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, d.name ?? null, d.district ?? null, d.kind ?? null, d.staff_groups ?? null, d.active ?? null]
    ).catch((e) => { if (e?.code === "23505") throw badRequest("A site with that name already exists"); throw e; }))[0];
    if (!row) throw notFound();
    return res.json(row);
  } catch (err) { return next(err); }
});

const CategorySchema = z.object({ name: z.string().trim().min(2).max(80), photo_required: z.boolean().default(true), active: z.boolean().default(true), sort_order: z.number().int().default(0) });
maintenanceRouter.post("/admin/categories", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = CategorySchema.safeParse(req.body);
    if (!p.success) throw badRequest("Give the category a name");
    const row = (await query(`INSERT INTO maintenance_categories (name, photo_required, active, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [p.data.name, p.data.photo_required, p.data.active, p.data.sort_order]).catch((e) => { if (e?.code === "23505") throw badRequest("That category already exists"); throw e; }))[0];
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});
maintenanceRouter.patch("/admin/categories/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = CategorySchema.partial().safeParse(req.body);
    if (!p.success) throw badRequest("Check the category");
    const d = p.data;
    const row = (await query(
      `UPDATE maintenance_categories SET name = coalesce($2, name), photo_required = coalesce($3, photo_required), active = coalesce($4, active), sort_order = coalesce($5, sort_order)
        WHERE id = $1 RETURNING *`,
      [req.params.id, d.name ?? null, d.photo_required ?? null, d.active ?? null, d.sort_order ?? null]
    ))[0];
    if (!row) throw notFound();
    return res.json(row);
  } catch (err) { return next(err); }
});

const WorkerSchema = z.object({
  user_id: z.string().uuid().nullish(), contractor_name: z.string().trim().max(120).nullish(), contractor_company: z.string().trim().max(120).nullish(),
  contractor_phone: z.string().trim().max(40).nullish(), contractor_email: z.string().trim().email().nullish().or(z.literal("")), active: z.boolean().default(true)
});
maintenanceRouter.post("/admin/workers", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = WorkerSchema.safeParse(req.body);
    if (!p.success) throw badRequest("Pick a FlowDesk user, or give the contractor's name", p.error.flatten());
    const d = p.data;
    if (!d.user_id && !d.contractor_name) throw badRequest("Pick a FlowDesk user, or give the contractor's name");
    const row = (await query(
      `INSERT INTO maintenance_workers (user_id, contractor_name, contractor_company, contractor_phone, contractor_email, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.user_id ?? null, d.user_id ? null : d.contractor_name, d.contractor_company || null, d.contractor_phone || null, d.contractor_email || null, d.active]
    ).catch((e) => { if (e?.code === "23505") throw badRequest("That person is already a worker"); throw e; }))[0];
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});
maintenanceRouter.patch("/admin/workers/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = WorkerSchema.partial().safeParse(req.body);
    if (!p.success) throw badRequest("Check the worker's details");
    const d = p.data;
    const row = (await query(
      `UPDATE maintenance_workers SET contractor_name = coalesce($2, contractor_name), contractor_company = coalesce($3, contractor_company),
              contractor_phone = coalesce($4, contractor_phone), contractor_email = coalesce($5, contractor_email), active = coalesce($6, active)
        WHERE id = $1 RETURNING *`,
      [req.params.id, d.contractor_name ?? null, d.contractor_company ?? null, d.contractor_phone ?? null, d.contractor_email || null, d.active ?? null]
    ))[0];
    if (!row) throw notFound();
    return res.json(row);
  } catch (err) { return next(err); }
});

maintenanceRouter.put("/admin/targets", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = z.array(z.object({ priority: z.enum(PRIORITIES), respond_hours: z.number().positive().max(2000), fix_working_days: z.number().int().min(0).max(365) })).safeParse(req.body);
    if (!p.success) throw badRequest("Check the targets");
    for (const t of p.data) {
      await query(`INSERT INTO maintenance_priority_targets (priority, respond_hours, fix_working_days) VALUES ($1,$2,$3)
                   ON CONFLICT (priority) DO UPDATE SET respond_hours = EXCLUDED.respond_hours, fix_working_days = EXCLUDED.fix_working_days`,
        [t.priority, t.respond_hours, t.fix_working_days]);
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

maintenanceRouter.put("/admin/settings", async (req: AuthedRequest, res, next) => {
  try {
    await assertListsAccess(req);
    const p = z.object({ spend_limit: z.number().min(0).nullish(), auto_close_working_days: z.number().int().min(1).max(30).optional() }).safeParse(req.body);
    if (!p.success) throw badRequest("Check the settings");
    if (p.data.spend_limit === null) await query(`DELETE FROM maintenance_settings WHERE key = 'spend_limit'`);
    else if (p.data.spend_limit !== undefined) await query(`INSERT INTO maintenance_settings (key, value) VALUES ('spend_limit', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(p.data.spend_limit)]);
    if (p.data.auto_close_working_days !== undefined) await query(`INSERT INTO maintenance_settings (key, value) VALUES ('auto_close_working_days', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(p.data.auto_close_working_days)]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── Photos ───────────────────────────────────────────────────────────────────
// One photo per call, so a dropped connection only retries that one; the
// form attaches the returned ids when it submits (PH-05).
maintenanceRouter.post("/photos", uploadPhoto.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    const f = req.file;
    // Updates on open requests still take photos; only a brand-new request is blocked (below).
    if (!f) throw badRequest("Choose a photo");
    const row = (await query<{ id: string }>(
      `INSERT INTO maintenance_photos (file_path, original_name, content_type, size_bytes, uploaded_by_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [f.path, f.originalname, f.mimetype, f.size, req.user!.userId]
    ))[0];
    return res.status(201).json({ id: row.id });
  } catch (err) { return next(err); }
});

maintenanceRouter.get("/photos/:id", async (req: AuthedRequest, res, next) => {
  try {
    const photo = (await query<any>(`SELECT * FROM maintenance_photos WHERE id = $1`, [req.params.id]))[0];
    if (!photo) throw notFound();
    if (photo.deleted_at) return res.status(410).json({ error: "This photo was deleted by an administrator" });
    if (!photo.request_id) {
      if (photo.uploaded_by_id !== req.user!.userId) throw forbidden();
    } else {
      const r = await loadRequest(photo.request_id);
      if (!r || !(await contextFor(r, actorOf(req), await getUserGroups(req.user!.userId))).canView) throw forbidden();
    }
    const local = await ensureLocalFile(photo.file_path);
    if (!local) throw notFound("This photo's file is missing");
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (photo.content_type) res.type(photo.content_type);
    return res.sendFile(path.resolve(local));
  } catch (err) { return next(err); }
});

// PH-08: only an administrator deletes a photo, with a reason, and it's logged.
maintenanceRouter.delete("/photos/:id", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can delete a photo");
    const reason = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
    if (!reason.success) throw badRequest("Give a reason for deleting the photo");
    const photo = (await query<any>(
      `UPDATE maintenance_photos SET deleted_at = now(), deleted_by_id = $2, delete_reason = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id, req.user!.userId, reason.data.reason]
    ))[0];
    if (!photo) throw notFound();
    if (photo.request_id) await recordEvent(photo.request_id, req.user!.userId, "PHOTO_DELETED", null, null, `Deleted a photo: ${reason.data.reason}`);
    await query(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1, 'MAINTENANCE_PHOTO_DELETED', 'maintenance_photo', $2, $3, $4)`,
      [req.user!.userId, photo.id, JSON.stringify({ request_id: photo.request_id, file: photo.original_name }), JSON.stringify({ reason: reason.data.reason })]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── Requests ─────────────────────────────────────────────────────────────────
maintenanceRouter.get("/requests", async (req: AuthedRequest, res, next) => {
  try {
    const actor = actorOf(req);
    const scope = String(req.query.scope || "mine");
    const status = String(req.query.status || "open");
    const statusSql = status === "open" ? `r.status = ANY('{${OPEN_STATUSES.join(",")}}'::text[])`
      : status === "closed" ? `r.status = 'CLOSED'` : status === "cancelled" ? `r.status = 'CANCELLED'` : `true`;
    const groups = await getUserGroups(actor.userId);
    let where = "";
    const params: unknown[] = [];
    if (scope === "mine") { params.push(actor.userId); where = `r.requester_id = $1`; }
    else if (scope === "site") { params.push(groups); where = `st.staff_groups && $1::text[]`; }
    else if (scope === "jobs") { params.push(actor.userId); where = `w.user_id = $1`; }
    else if (scope === "office" || scope === "approvals") where = "true";
    else throw badRequest("Unknown list");
    const rows = await query<any>(`${REQUEST_SELECT} WHERE ${where} AND ${statusSql} ORDER BY r.created_at DESC LIMIT 500`, params);
    const out: any[] = [];
    for (const r of rows) {
      const c = await contextFor(r, actor, groups);
      if (scope === "office" && !c.isOffice) continue;
      if (scope === "approvals" && !c.canApprove) continue;
      out.push(summary(r, c));
    }
    return res.json(out);
  } catch (err) { return next(err); }
});

const CreateSchema = z.object({
  site_id: z.string().uuid(), location: z.string().trim().min(2).max(200), contact_name: z.string().trim().min(2).max(120),
  contact_phone: z.string().trim().min(5).max(40), category_id: z.string().uuid(), priority: z.enum(PRIORITIES),
  asset_tag: z.string().trim().max(80).optional().default(""), description: z.string().trim().min(5).max(4000),
  access_times: z.string().trim().max(200).optional().default(""), photo_ids: z.array(z.string().uuid()).max(5).default([])
});

maintenanceRouter.post("/requests", async (req: AuthedRequest, res, next) => {
  try {
    await assertEnabled();
    const actor = actorOf(req);
    const p = CreateSchema.safeParse(req.body);
    if (!p.success) throw badRequest("Fill in every required field", p.error.flatten());
    const d = p.data;
    const site = (await query<any>(`SELECT * FROM maintenance_sites WHERE id = $1 AND active`, [d.site_id]))[0];
    if (!site) throw badRequest("Pick a site from the list");
    const cat = (await query<any>(`SELECT * FROM maintenance_categories WHERE id = $1 AND active`, [d.category_id]))[0];
    if (!cat) throw badRequest("Pick a category from the list");
    if (cat.photo_required && d.photo_ids.length < 1) throw badRequest("Add at least 1 photo of the problem");
    const office = await resolveAdminOffice(actor.userId);
    if (!office) throw badRequest("No maintenance route is set up for your Division yet. Ask an administrator to add a Maintenance Request workflow in Workflow Builder.");
    // Check the photos before anything is saved, so a bad one never leaves a half-made request.
    if (d.photo_ids.length) {
      const usable = (await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM maintenance_photos WHERE id = ANY($1::uuid[]) AND uploaded_by_id = $2 AND request_id IS NULL AND deleted_at IS NULL`,
        [d.photo_ids, actor.userId]
      ))[0].n;
      if (usable !== new Set(d.photo_ids).size) throw badRequest("A photo is missing or was already used - upload it again");
    }

    const requestNo = await nextRequestNo();
    const r = (await query<any>(
      `INSERT INTO maintenance_requests (request_no, requester_id, site_id, site_name, district, location, contact_name, contact_phone,
              category_id, category, priority, asset_tag, description, access_times, admin_office)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [requestNo, actor.userId, site.id, site.name, site.district, d.location, d.contact_name, d.contact_phone,
       cat.id, cat.name, d.priority, d.asset_tag || null, d.description, d.access_times || null, JSON.stringify(office)]
    ))[0];
    const eventId = await recordEvent(r.id, actor.userId, "SUBMITTED", null, "SUBMITTED", `Submitted with ${d.photo_ids.length} photo${d.photo_ids.length === 1 ? "" : "s"}`);
    await attachPhotos(d.photo_ids, r.id, eventId, "REQUEST", actor);
    res.status(201).json({ id: r.id, request_no: r.request_no });

    // FR-02: confirm the number to the requester; FR-03: to the Admin Office.
    const me = (await query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [actor.userId]))[0];
    if (me?.email) void notifyMaintenanceEvent({
      requestNo, emails: [me.email], subject: "We received your maintenance request", heading: "Received",
      lines: [`Your request number is ${requestNo}.`, `${site.name} · ${d.location} · ${cat.name}`, ``, `The Admin Office reviews it before anyone is assigned. You'll hear from us at every step.`]
    });
    void notifyEvent(r, actor, { office: true }, "New maintenance request", "New request", [`From ${actor.fullName || "a staff member"}:`, d.description]);
  } catch (err) { return next(err); }
});

maintenanceRouter.get("/requests/:id", async (req: AuthedRequest, res, next) => {
  try {
    const actor = actorOf(req);
    const r = await loadRequest(req.params.id);
    if (!r) throw notFound();
    const c = await contextFor(r, actor, await getUserGroups(actor.userId));
    if (!c.canView) throw forbidden("You can't see this request");
    const [photos, events, target] = await Promise.all([
      query<any>(
        `SELECT p.id, p.stage, p.event_id, p.original_name, p.content_type, p.created_at, u.full_name AS uploaded_by, (p.deleted_at IS NOT NULL) AS deleted, p.delete_reason
           FROM maintenance_photos p JOIN users u ON u.id = p.uploaded_by_id WHERE p.request_id = $1 ORDER BY p.created_at`,
        [r.id]
      ),
      query<any>(
        `SELECT e.id, e.kind, e.from_status, e.to_status, e.body, e.created_at, u.full_name AS actor_name
           FROM maintenance_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.request_id = $1 ORDER BY e.created_at DESC`,
        [r.id]
      ),
      query<any>(`SELECT respond_hours::float AS respond_hours, fix_working_days FROM maintenance_priority_targets WHERE priority = $1`, [r.priority])
    ]);
    const office = r.admin_office as any;
    const officeNames = office?.approver_ids?.length ? (await query<{ full_name: string }>(`SELECT full_name FROM users WHERE id = ANY($1::uuid[])`, [office.approver_ids])).map((u) => u.full_name) : [];
    const { site_staff_groups: _g, requester_email: _e, ...rest } = r;
    return res.json({
      ...rest,
      status_label: STATUS_LABELS[r.status], priority_label: PRIORITY_LABELS[r.priority],
      admin_office_label: [office?.group, ...officeNames].filter(Boolean).join(", ") || "Admin Office",
      photos, events: events.map((e) => ({ ...e, photo_ids: photos.filter((p) => p.event_id === e.id).map((p) => p.id) })),
      target: target[0] ?? null,
      my: { is_requester: c.isRequester, is_office: c.isOffice, is_worker: c.isWorker, is_site_staff: c.isSiteStaff, is_admin: actor.role === "ADMIN" },
      can: permissions(r, c), next_step: nextStepFor(r, c)
    });
  } catch (err) { return next(err); }
});

const ActionSchema = z.object({
  action: z.enum(["review", "request_info", "assign", "request_approval", "verify", "send_back", "cancel", "accept", "decline", "set_status",
    "complete", "approve", "reject_approval", "provide_info", "request_update", "confirm", "reopen", "comment"]),
  body: z.string().trim().max(4000).optional().default(""),
  photo_ids: z.array(z.string().uuid()).max(5).default([]),
  worker_id: z.string().uuid().optional(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(["IN_PROGRESS", "WAITING_MATERIALS", "AWAITING_CONTRACTOR"]).optional(),
  estimate: z.number().min(0).optional(),
  work_done: z.string().trim().max(4000).optional(),
  parts_used: z.string().trim().max(1000).optional(),
  time_spent_hours: z.number().min(0).max(1000).optional(),
  cost: z.number().min(0).optional()
});

maintenanceRouter.post("/requests/:id/actions", async (req: AuthedRequest, res, next) => {
  try {
    const actor = actorOf(req);
    const p = ActionSchema.safeParse(req.body);
    if (!p.success) throw badRequest("Invalid action", p.error.flatten());
    const a = p.data;
    const r = await loadRequest(req.params.id);
    if (!r) throw notFound();
    const c = await contextFor(r, actor, await getUserGroups(actor.userId));
    if (!c.canView) throw forbidden();
    const can = permissions(r, c) as Record<string, boolean>;
    if (!can[a.action]) throw forbidden(`You can't do that while it's ${STATUS_LABELS[r.status] || r.status}`);
    const need = (cond: boolean, msg: string) => { if (!cond) throw badRequest(msg); };
    const from = r.status;

    // Moves the status only if nobody else moved it first.
    const move = async (to: string, setSql = "", params: unknown[] = []) => {
      const row = (await query<any>(
        `UPDATE maintenance_requests SET status = $3, updated_at = now()${setSql ? ", " + setSql : ""} WHERE id = $1 AND status = $2 RETURNING id`,
        [r.id, from, to, ...params]
      ))[0];
      if (!row) throw badRequest("This request changed while you were looking at it - reload and try again");
    };
    const log = (kind: string, to: string | null, body?: string | null) => recordEvent(r.id, actor.userId, kind, from, to, body ?? (a.body || null));
    const fresh = async () => (await loadRequest(r.id))!;
    const who = actor.fullName || "Someone";

    switch (a.action) {
      case "review": {
        await move("REVIEWED", a.priority ? "priority = $4" : "", a.priority ? [a.priority] : []);
        await log("REVIEWED", "REVIEWED", a.priority && a.priority !== r.priority ? `Priority set to ${PRIORITY_LABELS[a.priority]}` : null);
        void notifyEvent(await fresh(), actor, { requester: true }, "Your request was reviewed", "Reviewed", ["The Admin Office reviewed it and will assign someone."]);
        break;
      }
      case "request_info": {
        need(a.body.length >= 3, "Write your question for the requester");
        await move("PENDING_INFORMATION");
        await log("INFO_REQUESTED", "PENDING_INFORMATION");
        void notifyEvent(await fresh(), actor, { requester: true }, "More information needed", "Question from the Admin Office", [a.body]);
        break;
      }
      case "provide_info": {
        need(a.body.length >= 2 || a.photo_ids.length > 0, "Write your answer or add a photo");
        await move("SUBMITTED");
        const ev = await log("INFO_PROVIDED", "SUBMITTED");
        await attachPhotos(a.photo_ids, r.id, ev, "UPDATE", actor);
        void notifyEvent(await fresh(), actor, { office: true }, "Requester answered your question", "Information provided", [a.body]);
        break;
      }
      case "assign": {
        need(!!a.worker_id, "Pick a worker");
        const worker = (await assignableWorkers()).find((w: any) => w.id === a.worker_id);
        need(!!worker, "Pick a worker from the list");
        const priority = a.priority ?? r.priority;
        let target = a.target_date ?? null;
        if (!target) {
          const t = (await query<{ fix_working_days: number }>(`SELECT fix_working_days FROM maintenance_priority_targets WHERE priority = $1`, [priority]))[0];
          target = await addWorkingDays(await dbToday(), t?.fix_working_days ?? 7);
        }
        const previousWorker = r.worker_id && r.worker_id !== a.worker_id ? r : null;
        await move("ASSIGNED", "worker_id = $4, target_date = $5, instructions = $6, priority = $7, assigned_at = now(), accepted_at = NULL", [a.worker_id, target, a.body || null, priority]);
        const name = await workerName(a.worker_id!);
        await log("ASSIGNED", "ASSIGNED", `Assigned to ${name} · target ${target}${a.body ? ` · instructions: ${a.body}` : ""}`);
        const now = await fresh();
        void notifyEvent(now, actor, { worker: true }, "New job assigned to you", "Assigned", [`Target date: ${target}`, a.body ? `Instructions: ${a.body}` : "", `Accept or decline it in FlowDesk.`].filter(Boolean));
        void notifyEvent(now, actor, { requester: true }, "Your request was assigned", "Assigned", [`Assigned to ${name}, target ${target}.`]);
        if (previousWorker) void notifyEvent(previousWorker, actor, { worker: true }, "Job reassigned", "Reassigned", [`This job was reassigned to ${name}.`]);
        break;
      }
      case "accept": {
        await move("ACCEPTED", "accepted_at = now()");
        await log("ACCEPTED", "ACCEPTED");
        void notifyEvent(await fresh(), actor, { requester: true }, "Work accepted", "Accepted", [`${r.worker_name || who} accepted the job.${a.body ? ` "${a.body}"` : ""}`]);
        break;
      }
      case "decline": {
        need(a.body.length >= 3, "Say why you're declining");
        await move("REVIEWED", "worker_id = NULL, accepted_at = NULL, assigned_at = NULL");
        await log("DECLINED", "REVIEWED", `${r.worker_name || who} declined: ${a.body}`);
        void notifyEvent(await fresh(), actor, { office: true }, "Job declined - reassign it", "Declined", [`${r.worker_name || who} declined: ${a.body}`]);
        break;
      }
      case "set_status": {
        need(!!a.status, "Pick the work status");
        need(a.status !== from, "It's already in that status");
        await move(a.status!, "update_requested_at = NULL, update_requested_by = NULL");
        const ev = await log("STATUS", a.status!);
        await attachPhotos(a.photo_ids, r.id, ev, "UPDATE", actor);
        void notifyEvent(await fresh(), actor, { requester: true, office: !!r.update_requested_at }, `Now ${STATUS_LABELS[a.status!]}`, STATUS_LABELS[a.status!], [a.body || `${r.worker_name || who} set it to ${STATUS_LABELS[a.status!]}.`]);
        break;
      }
      case "request_approval": {
        need(a.body.length >= 3, "Say what needs approving (replacement, contractor or spend)");
        const chain = await resolveApprovalChain(r.requester_id);
        need(chain.length > 0, "The Maintenance Request workflow has no approval steps after the Admin Office. Ask an administrator to add them in Workflow Builder.");
        await move("AWAITING_APPROVAL", "status_before_approval = $4, approval_chain = $5, approval_step = 0, approval_status = 'PENDING', approval_estimate = $6, approval_reason = $7",
          [from, JSON.stringify(chain), a.estimate ?? null, a.body]);
        const ev = await log("APPROVAL_REQUESTED", "AWAITING_APPROVAL", `${a.body}${a.estimate !== undefined ? ` · estimate M ${a.estimate.toFixed(2)}` : ""}`);
        await attachPhotos(a.photo_ids, r.id, ev, "UPDATE", actor);
        const now = await fresh();
        void notifyEvent(now, actor, { approver: true }, "Maintenance spend needs your approval", "Approval needed", [a.body, a.estimate !== undefined ? `Estimate: M ${a.estimate.toFixed(2)}` : ""].filter(Boolean));
        void notifyEvent(now, actor, { requester: true, worker: true, office: true }, "Waiting for approval", "Awaiting approval", [`Work waits for approval: ${a.body}`]);
        break;
      }
      case "approve":
      case "reject_approval": {
        const chain = [...(r.approval_chain || [])];
        const stepIdx = r.approval_step ?? 0;
        const approving = a.action === "approve";
        if (!approving) need(a.body.length >= 3, "Give a reason for rejecting");
        chain[stepIdx] = { ...chain[stepIdx], approved: approving, status: approving ? "APPROVED" : "REJECTED", acted_by: actor.userId, acted_by_name: actor.fullName ?? null, comment: a.body || null };
        await query(`UPDATE maintenance_requests SET approval_chain = jsonb_set($2::jsonb, ARRAY[$3::text, 'approved_at'], to_jsonb(now()::text)) WHERE id = $1`,
          [r.id, JSON.stringify(chain), String(stepIdx)]);
        const last = stepIdx >= chain.length - 1;
        if (approving && !last) {
          const row = (await query<any>(`UPDATE maintenance_requests SET approval_step = $2, updated_at = now() WHERE id = $1 AND status = 'AWAITING_APPROVAL' AND approval_step = $3 RETURNING id`, [r.id, stepIdx + 1, stepIdx]))[0];
          need(!!row, "This request changed while you were looking at it - reload and try again");
          await log("APPROVED_STEP", "AWAITING_APPROVAL", `${chain[stepIdx].position_name}: approved${a.body ? ` - ${a.body}` : ""}`);
          void notifyEvent(await fresh(), actor, { approver: true }, "Maintenance spend needs your approval", "Approval needed", [r.approval_reason || "", r.approval_estimate ? `Estimate: M ${Number(r.approval_estimate).toFixed(2)}` : ""].filter(Boolean));
        } else {
          const back = r.status_before_approval || "REVIEWED";
          await move(back, "approval_status = $4", [approving ? "APPROVED" : "REJECTED"]);
          await log(approving ? "APPROVED" : "APPROVAL_REJECTED", back, approving ? `Approved${a.body ? ` - ${a.body}` : ""}` : `Rejected: ${a.body}`);
          void notifyEvent(await fresh(), actor, { office: true, worker: true, requester: true }, approving ? "Spend approved - work can go on" : "Spend rejected", approving ? "Approved" : "Rejected",
            [approving ? `Approved by ${who}.` : `Rejected by ${who}: ${a.body}`, approving ? "" : "The Admin Office decides how to go on."].filter(Boolean));
        }
        break;
      }
      case "complete": {
        need((a.work_done || "").length >= 3, "Describe the work done");
        need(a.photo_ids.length >= 1, "Add at least 1 completion photo");
        await move("COMPLETED_PENDING_VERIFICATION", "work_done = $4, parts_used = $5, time_spent_hours = $6, cost = $7, completed_at = now(), update_requested_at = NULL, update_requested_by = NULL",
          [a.work_done, a.parts_used || null, a.time_spent_hours ?? null, a.cost ?? null]);
        const ev = await log("COMPLETED", "COMPLETED_PENDING_VERIFICATION", a.work_done);
        await attachPhotos(a.photo_ids, r.id, ev, "COMPLETION", actor);
        const now = await fresh();
        void notifyEvent(now, actor, { office: true }, "Work completed - please verify", "Completed", [a.work_done!]);
        void notifyEvent(now, actor, { requester: true }, "Work completed", "Completed", [`${r.worker_name || who} finished the work. The Admin Office checks it, then you're asked to confirm.`]);
        break;
      }
      case "verify": {
        await move("PENDING_CONFIRMATION", "verified_at = now(), verified_by = $4", [actor.userId]);
        await log("VERIFIED", "PENDING_CONFIRMATION");
        const days = (await query<{ value: string }>(`SELECT value FROM maintenance_settings WHERE key = 'auto_close_working_days'`))[0]?.value || "3";
        void notifyEvent(await fresh(), actor, { requester: true, worker: true }, "Is it fixed? Please confirm", "Please confirm",
          [`The work was checked by the Admin Office. Confirm it's fixed, or reopen it if it isn't. It closes by itself after ${days} working days.`]);
        break;
      }
      case "send_back": {
        need(a.body.length >= 3, "Say what still needs doing");
        await move("IN_PROGRESS", "completed_at = NULL");
        await log("SENT_BACK", "IN_PROGRESS");
        void notifyEvent(await fresh(), actor, { worker: true }, "Work sent back", "Sent back", [a.body]);
        break;
      }
      case "confirm": {
        await move("CLOSED", "closed_at = now(), close_reason = 'CONFIRMED'");
        await log("CONFIRMED", "CLOSED");
        void notifyEvent(await fresh(), actor, { worker: true, office: true }, "Confirmed fixed - closed", "Closed", [`${who} confirmed it's fixed.`]);
        break;
      }
      case "reopen": {
        need(a.body.length >= 3, "Say what is still wrong");
        const to = r.worker_id ? "REOPENED" : "REVIEWED";
        await move(to, "verified_at = NULL, completed_at = NULL, accepted_at = NULL");
        const ev = await log("REOPENED", to);
        await attachPhotos(a.photo_ids, r.id, ev, "UPDATE", actor);
        void notifyEvent(await fresh(), actor, { worker: true, office: true }, "Reopened - not fixed", "Reopened", [`${who}: ${a.body}`]);
        break;
      }
      case "cancel": {
        need(a.body.length >= 3, "Give a reason for cancelling");
        await move("CANCELLED", "cancelled_at = now(), cancel_reason = $4", [a.body]);
        await log("CANCELLED", "CANCELLED");
        void notifyEvent(await fresh(), actor, { requester: true, worker: true, office: c.isRequester }, "Request cancelled", "Cancelled", [`${who}: ${a.body}`]);
        break;
      }
      case "request_update": {
        const row = (await query<any>(`UPDATE maintenance_requests SET update_requested_at = now(), update_requested_by = $2, updated_at = now() WHERE id = $1 AND update_requested_at IS NULL RETURNING id`, [r.id, actor.userId]))[0];
        need(!!row, "An update was already requested");
        await log("UPDATE_REQUESTED", null);
        void notifyEvent(await fresh(), actor, { worker: true, office: true }, "The user asked for an update", "Update requested", [a.body || `${who} asked how it's going.`]);
        break;
      }
      case "comment": {
        need(a.body.length >= 1 || a.photo_ids.length > 0, "Write something or add a photo");
        // A reply from the worker or Admin Office answers an update request.
        const answers = (c.isWorker || c.isOffice) && !!r.update_requested_at;
        if (answers) await query(`UPDATE maintenance_requests SET update_requested_at = NULL, update_requested_by = NULL, updated_at = now() WHERE id = $1`, [r.id]);
        else await query(`UPDATE maintenance_requests SET updated_at = now() WHERE id = $1`, [r.id]);
        const ev = await log(c.isWorker ? "UPDATE" : "COMMENT", null);
        await attachPhotos(a.photo_ids, r.id, ev, "UPDATE", actor);
        const fromTeam = c.isWorker || c.isOffice;
        void notifyEvent(await fresh(), actor, { requester: fromTeam, worker: !c.isWorker, office: !fromTeam || answers },
          c.isWorker ? "Progress update" : "New comment", c.isWorker ? "Update" : "Comment", [`${who}: ${a.body || "(photo)"}`, a.photo_ids.length ? `${a.photo_ids.length} photo(s) added` : ""].filter(Boolean));
        break;
      }
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});
