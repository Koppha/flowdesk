import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

export const itProvisioningRouter = Router();
itProvisioningRouter.use(requireAuth);

async function canAccessItProvisioning(req: AuthedRequest) {
  return hasFeatureAccess(req.user!.userId, req.user!.role, "it_provisioning", ["ADMIN"]);
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
      readyForCollection: byStatus.READY_FOR_COLLECTION || 0,
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
      `SELECT d.*, u.full_name AS assigned_user_name, u.department AS assigned_user_department
         FROM it_devices d
         LEFT JOIN users u ON u.id = d.assigned_user_id
        ORDER BY d.created_at DESC`
    );
    return res.json({ items: rows });
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
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

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
  old_device_disposition: z.string().trim().nullish()
});

itProvisioningRouter.put("/:id/replacement-details", async (req: AuthedRequest, res, next) => {
  try {
    await getTaskOr404(req.params.id);
    const parsed = ReplacementDetailsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE it_provisioning_tasks SET replacement_details=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(parsed.data), req.params.id]);
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

// POST /:id/mark-provisioned — validated: needs an assigned IT Officer, a
// captured device (asset + serial number), and every checklist item ticked
// before this is allowed, matching the spec's "Provisioning Validation" gate.
itProvisioningRouter.post("/:id/mark-provisioned", async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTaskOr404(req.params.id);
    if (!["AWAITING_PROVISIONING", "IN_PROGRESS"].includes(task.status)) {
      throw badRequest("This request has already been provisioned");
    }
    if (!task.assigned_to_id) throw badRequest("Assign an IT Officer before marking as provisioned");
    if (!task.asset_number) throw badRequest("Capture the device's asset number and serial number before marking as provisioned");
    const checklist = (task.checklist || []) as Array<{ label: string; checked: boolean }>;
    const incomplete = checklist.filter((c) => !c.checked);
    if (incomplete.length) throw badRequest(`Complete the provisioning checklist first (${incomplete.length} item${incomplete.length === 1 ? "" : "s"} outstanding)`);

    await query(
      `UPDATE it_provisioning_tasks SET status='PROVISIONED', provisioned_by_id=$1, provisioned_at=now(), updated_at=now() WHERE id=$2`,
      [req.user!.userId, req.params.id]
    );
    if (task.asset_number) {
      await query(`UPDATE it_devices SET status='ASSIGNED', updated_at=now() WHERE id=$1`, [task.device_id]);
    }
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

    await query(
      `UPDATE it_provisioning_tasks
          SET status='COMPLETED', handover=$1, handed_over_at=now(), completed_at=now(), updated_at=now()
        WHERE id=$2`,
      [JSON.stringify(parsed.data), req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
