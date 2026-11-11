import { query } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { logger, serializeError } from "../../lib/logger.js";
import { notifyMaintenanceEvent } from "../../lib/notifications.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { sendPushToUser } from "../../lib/push.js";
import { canApproveStep, resolveWorkflowChain, type ChainStep } from "../../lib/workflowEngine.js";

// Maintenance Requests (stores and Maseru offices). A request carries at
// least one photo, goes to the Admin Office first, then a worker accepts it,
// posts updates and completes it; the Admin Office verifies and the requester
// confirms or reopens. The Admin Office is the FIRST step of the requester's
// "Maintenance Request" workflow in Workflow Builder; any later steps are
// spend approvals, run only when a job needs approval (Awaiting Approval).
// Every timestamp comes from the database clock (PROD2's clock runs fast).

export const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted",
  PENDING_INFORMATION: "Pending Information",
  REVIEWED: "Reviewed",
  AWAITING_APPROVAL: "Awaiting Approval",
  ASSIGNED: "Assigned",
  ACCEPTED: "Accepted",
  IN_PROGRESS: "In Progress",
  WAITING_MATERIALS: "Waiting for Materials",
  AWAITING_CONTRACTOR: "Awaiting Contractor",
  COMPLETED_PENDING_VERIFICATION: "Completed – Pending Verification",
  PENDING_CONFIRMATION: "Pending Requestor Confirmation",
  REOPENED: "Reopened",
  CLOSED: "Closed",
  CANCELLED: "Cancelled"
};
export const OPEN_STATUSES = Object.keys(STATUS_LABELS).filter((s) => s !== "CLOSED" && s !== "CANCELLED");
// The worker is on the job: they can post work-status changes, updates, complete.
export const WORKING_STATUSES = ["ACCEPTED", "IN_PROGRESS", "WAITING_MATERIALS", "AWAITING_CONTRACTOR"];
export const PRIORITIES = ["EMERGENCY", "HIGH", "MEDIUM", "LOW"] as const;
export const PRIORITY_LABELS: Record<string, string> = { EMERGENCY: "Emergency", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

export type Actor = { userId: string; role: string; fullName?: string | null; sectionId?: string | null };
export type AdminOffice = { workflow_id: string; step_order: number; position_name: string; group: string | null; approver_ids: string[] };

// ── Schema ───────────────────────────────────────────────────────────────────
export async function ensureMaintenanceSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_sites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      district text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'STORE',
      staff_groups text[] NOT NULL DEFAULT '{}',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_maintenance_sites_name ON maintenance_sites (lower(name))`);
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      photo_required boolean NOT NULL DEFAULT true,
      active boolean NOT NULL DEFAULT true,
      sort_order int NOT NULL DEFAULT 0
    )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_maintenance_categories_name ON maintenance_categories (lower(name))`);
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_workers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      contractor_name text,
      contractor_company text,
      contractor_phone text,
      contractor_email text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_maintenance_workers_user ON maintenance_workers (user_id) WHERE user_id IS NOT NULL`);
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_priority_targets (
      priority text PRIMARY KEY,
      respond_hours numeric(8,2) NOT NULL,
      fix_working_days int NOT NULL
    )`);
  await query(`CREATE TABLE IF NOT EXISTS maintenance_settings (key text PRIMARY KEY, value text NOT NULL)`);
  await query(`CREATE TABLE IF NOT EXISTS maintenance_counters (year int PRIMARY KEY, last_no int NOT NULL)`);
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_no text NOT NULL UNIQUE,
      requester_id uuid NOT NULL REFERENCES users(id),
      site_id uuid REFERENCES maintenance_sites(id),
      site_name text NOT NULL,
      district text NOT NULL DEFAULT '',
      location text NOT NULL,
      contact_name text NOT NULL,
      contact_phone text NOT NULL,
      category_id uuid REFERENCES maintenance_categories(id),
      category text NOT NULL,
      priority text NOT NULL,
      asset_tag text,
      description text NOT NULL,
      access_times text,
      status text NOT NULL DEFAULT 'SUBMITTED',
      admin_office jsonb NOT NULL,
      update_requested_at timestamptz,
      update_requested_by uuid REFERENCES users(id),
      worker_id uuid REFERENCES maintenance_workers(id),
      target_date date,
      instructions text,
      assigned_at timestamptz,
      accepted_at timestamptz,
      status_before_approval text,
      approval_chain jsonb,
      approval_step int,
      approval_status text,
      approval_estimate numeric(14,2),
      approval_reason text,
      work_done text,
      parts_used text,
      time_spent_hours numeric(8,2),
      cost numeric(14,2),
      completed_at timestamptz,
      verified_at timestamptz,
      verified_by uuid REFERENCES users(id),
      closed_at timestamptz,
      close_reason text,
      cancelled_at timestamptz,
      cancel_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_requests_status ON maintenance_requests (status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_requests_requester ON maintenance_requests (requester_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_requests_worker ON maintenance_requests (worker_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_requests_site ON maintenance_requests (site_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
      actor_id uuid REFERENCES users(id),
      kind text NOT NULL,
      from_status text,
      to_status text,
      body text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_events_request ON maintenance_events (request_id, created_at)`);
  // A photo is uploaded on its own first (request_id NULL, so a weak
  // connection only ever retries one photo), then attached by the action
  // that uses it. Deleting is admin-only and soft, with the reason kept.
  await query(`
    CREATE TABLE IF NOT EXISTS maintenance_photos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid REFERENCES maintenance_requests(id) ON DELETE CASCADE,
      event_id uuid REFERENCES maintenance_events(id) ON DELETE SET NULL,
      stage text NOT NULL DEFAULT 'REQUEST',
      file_path text NOT NULL,
      original_name text,
      content_type text,
      size_bytes int,
      uploaded_by_id uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by_id uuid REFERENCES users(id),
      delete_reason text
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_maintenance_photos_request ON maintenance_photos (request_id)`);

  // Starting lists - the Admin Office edits them from FlowDesk afterwards.
  const cats = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM maintenance_categories`))[0];
  if (!cats?.n) {
    const names = ["Plumbing", "Electrical", "Equipment repair", "Equipment replacement", "Building", "General facility"];
    for (let i = 0; i < names.length; i++) {
      await query(`INSERT INTO maintenance_categories (name, sort_order) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [names[i], i]);
    }
  }
  for (const [p, respond, fix] of [["EMERGENCY", 2, 1], ["HIGH", 4, 3], ["MEDIUM", 24, 7], ["LOW", 72, 14]] as const) {
    await query(`INSERT INTO maintenance_priority_targets (priority, respond_hours, fix_working_days) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [p, respond, fix]);
  }
  await query(`INSERT INTO maintenance_settings (key, value) VALUES ('auto_close_working_days', '3') ON CONFLICT DO NOTHING`);
}

// ── Org and Admin Office ─────────────────────────────────────────────────────
export async function requesterOrg(userId: string) {
  return (await query<{ role: string; department: string | null; division: string | null; section: string | null; team: string | null }>(
    `SELECT u.role::text AS role, u.department, dv.name AS division, s.name AS section, t.name AS team
       FROM users u
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN sections s ON s.id = COALESCE(u.section_id, t.section_id)
      WHERE u.id = $1`,
    [userId]
  ))[0];
}

// The Admin Office step of a Maintenance Request workflow: the step whose
// Action Label is "Assigner" (ASSIGN); otherwise the first step that isn't
// the Employee / Request Initiator step (older workflows had no label).
export const ASSIGN_ACTION_TYPE = "ASSIGN";
// Steps labelled "Assignee": who jobs can be assigned to (not approvers).
export const ASSIGNEE_ACTION_TYPE = "ASSIGNEE";
const OFFICE_STEP_ORDER = `(coalesce(action_type, '') = '${ASSIGN_ACTION_TYPE}') DESC, (coalesce(position_type_code, '') = 'EMPLOYEE') ASC, step_order`;

async function maintenanceWorkflowFor(userId: string) {
  const org = await requesterOrg(userId);
  if (!org) return null;
  const resolved = await resolveWorkflowChain({
    requestType: "MAINTENANCE_REQUEST",
    department: org.department || "",
    division: org.division || "",
    section: org.section || "",
    team: org.team || "",
    requesterRole: org.role,
    requesterId: userId
  });
  if (!resolved) return null;
  const first = (await query<any>(
    `SELECT step_order, position_name, approval_mode, approval_group_name, assigned_user_id, assigned_user_ids
       FROM workflow_steps WHERE workflow_id = $1 AND coalesce(is_active, true) ORDER BY ${OFFICE_STEP_ORDER} LIMIT 1`,
    [resolved.workflowId]
  ))[0];
  return first ? { workflowId: resolved.workflowId, chain: resolved.chain, first } : null;
}

function adminOfficeFromStep(workflowId: string, step: any): AdminOffice {
  const ids: string[] = Array.isArray(step.assigned_user_ids) && step.assigned_user_ids.length
    ? step.assigned_user_ids
    : step.assigned_user_id ? [step.assigned_user_id] : [];
  return {
    workflow_id: workflowId,
    step_order: Number(step.step_order),
    position_name: step.position_name || "Admin Office",
    group: step.approval_group_name ? String(step.approval_group_name) : null,
    approver_ids: ids
  };
}

// Who receives a new request from this person: the Admin Office step of
// their Maintenance Request workflow. Null when no workflow covers them yet.
export async function resolveAdminOffice(userId: string): Promise<AdminOffice | null> {
  const wf = await maintenanceWorkflowFor(userId);
  if (!wf) return null;
  const office = adminOfficeFromStep(wf.workflowId, wf.first);
  if (!office.group && !office.approver_ids.length) return null;
  return office;
}

// Spend approval steps: every step after the Admin Office in the requester's
// (current) Maintenance Request workflow.
export async function resolveApprovalChain(requesterId: string): Promise<ChainStep[]> {
  const wf = await maintenanceWorkflowFor(requesterId);
  if (!wf) return [];
  return wf.chain.filter((s) => s.step_order > Number(wf.first.step_order) && s.action_type !== ASSIGNEE_ACTION_TYPE && s.action_type !== ASSIGN_ACTION_TYPE);
}

// Active users in any of these groups - roles, "Division: X", "Department: X",
// "Section: X", "Team: X" or a custom permission group (getUserGroups' names).
// Unlike resolveGroupMemberIds this keeps managers: a department's manager
// is part of its Admin Office.
export async function groupMembers(groups: string[]): Promise<Array<{ id: string; email: string | null; full_name: string | null }>> {
  if (!groups.length) return [];
  return query(
    `SELECT DISTINCT u.id, u.email, u.full_name
       FROM users u
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN sections s ON s.id = COALESCE(u.section_id, t.section_id)
      WHERE u.is_active AND (
            u.role::text = ANY($1::text[])
         OR ('Division: ' || dv.name) = ANY($1::text[])
         OR ('Department: ' || u.department) = ANY($1::text[])
         OR ('Section: ' || s.name) = ANY($1::text[])
         OR ('Team: ' || t.name) = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM user_permission_groups g WHERE g.user_id = u.id AND g.group_name = ANY($1::text[])))`,
    [groups]
  );
}

export async function adminOfficeMembers(office: AdminOffice) {
  const fromGroup = office.group ? await groupMembers([office.group]) : [];
  const named = office.approver_ids.length
    ? await query<{ id: string; email: string | null; full_name: string | null }>(`SELECT id, email, full_name FROM users WHERE id = ANY($1::uuid[]) AND is_active`, [office.approver_ids])
    : [];
  const byId = new Map([...fromGroup, ...named].map((u) => [u.id, u]));
  return [...byId.values()];
}

// Everyone on an "Assignee" step of an active Maintenance Request workflow
// (its group plus anyone named on it), added to maintenance_workers so they
// can be assigned. Null when no workflow has such a step - then the worker
// list is just what the Maintenance admin page holds, as before. A worker an
// admin switched off there stays off.
export async function syncAssigneeWorkers(): Promise<string[] | null> {
  const steps = await query<any>(
    `SELECT ws.step_order, ws.position_name, ws.approval_group_name, ws.assigned_user_id, ws.assigned_user_ids, w.id AS workflow_id
       FROM workflows w JOIN workflow_steps ws ON ws.workflow_id = w.id AND coalesce(ws.is_active, true)
      WHERE w.request_type::text = 'MAINTENANCE_REQUEST' AND w.status::text = 'ACTIVE' AND ws.action_type = $1`,
    [ASSIGNEE_ACTION_TYPE]
  );
  if (!steps.length) return null;
  const ids = new Set<string>();
  for (const s of steps) for (const m of await adminOfficeMembers(adminOfficeFromStep(s.workflow_id, s))) ids.add(m.id);
  if (ids.size) {
    await query(
      `INSERT INTO maintenance_workers (user_id, active) SELECT unnest($1::uuid[]), true
         ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO NOTHING`,
      [[...ids]]
    );
  }
  return [...ids];
}

export async function isInAdminOffice(office: AdminOffice | null | undefined, actor: Actor, groups?: string[]) {
  if (actor.role === "ADMIN") return true;
  if (!office) return false;
  if (office.approver_ids.includes(actor.userId)) return true;
  if (!office.group) return false;
  return (groups ?? (await getUserGroups(actor.userId))).includes(office.group);
}

// Runs the module (the lists, every request): ADMIN, or in the Admin Office
// step of any active Maintenance Request workflow. Once any of them labels a
// step "Assigner", only Assigner steps count - so an older workflow left
// active doesn't keep its people in the Admin Office.
export async function isAnyAdminOffice(actor: Actor, groups?: string[]) {
  if (actor.role === "ADMIN") return true;
  const steps = await query<any>(
    `SELECT DISTINCT ON (w.id) w.id AS workflow_id, ws.step_order, ws.position_name, ws.approval_group_name, ws.assigned_user_id, ws.assigned_user_ids, ws.action_type
       FROM workflows w JOIN workflow_steps ws ON ws.workflow_id = w.id AND coalesce(ws.is_active, true)
      WHERE w.request_type::text = 'MAINTENANCE_REQUEST' AND w.status::text = 'ACTIVE'
      ORDER BY w.id, ${OFFICE_STEP_ORDER.replace(/(action_type|position_type_code|step_order)/g, "ws.$1")}`
  );
  const labelled = steps.filter((s) => s.action_type === ASSIGN_ACTION_TYPE);
  const mine = groups ?? (await getUserGroups(actor.userId));
  for (const s of labelled.length ? labelled : steps) {
    if (await isInAdminOffice(adminOfficeFromStep(s.workflow_id, s), actor, mine)) return true;
  }
  return false;
}

export async function canApproveCurrentStep(request: any, actor: Actor) {
  if (request.status !== "AWAITING_APPROVAL" || !Array.isArray(request.approval_chain)) return false;
  const step = request.approval_chain[request.approval_step ?? 0];
  if (!step) return false;
  return canApproveStep(step, actor.userId, actor.role, null, actor.sectionId ?? null);
}

// ── Numbers, dates, history ──────────────────────────────────────────────────
export async function nextRequestNo(): Promise<string> {
  const row = (await query<{ year: number; last_no: number }>(
    `INSERT INTO maintenance_counters (year, last_no) VALUES (extract(year FROM now())::int, 1)
     ON CONFLICT (year) DO UPDATE SET last_no = maintenance_counters.last_no + 1
     RETURNING year, last_no`
  ))[0];
  return `MR-${row.year}-${String(row.last_no).padStart(4, "0")}`;
}

// Working days skip weekends and FlowDesk's public holidays (the same
// admin-managed list Overtime uses).
async function holidaySet(): Promise<Set<string>> {
  try {
    const rows = await query<{ d: string }>(
      `SELECT coalesce(observed_date, holiday_date)::text AS d FROM public_holidays WHERE active = true`
    );
    return new Set(rows.map((r) => r.d));
  } catch {
    return new Set();
  }
}
function isWorkingDay(d: Date, holidays: Set<string>) {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(d.toISOString().slice(0, 10));
}
export async function addWorkingDays(fromIso: string, days: number): Promise<string> {
  const holidays = await holidaySet();
  const d = new Date(fromIso.slice(0, 10) + "T00:00:00Z");
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d, holidays)) left--;
  }
  return d.toISOString().slice(0, 10);
}
export async function dbToday(): Promise<string> {
  return (await query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Africa/Maseru')::date::text AS d`))[0].d;
}

export async function recordEvent(requestId: string, actorId: string | null, kind: string, fromStatus: string | null, toStatus: string | null, body?: string | null) {
  return (await query<{ id: string }>(
    `INSERT INTO maintenance_events (request_id, actor_id, kind, from_status, to_status, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [requestId, actorId, kind, fromStatus, toStatus, body ?? null]
  ))[0].id;
}

// Attaches photos this person uploaded and hasn't used yet.
export async function attachPhotos(photoIds: string[], requestId: string, eventId: string | null, stage: string, actor: Actor) {
  if (!photoIds.length) return 0;
  if (photoIds.length > 5) throw badRequest("Up to 5 photos at a time");
  const rows = await query<{ id: string }>(
    `UPDATE maintenance_photos SET request_id = $1, event_id = $2, stage = $3
      WHERE id = ANY($4::uuid[]) AND uploaded_by_id = $5 AND request_id IS NULL AND deleted_at IS NULL
      RETURNING id`,
    [requestId, eventId, stage, photoIds, actor.userId]
  );
  if (rows.length !== photoIds.length) throw badRequest("A photo is missing or was already used - upload it again");
  return rows.length;
}

// ── Notifications ────────────────────────────────────────────────────────────
type Audience = { requester?: boolean; worker?: boolean; office?: boolean; approver?: boolean };

async function workerContact(workerId: string | null) {
  if (!workerId) return null;
  return (await query<{ user_id: string | null; email: string | null; name: string | null }>(
    `SELECT w.user_id, coalesce(u.email, w.contractor_email) AS email, coalesce(u.full_name, w.contractor_name) AS name
       FROM maintenance_workers w LEFT JOIN users u ON u.id = w.user_id WHERE w.id = $1`,
    [workerId]
  ))[0] ?? null;
}

export async function workerName(workerId: string | null) {
  return (await workerContact(workerId))?.name ?? null;
}

// Tells the people a change concerns - never the person who made it. Email to
// everyone named; the Admin Office only for what needs them (or anything on an
// Emergency), so their inbox isn't flooded with every worker update.
export async function notifyEvent(request: any, actor: Actor | null, audience: Audience, subject: string, heading: string, lines: string[]) {
  try {
    const people = new Map<string, { id: string | null; email: string | null }>();
    const add = (id: string | null, email: string | null) => {
      if (id && actor && id === actor.userId) return;
      const key = id || email || "";
      if (key && !people.has(key)) people.set(key, { id, email });
    };
    if (audience.requester) {
      const r = (await query<{ id: string; email: string | null }>(`SELECT id, email FROM users WHERE id = $1`, [request.requester_id]))[0];
      if (r) add(r.id, r.email);
    }
    if (audience.worker) {
      const w = await workerContact(request.worker_id);
      if (w) add(w.user_id, w.email);
    }
    if (audience.office || request.priority === "EMERGENCY") {
      for (const m of await adminOfficeMembers(request.admin_office)) add(m.id, m.email);
    }
    if (audience.approver && request.status === "AWAITING_APPROVAL") {
      const step = (request.approval_chain || [])[request.approval_step ?? 0];
      const ids: string[] = step?.approver_ids?.length ? step.approver_ids : step?.approver_id ? [step.approver_id] : [];
      const group = step?.approval_mode === "ANY_ONE" && step.approval_group_name ? await groupMembers([step.approval_group_name]) : [];
      const named = ids.length ? await query<{ id: string; email: string | null }>(`SELECT id, email FROM users WHERE id = ANY($1::uuid[])`, [ids]) : [];
      for (const u of [...named, ...group]) add(u.id, u.email);
    }
    const all = [...people.values()];
    const tag = request.priority === "EMERGENCY" ? "[EMERGENCY] " : "";
    await notifyMaintenanceEvent({
      requestNo: request.request_no,
      emails: [...new Set(all.map((p) => p.email).filter((e): e is string => !!e))],
      subject: `${tag}${subject}`,
      heading,
      lines: [`${request.request_no} · ${request.site_name} · ${request.location}`, `${request.category} · ${PRIORITY_LABELS[request.priority] || request.priority}`, ``, ...lines]
    });
    for (const p of all) {
      if (p.id) void sendPushToUser(p.id, { title: `${tag}${subject}`, body: `${request.request_no} · ${request.site_name}`, data: { type: "MAINTENANCE", id: request.id } });
    }
  } catch (err) {
    logger.warn("maintenance_notify_failed", { request_id: request?.id, error: serializeError(err) });
  }
}

// ── Auto-close (FR-08) ───────────────────────────────────────────────────────
// Pending Requestor Confirmation for N working days (setting, default 3)
// closes by itself. The status-guarded UPDATE is the claim, so both PROD
// servers running this never close (or email) the same request twice.
export async function runMaintenanceAutoClose() {
  try {
    const days = Number((await query<{ value: string }>(`SELECT value FROM maintenance_settings WHERE key = 'auto_close_working_days'`))[0]?.value || 3);
    const today = await dbToday();
    const rows = await query<any>(
      `SELECT id, (verified_at AT TIME ZONE 'Africa/Maseru')::date::text AS verified_day FROM maintenance_requests WHERE status = 'PENDING_CONFIRMATION' AND verified_at IS NOT NULL`
    );
    let closed = 0;
    for (const r of rows) {
      if ((await addWorkingDays(r.verified_day, days)) > today) continue;
      const done = (await query<any>(
        `UPDATE maintenance_requests SET status = 'CLOSED', closed_at = now(), close_reason = 'AUTO', updated_at = now()
          WHERE id = $1 AND status = 'PENDING_CONFIRMATION' RETURNING *`,
        [r.id]
      ))[0];
      if (!done) continue;
      closed++;
      await recordEvent(done.id, null, "AUTO_CLOSED", "PENDING_CONFIRMATION", "CLOSED", `Closed automatically after ${days} working days without a reply`);
      void notifyEvent(done, null, { requester: true, worker: true }, "Request closed", "Closed", [`It closed automatically after ${days} working days without confirmation.`]);
    }
    if (closed) logger.info("maintenance_auto_closed", { closed });
  } catch (err) {
    logger.warn("maintenance_auto_close_failed", { error: serializeError(err) });
  }
}
