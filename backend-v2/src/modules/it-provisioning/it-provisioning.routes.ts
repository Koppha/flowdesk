import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { setStringSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { applyOldDeviceDisposition, getDefaultAssigneeIds, getProvisioningPoolSetting, getTaskRequester, isInProvisioningPool } from "./it-provisioning.service.js";
import { notifyItProvisioningOfficers, notifyItProvisioningRequester } from "../../lib/notifications.js";

export const itProvisioningRouter = Router();
itProvisioningRouter.use(requireAuth);

// Anyone the IT Manager put in the provisioning pool gets in automatically -
// requests go to them, so they must be able to open them.
async function canAccessItProvisioning(req: AuthedRequest) {
  if (await hasFeatureAccess(req.user!.userId, req.user!.role, "it_provisioning", ["ADMIN"])) return true;
  return isInProvisioningPool(req.user!.userId);
}

// Every route below requires module access (ADMIN or an admin-granted role/group).
itProvisioningRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    if (!(await canAccessItProvisioning(req))) throw forbidden("You do not have access to IT Provisioning");
    next();
  } catch (err) {
    next(err);
  }
});

const TASK_SELECT = `
  SELECT t.id, t.status, t.assigned_to_id, ito.full_name AS assigned_to_name,
         t.device_source, t.device_id, t.checklist, t.software,
         t.replacement_details, t.upgrade_details, t.handover,
         t.provisioned_by_id, pb.full_name AS provisioned_by_name, t.provisioned_at,
         t.ready_for_collection_at, t.handed_over_at, t.completed_at,
         t.collection_acknowledged_at, ack.full_name AS collection_acknowledged_by_name,
         t.created_at, t.updated_at,
         s.id AS submission_id, s.data, s.approval_chain, s.status AS submission_status, s.created_at AS submitted_at,
         u.id AS requester_id, u.full_name AS requester_name, u.email AS requester_email,
         u.department AS requester_department, u.employee_no AS requester_employee_no,
         d.asset_number, d.serial_number, d.manufacturer, d.model, d.operating_system,
         d.hostname, d.network_details, d.warranty_expiry, d.computer_type AS device_computer_type
    FROM it_provisioning_tasks t
    JOIN custom_request_submissions s ON s.id = t.submission_id
    JOIN users u ON u.id = s.requester_id
    LEFT JOIN users ito ON ito.id = t.assigned_to_id
    LEFT JOIN users pb ON pb.id = t.provisioned_by_id
    LEFT JOIN users ack ON ack.id = t.collection_acknowledged_by_id
    LEFT JOIN it_devices d ON d.id = t.device_id
`;

function shapeTaskRow(r: any) {
  return {
    id: r.id,
    status: r.status,
    assigned_to_id: r.assigned_to_id,
    assigned_to_name: r.assigned_to_name,
    device_source: r.device_source,
    checklist: r.checklist || [],
    software: r.software || [],
    replacement_details: r.replacement_details || null,
    upgrade_details: r.upgrade_details || null,
    handover: r.handover || null,
    provisioned_by_id: r.provisioned_by_id,
    provisioned_by_name: r.provisioned_by_name,
    provisioned_at: r.provisioned_at,
    ready_for_collection_at: r.ready_for_collection_at,
    handed_over_at: r.handed_over_at,
    completed_at: r.completed_at,
    collection_acknowledged_at: r.collection_acknowledged_at,
    collection_acknowledged_by_name: r.collection_acknowledged_by_name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    submission_id: r.submission_id,
    submission_status: r.submission_status,
    submitted_at: r.submitted_at,
    approval_chain: r.approval_chain || [],
    requester_id: r.requester_id,
    requester_name: r.requester_name,
    requester_email: r.requester_email,
    requester_department: r.requester_department,
    requester_employee_no: r.requester_employee_no,
    position: r.data?.position ?? null,
    phone_no: r.data?.phone_no ?? null,
    computer_type: r.data?.computer_type ?? null,
    request_type: r.data?.request_type ?? null,
    justification: r.data?.justification ?? null,
    device: r.asset_number ? {
      asset_number: r.asset_number,
      serial_number: r.serial_number,
      manufacturer: r.manufacturer,
      model: r.model,
      operating_system: r.operating_system,
      hostname: r.hostname,
      network_details: r.network_details,
      warranty_expiry: r.warranty_expiry,
      computer_type: r.device_computer_type
    } : null
  };
}

// Lightweight, always-200 check the frontend uses to decide whether to show
// the IT Provisioning nav item (and its dashboard counts) at all.
itProvisioningRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessItProvisioning(req);
    if (!allowed) return res.json({ allowed });
    const counts = (await query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM it_provisioning_tasks GROUP BY status`
    ));
    const byStatus: Record<string, number> = {};
    for (const row of counts) byStatus[row.status] = Number(row.count);
    return res.json({
      allowed,
      awaitingProvisioning: byStatus.AWAITING_PROVISIONING || 0,
      inProgress: byStatus.IN_PROGRESS || 0,
      readyForCollection: (byStatus.READY_FOR_COLLECTION || 0) + (byStatus.HANDED_OVER || 0),
      completed: byStatus.COMPLETED || 0
    });
  } catch (err) {
    return next(err);
  }
});

// GET /it-provisioning — the dashboard/queue list, filterable.
itProvisioningRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const filters: string[] = [];
    const params: unknown[] = [];

    const status = String(req.query.status || "").trim();
    if (status) { params.push(status); filters.push(`t.status = $${params.length}`); }

    const computerType = String(req.query.computer_type || "").trim();
    if (computerType) { params.push(computerType); filters.push(`upper(s.data->>'computer_type') = upper($${params.length})`); }

    const requestType = String(req.query.request_type || "").trim();
    if (requestType) { params.push(requestType); filters.push(`upper(s.data->>'request_type') = upper($${params.length})`); }

    const department = String(req.query.department || "").trim();
    if (department) { params.push(department); filters.push(`lower(trim(u.department)) = lower(trim($${params.length}))`); }

    const assignedTo = String(req.query.assigned_to || "").trim();
    if (assignedTo) { params.push(assignedTo); filters.push(`t.assigned_to_id = $${params.length}`); }

    const dateFrom = String(req.query.date_from || "").trim();
    if (dateFrom) { params.push(dateFrom); filters.push(`t.created_at >= $${params.length}`); }

    const dateTo = String(req.query.date_to || "").trim();
    if (dateTo) { params.push(dateTo); filters.push(`t.created_at <= $${params.length}::date + interval '1 day'`); }

    const search = String(req.query.search || "").trim();
    if (search) {
      params.push(`%${search}%`);
      filters.push(`(u.full_name ILIKE $${params.length} OR u.employee_no ILIKE $${params.length} OR u.department ILIKE $${params.length})`);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await query<any>(`${TASK_SELECT} ${where} ORDER BY t.created_at DESC`, params);
    return res.json({ items: rows.map(shapeTaskRow) });
  } catch (err) {
    return next(err);
  }
});

itProvisioningRouter.get("/devices", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT d.*, u.full_name AS assigned_user_name, u.department AS assigned_user_department,
              t.submission_id AS provisioned_submission_id, t.status AS provisioning_status
         FROM it_devices d
         LEFT JOIN users u ON u.id = d.assigned_user_id
         LEFT JOIN LATERAL (
           SELECT submission_id, status FROM it_provisioning_tasks WHERE device_id = d.id ORDER BY created_at DESC LIMIT 1
         ) t ON true
        ORDER BY d.created_at DESC`
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

// ── Inventory ──────────────────────────────────────────────────────────────
const DEVICE_STATUSES = ["IN_STOCK", "ASSIGNED", "IN_REPAIR", "DISPOSED"] as const;

const InventoryDeviceSchema = z.object({
  asset_number: z.string().trim().min(1, "Asset number is required"),
  serial_number: z.string().trim().nullish(),
  manufacturer: z.string().trim().nullish(),
  model: z.string().trim().nullish(),
  computer_type: z.enum(["LAPTOP", "DESKTOP"]).nullish(),
  operating_system: z.string().trim().nullish(),
  hostname: z.string().trim().nullish(),
  warranty_expiry: z.string().nullish(),
  location: z.string().trim().nullish(),
  notes: z.string().trim().nullish(),
  status: z.enum(DEVICE_STATUSES),
  assigned_user_id: z.string().uuid().nullish()
}).refine((d) => d.status !== "ASSIGNED" || Boolean(d.assigned_user_id), { message: "Choose who the device is assigned to", path: ["assigned_user_id"] });

function deviceParams(d: z.infer<typeof InventoryDeviceSchema>) {
  return [
    d.asset_number, d.serial_number || null, d.manufacturer || null, d.model || null, d.computer_type || null,
    d.operating_system || null, d.hostname || null, d.warranty_expiry || null, d.location || null, d.notes || null,
    d.status, d.status === "ASSIGNED" ? d.assigned_user_id : null
  ];
}

// POST /devices — add a device to the inventory (e.g. new stock).
itProvisioningRouter.post("/devices", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = InventoryDeviceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid device", parsed.error.flatten());
    const row = (await query<{ id: string }>(
      `INSERT INTO it_devices (asset_number, serial_number, manufacturer, model, computer_type, operating_system, hostname, warranty_expiry, location, notes, status, assigned_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      deviceParams(parsed.data)
    ))[0];
    return res.status(201).json({ id: row.id });
  } catch (err) {
    if ((err as any)?.code === "23505") return next(badRequest("Asset number is already in the inventory"));
    return next(err);
  }
});

itProvisioningRouter.put("/devices/:deviceId", async (req: AuthedRequest, res, next) => {
  try {
    // A device issued through a Computer Request is the record of that
    // request - it only changes through the process (the request itself, or
    // a later replacement's disposition), never by hand in the inventory.
    const linked = (await query<{ submission_id: string }>(
      `SELECT submission_id FROM it_provisioning_tasks WHERE device_id = $1 LIMIT 1`, [req.params.deviceId]
    ))[0];
    if (linked) throw badRequest("This device was issued through a Computer Request and can't be edited here");
    const parsed = InventoryDeviceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid device", parsed.error.flatten());
    const params = [...deviceParams(parsed.data), req.params.deviceId];
    const rows = await query(
      `UPDATE it_devices SET asset_number=$1, serial_number=$2, manufacturer=$3, model=$4, computer_type=$5, operating_system=$6,
              hostname=$7, warranty_expiry=$8, location=$9, notes=$10, status=$11, assigned_user_id=$12, updated_at=now()
        WHERE id=$13 RETURNING id`,
      params
    );
    if (!rows[0]) throw notFound("Device not found");
    return res.json({ ok: true });
  } catch (err) {
    if ((err as any)?.code === "23505") return next(badRequest("Asset number is already in the inventory"));
    return next(err);
  }
});

// ── Computer Request default approvers ──────────────────────────────────────
// The "pick from a role" steps of the Computer Request (IT Manager, IS HOD/CIO,
// CTO) are pre-filled with these people; a requester can still change them.
async function getComputerRequestType() {
  return (await query<{ id: string; fixed_approval_chain: any[] | null }>(
    `SELECT id, fixed_approval_chain FROM custom_request_types
      WHERE code = 'COMPUTER_REQUEST' AND jsonb_typeof(fixed_approval_chain) = 'array'
      ORDER BY created_at LIMIT 1`
  ))[0] ?? null;
}

function stepRoles(step: any): string[] {
  return (Array.isArray(step.roles) && step.roles.length ? step.roles : step.role ? [step.role] : []).map((r: string) => String(r).toUpperCase());
}

itProvisioningRouter.get("/approver-defaults", async (_req: AuthedRequest, res, next) => {
  try {
    const type = await getComputerRequestType();
    if (!type) return res.json({ steps: [] });
    const steps = [];
    for (const [index, step] of (type.fixed_approval_chain || []).entries()) {
      if (step.source !== "ROLE_PICKER") continue;
      const roles = stepRoles(step);
      const candidates = await query<{ id: string; full_name: string | null; title: string | null; role: string }>(
        `SELECT id, full_name, title, role::text AS role FROM users
          WHERE is_active = true AND ($1::text[] = '{}' OR upper(role::text) = ANY($1::text[]))
          ORDER BY full_name`,
        [roles]
      );
      steps.push({ index, title: step.title, roles, default_approver_id: step.default_approver_id ?? null, candidates });
    }
    return res.json({ steps });
  } catch (err) {
    return next(err);
  }
});

const ApproverDefaultsSchema = z.object({
  defaults: z.array(z.object({ index: z.number().int().min(0), approver_id: z.string().uuid().nullable() }))
});

itProvisioningRouter.put("/approver-defaults", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ApproverDefaultsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const type = await getComputerRequestType();
    if (!type) throw notFound("Computer Request type not found");
    const chain = [...(type.fixed_approval_chain || [])];
    for (const d of parsed.data.defaults) {
      const step = chain[d.index];
      if (!step || step.source !== "ROLE_PICKER") throw badRequest("Only role-picked steps can have a default approver");
      if (d.approver_id) {
        const user = (await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id = $1 AND is_active = true`, [d.approver_id]))[0];
        if (!user) throw badRequest(`The default for "${step.title}" is not an active user`);
        const roles = stepRoles(step);
        if (roles.length && !roles.includes(user.role.toUpperCase())) {
          throw badRequest(`The default for "${step.title}" must have the role ${roles.join(" or ")}`);
        }
      }
      chain[d.index] = { ...step, default_approver_id: d.approver_id };
    }
    await query(`UPDATE custom_request_types SET fixed_approval_chain = $1 WHERE id = $2`, [JSON.stringify(chain), type.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

itProvisioningRouter.get("/reports/summary", async (_req: AuthedRequest, res, next) => {
  try {
    const [byStatus, byDepartment, byComputerType, byRequestType] = await Promise.all([
      query<{ status: string; count: string }>(`SELECT status, count(*)::text AS count FROM it_provisioning_tasks GROUP BY status`),
      query<{ department: string | null; count: string }>(
        `SELECT u.department, count(*)::text AS count
           FROM it_provisioning_tasks t
           JOIN custom_request_submissions s ON s.id = t.submission_id
           JOIN users u ON u.id = s.requester_id
          GROUP BY u.department ORDER BY count(*) DESC`
      ),
      query<{ computer_type: string | null; count: string }>(
        `SELECT s.data->>'computer_type' AS computer_type, count(*)::text AS count
           FROM it_provisioning_tasks t JOIN custom_request_submissions s ON s.id = t.submission_id
          GROUP BY s.data->>'computer_type'`
      ),
      query<{ request_type: string | null; count: string }>(
        `SELECT s.data->>'request_type' AS request_type, count(*)::text AS count
           FROM it_provisioning_tasks t JOIN custom_request_submissions s ON s.id = t.submission_id
          GROUP BY s.data->>'request_type'`
      )
    ]);
    return res.json({
      byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
      byDepartment: byDepartment.map((r) => ({ department: r.department || "Unassigned", count: Number(r.count) })),
      byComputerType: byComputerType.map((r) => ({ computerType: r.computer_type || "Unknown", count: Number(r.count) })),
      byRequestType: byRequestType.map((r) => ({ requestType: r.request_type || "Unknown", count: Number(r.count) }))
    });
  } catch (err) {
    return next(err);
  }
});

itProvisioningRouter.get("/checklist-templates", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT * FROM it_checklist_templates ORDER BY computer_type, sort_order`);
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

const ChecklistTemplateSchema = z.object({
  computer_type: z.enum(["ALL", "LAPTOP", "DESKTOP"]),
  items: z.array(z.string().trim().min(1))
});

// Replaces the full template list for one computer_type scope.
itProvisioningRouter.put("/checklist-templates", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ChecklistTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`DELETE FROM it_checklist_templates WHERE computer_type = $1`, [parsed.data.computer_type]);
    for (let i = 0; i < parsed.data.items.length; i++) {
      await query(
        `INSERT INTO it_checklist_templates (computer_type, label, sort_order) VALUES ($1, $2, $3)`,
        [parsed.data.computer_type, parsed.data.items[i], i]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

itProvisioningRouter.get("/software-templates", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT * FROM it_software_templates ORDER BY computer_type, sort_order`);
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

const SoftwareTemplateSchema = z.object({
  computer_type: z.enum(["ALL", "LAPTOP", "DESKTOP"]),
  items: z.array(z.object({ name: z.string().trim().min(1), is_standard: z.boolean().optional().default(true) }))
});

itProvisioningRouter.put("/software-templates", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SoftwareTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`DELETE FROM it_software_templates WHERE computer_type = $1`, [parsed.data.computer_type]);
    for (let i = 0; i < parsed.data.items.length; i++) {
      const item = parsed.data.items[i];
      await query(
        `INSERT INTO it_software_templates (computer_type, name, is_standard, sort_order) VALUES ($1, $2, $3, $4)`,
        [parsed.data.computer_type, item.name, item.is_standard, i]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /it-provisioning/it-staff — active users on the "IT" team (Technical
// department > Billing & IS section > IT team), for the Assigned To /
// Default Assignees pickers. Scoped this narrowly rather than reusing
// /auth/users (a) because that endpoint lists every active employee
// company-wide, not just IT, and (b) because it requires
// user_management access, which an IT Officer who only has it_provisioning
// access wouldn't have - this route only needs the module's own access
// check (applied above via itProvisioningRouter.use), matching who's
// actually allowed to be on this page at all.
itProvisioningRouter.get("/it-staff", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<{ id: string; full_name: string | null }>(
      `SELECT u.id, u.full_name
         FROM users u
         JOIN teams t ON t.id = u.team_id
        WHERE t.name = 'IT' AND u.is_active = true
        ORDER BY u.full_name`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET/PUT /it-provisioning/default-assignees — the IT Manager's one-time
// setting for who provisions Computer Requests: whole teams and/or people.
// One person in the pool → every new request is assigned to them directly;
// more → new requests go to all of them, first to claim (POST /:id/claim)
// gets it. Empty → requests land unassigned, as before.
itProvisioningRouter.get("/default-assignees", async (_req: AuthedRequest, res, next) => {
  try {
    const pool = await getProvisioningPoolSetting();
    const memberIds = await getDefaultAssigneeIds();
    const [users, teams, members, allTeams] = await Promise.all([
      query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY full_name`, [pool.user_ids]),
      query<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id = ANY($1::uuid[]) ORDER BY name`, [pool.team_ids]),
      query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY full_name`, [memberIds]),
      query<{ id: string; name: string; members: number }>(
        `SELECT t.id, t.name, count(u.id)::int AS members
           FROM teams t LEFT JOIN users u ON u.team_id = t.id AND u.is_active = true
          GROUP BY t.id, t.name ORDER BY t.name`
      )
    ]);
    // `assignees` = everyone currently in the pool (kept for older clients).
    return res.json({ users, teams, assignees: members, team_options: allTeams });
  } catch (err) {
    return next(err);
  }
});

const DefaultAssigneesSchema = z.object({
  assigned_to_ids: z.array(z.string().uuid()),
  team_ids: z.array(z.string().uuid()).optional().default([])
});

itProvisioningRouter.put("/default-assignees", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = DefaultAssigneesSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    if (parsed.data.assigned_to_ids.length) {
      const active = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [parsed.data.assigned_to_ids]);
      if (active.length !== parsed.data.assigned_to_ids.length) throw badRequest("One or more selected users are not active accounts");
    }
    if (parsed.data.team_ids.length) {
      const teams = await query<{ id: string }>(`SELECT id FROM teams WHERE id = ANY($1::uuid[])`, [parsed.data.team_ids]);
      if (teams.length !== parsed.data.team_ids.length) throw badRequest("One or more selected teams no longer exist");
    }
    await setStringSystemSetting(
      SYSTEM_SETTING_KEYS.defaultItProvisioningAssigneeIds,
      JSON.stringify({ user_ids: parsed.data.assigned_to_ids, team_ids: parsed.data.team_ids })
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

async function getTaskOr404(id: string) {
  const rows = await query<any>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound("Provisioning task not found");
  return rows[0];
}

itProvisioningRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const row = await getTaskOr404(req.params.id);
    return res.json(shapeTaskRow(row));
  } catch (err) {
    return next(err);
  }
});

const AssignSchema = z.object({
  assigned_to_id: z.string().uuid().nullable().optional(),
  device_source: z.enum(["NEW_STOCK", "EXISTING_STOCK", "REPLACEMENT_DEVICE"]).optional()
});

itProvisioningRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const updates: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.assigned_to_id !== undefined) {
      params.push(parsed.data.assigned_to_id);
      updates.push(`assigned_to_id = $${params.length}`);
    }
    if (parsed.data.device_source !== undefined) {
      params.push(parsed.data.device_source);
      updates.push(`device_source = $${params.length}`);
    }
    // Assigning an IT Officer to an AWAITING_PROVISIONING task moves it into
    // motion - IN_PROGRESS is the working state until it's actually marked provisioned.
    if (task.status === "AWAITING_PROVISIONING" && parsed.data.assigned_to_id) {
      updates.push(`status = 'IN_PROGRESS'`);
    }
    if (!updates.length) return res.json({ ok: true });

    params.push(req.params.id);
    await query(`UPDATE it_provisioning_tasks SET ${updates.join(",")}, updated_at = now() WHERE id = $${params.length}`, params);
    if (parsed.data.assigned_to_id && parsed.data.assigned_to_id !== task.assigned_to_id) {
      await notifyOfficerAssigned(req.params.id, parsed.data.assigned_to_id, req.user!.userId);
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /:id/claim — "first to claim it gets it" for tasks left unassigned
// because more than one default assignee is preset. Restricted to ADMIN or
// whoever is currently in that preset pool (not just anyone with module
// access), and race-safe: the UPDATE only succeeds if assigned_to_id is
// still null, so if two people claim at once, only the first write wins -
// the loser gets a normal "already claimed" error rather than silently
// overwriting the winner.
itProvisioningRouter.post("/:id/claim", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (task.assigned_to_id) throw badRequest("This request has already been claimed");

    if (req.user!.role !== "ADMIN") {
      const pool = await getDefaultAssigneeIds();
      if (!pool.includes(req.user!.userId)) throw forbidden("Only a preset default assignee can claim this request");
    }

    const claimed = await query<{ id: string }>(
      `UPDATE it_provisioning_tasks
          SET assigned_to_id = $1, status = 'IN_PROGRESS', updated_at = now()
        WHERE id = $2 AND assigned_to_id IS NULL
        RETURNING id`,
      [req.user!.userId, req.params.id]
    );
    if (!claimed[0]) throw badRequest("This request has already been claimed by someone else");
    await notifyOfficerAssigned(req.params.id, req.user!.userId, req.user!.userId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// The officer hears about it unless they assigned it to themselves; the
// requester always learns who is preparing their computer.
async function notifyOfficerAssigned(taskId: string, officerId: string, actorId: string) {
  const officer = (await query<{ email: string | null; name: string | null }>(`SELECT email, full_name AS name FROM users WHERE id = $1`, [officerId]))[0];
  const requester = await getTaskRequester(taskId);
  if (officer && officerId !== actorId) {
    void notifyItProvisioningOfficers({ taskId, recipients: [officer], requesterName: requester?.full_name ?? null, event: "ASSIGNED" });
  }
  if (requester) {
    void notifyItProvisioningRequester({
      taskId, requesterEmail: requester.email, requesterName: requester.full_name, stage: "ASSIGNED", officerName: officer?.name ?? null
    });
  }
}

async function notifyReadyForCollection(taskId: string) {
  const task = await getTaskOr404(taskId);
  void notifyItProvisioningRequester({
    taskId, requesterEmail: task.requester_email, requesterName: task.requester_name,
    stage: "READY_FOR_COLLECTION", officerName: task.assigned_to_name, assetNumber: task.asset_number
  });
}

const DeviceSchema = z.object({
  asset_number: z.string().trim().min(1),
  serial_number: z.string().trim().nullish(),
  manufacturer: z.string().trim().nullish(),
  model: z.string().trim().nullish(),
  operating_system: z.string().trim().nullish(),
  hostname: z.string().trim().nullish(),
  network_details: z.string().trim().nullish(),
  warranty_expiry: z.string().nullish()
});

itProvisioningRouter.put("/:id/device", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (!["AWAITING_PROVISIONING", "IN_PROGRESS"].includes(task.status)) {
      throw badRequest("This computer has already been provisioned - its device details are locked");
    }
    const parsed = DeviceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const computerType = task.data?.computer_type ?? null;
    let deviceId: string = task.device_id;
    if (deviceId) {
      await query(
        `UPDATE it_devices SET asset_number=$1, serial_number=$2, manufacturer=$3, model=$4,
                operating_system=$5, hostname=$6, network_details=$7, warranty_expiry=$8, updated_at=now()
          WHERE id=$9`,
        [parsed.data.asset_number, parsed.data.serial_number ?? null, parsed.data.manufacturer ?? null, parsed.data.model ?? null,
         parsed.data.operating_system ?? null, parsed.data.hostname ?? null, parsed.data.network_details ?? null,
         parsed.data.warranty_expiry || null, deviceId]
      );
    } else {
      const inserted = (await query<{ id: string }>(
        `INSERT INTO it_devices (asset_number, serial_number, manufacturer, model, computer_type, operating_system, hostname, network_details, warranty_expiry, status, assigned_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ASSIGNED',$10) RETURNING id`,
        [parsed.data.asset_number, parsed.data.serial_number ?? null, parsed.data.manufacturer ?? null, parsed.data.model ?? null,
         computerType, parsed.data.operating_system ?? null, parsed.data.hostname ?? null, parsed.data.network_details ?? null,
         parsed.data.warranty_expiry || null, task.requester_id]
      ))[0];
      deviceId = inserted.id;
      await query(`UPDATE it_provisioning_tasks SET device_id=$1, updated_at=now() WHERE id=$2`, [deviceId, req.params.id]);
    }
    return res.json({ ok: true, device_id: deviceId });
  } catch (err) {
    if ((err as any)?.code === "23505") return next(badRequest("Asset number is already in use"));
    return next(err);
  }
});

const ChecklistUpdateSchema = z.object({
  checklist: z.array(z.object({ label: z.string(), checked: z.boolean() }))
});

itProvisioningRouter.put("/:id/checklist", async (req: AuthedRequest, res, next) => {
  try {
    await getTaskOr404(req.params.id);
    const parsed = ChecklistUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE it_provisioning_tasks SET checklist=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(parsed.data.checklist), req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const SoftwareUpdateSchema = z.object({
  software: z.array(z.object({ name: z.string(), status: z.enum(["INSTALLED", "PENDING"]), is_standard: z.boolean().optional().default(false) }))
});

itProvisioningRouter.put("/:id/software", async (req: AuthedRequest, res, next) => {
  try {
    await getTaskOr404(req.params.id);
    const parsed = SoftwareUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE it_provisioning_tasks SET software=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(parsed.data.software), req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const ReplacementDetailsSchema = z.object({
  previous_asset_number: z.string().trim().nullish(),
  reason: z.string().trim().nullish(),
  old_device_returned: z.boolean().optional().default(false),
  old_device_condition: z.string().trim().nullish(),
  old_device_disposition: z.enum(["Repair", "Store", "Dispose", "Transfer"]).nullish(),
  transfer_to_user_id: z.string().uuid().nullish()
});

itProvisioningRouter.put("/:id/replacement-details", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    const parsed = ReplacementDetailsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const details: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.old_device_disposition !== "Transfer") details.transfer_to_user_id = null;
    if (details.transfer_to_user_id) {
      details.transfer_to_name = (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [details.transfer_to_user_id]))[0]?.full_name ?? null;
    }
    await applyOldDeviceDisposition({
      previousAssetNumber: parsed.data.previous_asset_number,
      disposition: parsed.data.old_device_disposition,
      transferToUserId: parsed.data.transfer_to_user_id,
      computerType: task.data?.computer_type ?? null
    });
    await query(`UPDATE it_provisioning_tasks SET replacement_details=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(details), req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const UpgradeDetailsSchema = z.object({
  existing_asset_number: z.string().trim().nullish(),
  upgrade_ram: z.boolean().optional().default(false),
  upgrade_ssd: z.boolean().optional().default(false),
  upgrade_os: z.boolean().optional().default(false),
  upgrade_other: z.boolean().optional().default(false),
  current_specification: z.string().trim().nullish(),
  new_specification: z.string().trim().nullish()
});

itProvisioningRouter.put("/:id/upgrade-details", async (req: AuthedRequest, res, next) => {
  try {
    await getTaskOr404(req.params.id);
    const parsed = UpgradeDetailsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE it_provisioning_tasks SET upgrade_details=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(parsed.data), req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /:id/mark-provisioned — needs an assigned IT Officer and a captured
// device. The checklist is a record of what was done, not a gate: it no
// longer has to be complete first.
itProvisioningRouter.post("/:id/mark-provisioned", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (!["AWAITING_PROVISIONING", "IN_PROGRESS"].includes(task.status)) {
      throw badRequest("This request has already been provisioned");
    }
    if (!task.assigned_to_id) throw badRequest("Assign an IT Officer before marking as provisioned");
    if (!task.asset_number) throw badRequest("Capture the device's asset number and serial number before marking as provisioned");

    // Provisioned means ready: the requester is told to collect straight away.
    await query(
      `UPDATE it_provisioning_tasks
          SET status='READY_FOR_COLLECTION', provisioned_by_id=$1, provisioned_at=now(), ready_for_collection_at=now(), updated_at=now()
        WHERE id=$2`,
      [req.user!.userId, req.params.id]
    );
    if (task.asset_number) {
      await query(`UPDATE it_devices SET status='ASSIGNED', assigned_user_id=$1, updated_at=now() WHERE id=$2`, [task.requester_id, task.device_id]);
    }
    await notifyReadyForCollection(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

itProvisioningRouter.post("/:id/ready-for-collection", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (task.status !== "PROVISIONED") throw badRequest("Only a provisioned request can be marked ready for collection");
    await query(
      `UPDATE it_provisioning_tasks SET status='READY_FOR_COLLECTION', ready_for_collection_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id]
    );
    await notifyReadyForCollection(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const HandoverSchema = z.object({
  received_by_name: z.string().trim().min(1, "Received by is required"),
  handover_date: z.string().trim().min(1, "Date is required"),
  accessories: z.object({
    charger: z.boolean().optional().default(false),
    laptop_bag: z.boolean().optional().default(false),
    mouse: z.boolean().optional().default(false),
    docking_station: z.boolean().optional().default(false),
    other: z.string().trim().nullish()
  }).optional().default({}),
  comments: z.string().trim().nullish()
});

itProvisioningRouter.post("/:id/handover", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (!["PROVISIONED", "READY_FOR_COLLECTION"].includes(task.status)) {
      throw badRequest("This request isn't ready for handover yet");
    }
    const parsed = HandoverSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    // IT's record of the handover (accessories etc.). The task only
    // completes once the requester confirms collection themselves.
    await query(
      `UPDATE it_provisioning_tasks
          SET status='HANDED_OVER', handover=$1, handed_over_at=now(), updated_at=now()
        WHERE id=$2`,
      [JSON.stringify(parsed.data), req.params.id]
    );
    void notifyItProvisioningRequester({
      taskId: task.id, requesterEmail: task.requester_email, requesterName: task.requester_name,
      stage: "HANDED_OVER", assetNumber: task.asset_number
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
