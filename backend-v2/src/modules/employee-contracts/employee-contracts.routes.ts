/**
 * Employee Contracts — fixed-term contracts for interns and temporary staff,
 * managed by HR from Salaries > Contracts.
 *
 * Expiry reminders go to HR - everyone an admin has granted this module to
 * (plus any extra addresses in its settings). HR can also switch on
 * reminding the employee, for all contracts or per contract; the employee
 * then gets their own separately worded email, never HR's. HR sets how many
 * days before the end date reminders go out (e.g. 30 and 7), globally or
 * per contract.
 *
 * Documents are stored in the database rather than on disk: PROD runs on two
 * nodes and every deploy is a fresh release directory, so a file written to
 * the local uploads folder would only exist on one node, for one release.
 */
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { type AuthedRequest, requireAuth, hasFeatureAccess } from "../../lib/auth.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { getStringSystemSetting, setStringSystemSetting } from "../../lib/systemSettings.js";
import { notifyEmployeeContractExpiring, notifyEmployeeOwnContractExpiring } from "../../lib/notifications.js";
import { resolveRequesterManager } from "../../lib/workflowEngine.js";

// Admin-only until an admin grants it (typically to HR) from Roles &
// Permissions ("Employee Contracts (Interns & Temps)").
export const EMPLOYEE_CONTRACTS_DEFAULT_ACCESS = ["ADMIN"];
const SETTINGS_KEY = "employee_contract_reminder_settings";
const DEFAULT_REMINDER_DAYS = [30, 7];

export async function ensureEmployeeContractsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS employee_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_no text UNIQUE NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      person_name text NOT NULL,
      person_email text,
      contract_type text NOT NULL CHECK (contract_type IN ('INTERN','TEMPORARY')),
      position text,
      department text,
      supervisor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RENEWED','ENDED','TERMINATED')),
      reminder_days int[],
      notes text,
      renewed_from_id uuid REFERENCES employee_contracts(id) ON DELETE SET NULL,
      closed_at timestamptz,
      closed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      close_reason text,
      created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (end_date >= start_date)
    )
  `);
  // NULL = follow the "remind the employee" setting; true/false = this
  // contract's own choice.
  await query(`ALTER TABLE employee_contracts ADD COLUMN IF NOT EXISTS notify_employee boolean`);
  await query(`ALTER TABLE employee_contracts ALTER COLUMN notify_employee DROP NOT NULL`);
  await query(`ALTER TABLE employee_contracts ALTER COLUMN notify_employee DROP DEFAULT`);
  await query(`CREATE INDEX IF NOT EXISTS idx_employee_contracts_end ON employee_contracts(status, end_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_employee_contracts_user ON employee_contracts(user_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS employee_contract_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES employee_contracts(id) ON DELETE CASCADE,
      file_name text NOT NULL,
      mime_type text,
      file_size int,
      content bytea NOT NULL,
      uploaded_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // People HR marked as not needing a contract, so they stop being suggested.
  await query(`
    CREATE TABLE IF NOT EXISTS employee_contract_dismissals (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      reason text,
      dismissed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      dismissed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // One row per (contract, end date, lead time): claimed before the email is
  // sent, so the two PROD nodes can't both send the same reminder. Keyed on
  // end_date so changing the end date re-arms the reminders.
  await query(`
    CREATE TABLE IF NOT EXISTS employee_contract_reminders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES employee_contracts(id) ON DELETE CASCADE,
      end_date date NOT NULL,
      days_before int NOT NULL,
      status text NOT NULL DEFAULT 'SENDING',
      recipients text[] NOT NULL DEFAULT '{}',
      employee_notified_to text,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (contract_id, end_date, days_before)
    )
  `);
}

// ── Access ──────────────────────────────────────────────────────────────
async function canUseContracts(req: AuthedRequest) {
  return hasFeatureAccess(req.user!.userId, req.user!.role, "employee_contracts", EMPLOYEE_CONTRACTS_DEFAULT_ACCESS);
}
async function requireAccess(req: AuthedRequest) {
  if (!(await canUseContracts(req))) throw forbidden("You don't have access to Contracts");
}

async function audit(actorId: string, action: string, entityId: string, before: unknown, after: unknown) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1,$2,'EMPLOYEE_CONTRACT',$3,$4,$5)`,
    [actorId, action, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  ).catch(() => {});
}

// ── Settings ────────────────────────────────────────────────────────────
type ReminderSettings = { reminder_days: number[]; remind_employee: boolean; extra_emails: string[] };

function cleanDays(days: number[]) {
  return Array.from(new Set(days.map((d) => Math.round(d)).filter((d) => d >= 1 && d <= 365))).sort((a, b) => b - a);
}

export async function getReminderSettings(): Promise<ReminderSettings> {
  const raw = await getStringSystemSetting(SETTINGS_KEY);
  let parsed: Partial<ReminderSettings> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  return {
    reminder_days: Array.isArray(parsed.reminder_days) && parsed.reminder_days.length ? cleanDays(parsed.reminder_days) : DEFAULT_REMINDER_DAYS,
    remind_employee: parsed.remind_employee === true,
    extra_emails: Array.isArray(parsed.extra_emails) ? parsed.extra_emails : []
  };
}

// HR = every active non-admin user who has been granted Employee Contracts
// (by role or permission group, on Roles & Permissions). Admins always have
// access but aren't HR, so they aren't emailed.
export async function hrReminderPeople(): Promise<Array<{ id: string; full_name: string | null; email: string }>> {
  const rows = await query<{ allowed_roles: string[] }>(
    `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = 'employee_contracts' LIMIT 1`
  ).catch(() => []);
  const allowed = (rows[0]?.allowed_roles ?? EMPLOYEE_CONTRACTS_DEFAULT_ACCESS).filter((r) => r !== "ADMIN");
  if (!allowed.length) return [];
  const users = await query<{ id: string; full_name: string | null; email: string; role: string }>(
    `SELECT id, full_name, email, role::text AS role FROM users WHERE is_active AND email IS NOT NULL AND role::text <> 'ADMIN' ORDER BY full_name`
  );
  const out: Array<{ id: string; full_name: string | null; email: string }> = [];
  for (const u of users) {
    if (allowed.includes(u.role) || (await getUserGroups(u.id)).some((g) => allowed.includes(g))) {
      out.push({ id: u.id, full_name: u.full_name, email: u.email });
    }
  }
  return out;
}

// HR's addresses: everyone granted the module plus any extra addresses. If
// that's nobody yet, the person who captured the contract is reminded so a
// reminder is never silently dropped. The employee is always excluded.
async function reminderRecipients(settings: ReminderSettings, hrPeople: Array<{ email: string }>, contract: { created_by_id: string | null; user_id: string | null; person_email: string | null }) {
  let people = hrPeople;
  if (!people.length && !settings.extra_emails.length && contract.created_by_id) {
    people = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND is_active AND email IS NOT NULL`, [contract.created_by_id]);
  }
  const employeeEmails = new Set<string>();
  if (contract.person_email) employeeEmails.add(contract.person_email.toLowerCase());
  if (contract.user_id) {
    const u = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [contract.user_id]))[0];
    if (u?.email) employeeEmails.add(u.email.toLowerCase());
  }
  const all = [...people.map((p) => p.email), ...settings.extra_emails];
  return Array.from(new Set(all.map((e) => e.trim().toLowerCase()).filter((e) => e && !employeeEmails.has(e))));
}

// What a contract can be prefilled with for a FlowDesk user: their place in
// Org Structure (Company › Division › Department › Section) and their
// immediate manager - resolved exactly as approval workflows resolve a
// "Manager" step (reporting line first, then Section/Department/Division
// leadership).
async function personContractDetails(userId: string) {
  const u = (await query<{ title: string | null; employment_type: string | null; company: string | null; division: string | null; department: string | null; section: string | null }>(
    `SELECT u.title, u.employment_type,
            coalesce(cv.name, dv.name) AS company,
            coalesce(sd.name, d.name, u.department) AS division,
            s.name AS department, t.name AS section
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN sections s ON s.id = coalesce(u.section_id, t.section_id)
       LEFT JOIN departments sd ON sd.id = s.department_id
       LEFT JOIN divisions cv ON cv.id = sd.division_id
       LEFT JOIN departments d ON sd.id IS NULL AND lower(trim(d.name)) = lower(trim(u.department))
       LEFT JOIN divisions dv ON dv.id = d.division_id
      WHERE u.id = $1`,
    [userId]
  ))[0];
  if (!u) return null;
  const manager = await resolveRequesterManager(userId).catch(() => null);
  return {
    position: u.title,
    employment_type: u.employment_type,
    org_path: [u.company, u.division, u.department, u.section].filter(Boolean).join(" › ") || null,
    supervisor_id: manager?.id ?? null,
    supervisor_name: manager?.full_name ?? null
  };
}

// ── Mapping ─────────────────────────────────────────────────────────────
const CONTRACT_SELECT = `
  SELECT c.*, to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
         (c.end_date - current_date) AS days_left,
         u.full_name AS user_name, u.email AS user_email, u.employee_no AS user_employee_no,
         sv.full_name AS supervisor_name, cb.full_name AS created_by_name, cl.full_name AS closed_by_name,
         pr.contract_no AS renewed_from_no,
         (SELECT n.id FROM employee_contracts n WHERE n.renewed_from_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS renewed_to_id,
         (SELECT n.contract_no FROM employee_contracts n WHERE n.renewed_from_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS renewed_to_no,
         (SELECT count(*)::int FROM employee_contract_documents d WHERE d.contract_id = c.id) AS document_count,
         (SELECT max(r.sent_at) FROM employee_contract_reminders r WHERE r.contract_id = c.id AND r.status = 'SENT') AS last_reminder_at
    FROM employee_contracts c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN users sv ON sv.id = c.supervisor_id
    LEFT JOIN users cb ON cb.id = c.created_by_id
    LEFT JOIN users cl ON cl.id = c.closed_by_id
    LEFT JOIN employee_contracts pr ON pr.id = c.renewed_from_id`;

function mapContract(r: any) {
  return { ...r, days_left: r.days_left === null ? null : Number(r.days_left) };
}

// ── Routes ──────────────────────────────────────────────────────────────
export const employeeContractsRouter = Router();
employeeContractsRouter.use(requireAuth);

employeeContractsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    return res.json({ canAccess: await canUseContracts(req) });
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const rows = await query<any>(`${CONTRACT_SELECT} ORDER BY (c.status = 'ACTIVE') DESC, c.end_date ASC, c.person_name`);
    const settings = await getReminderSettings();
    return res.json({ items: rows.map(mapContract), reminder_days: settings.reminder_days, remind_employee: settings.remind_employee });
  } catch (err) {
    return next(err);
  }
});

// GET /employee-contracts/suggestions — active staff whose profile says
// intern or temporary but who have no active contract here, with what we
// can prefill (position, department, supervisor from their reporting line,
// and their last contract if one ended).
employeeContractsRouter.get("/suggestions", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const rows = await query<any>(
      `SELECT u.id, u.full_name, u.email, u.employee_no, u.title, u.employment_type,
              last.contract_no AS last_contract_no, to_char(last.end_date, 'YYYY-MM-DD') AS last_end_date, last.status AS last_status,
              ds.user_id IS NOT NULL AS dismissed, ds.reason AS dismissed_reason, dsb.full_name AS dismissed_by_name, ds.dismissed_at
         FROM users u
         LEFT JOIN LATERAL (
           SELECT c.contract_no, c.end_date, c.status FROM employee_contracts c WHERE c.user_id = u.id ORDER BY c.end_date DESC LIMIT 1
         ) last ON true
         LEFT JOIN employee_contract_dismissals ds ON ds.user_id = u.id
         LEFT JOIN users dsb ON dsb.id = ds.dismissed_by_id
        WHERE u.is_active AND upper(coalesce(u.employment_type, '')) IN ('INTERN', 'TEMPORARY')
          AND NOT EXISTS (SELECT 1 FROM employee_contracts c WHERE c.user_id = u.id AND c.status = 'ACTIVE')
        ORDER BY ds.user_id IS NOT NULL, u.full_name`
    );
    const items = [];
    for (const r of rows) {
      const p = await personContractDetails(r.id);
      items.push({ ...r, department: p?.org_path ?? null, supervisor_id: p?.supervisor_id ?? null, supervisor_name: p?.supervisor_name ?? null });
    }
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

const DismissSchema = z.object({ reason: z.string().trim().max(500).nullish() });
employeeContractsRouter.post("/suggestions/:userId/dismiss", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const parsed = DismissSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid request");
    const u = (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [req.params.userId]))[0];
    if (!u) throw notFound("Employee not found");
    await query(
      `INSERT INTO employee_contract_dismissals (user_id, reason, dismissed_by_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, dismissed_by_id = EXCLUDED.dismissed_by_id, dismissed_at = now()`,
      [req.params.userId, parsed.data.reason || null, req.user!.userId]
    );
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_NOT_NEEDED", req.params.userId, null, { employee: u.full_name, reason: parsed.data.reason || null });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.delete("/suggestions/:userId/dismiss", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    await query(`DELETE FROM employee_contract_dismissals WHERE user_id = $1`, [req.params.userId]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /employee-contracts/person/:userId — prefill for a picked employee.
employeeContractsRouter.get("/person/:userId", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const p = await personContractDetails(req.params.userId);
    if (!p) throw notFound("Employee not found");
    return res.json(p);
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.get("/settings", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const settings = await getReminderSettings();
    return res.json({ ...settings, hr_recipients: await hrReminderPeople(), default_reminder_days: DEFAULT_REMINDER_DAYS });
  } catch (err) {
    return next(err);
  }
});

const SettingsSchema = z.object({
  reminder_days: z.array(z.number().int().min(1).max(365)).min(1, "Add at least one reminder").max(10),
  remind_employee: z.boolean(),
  extra_emails: z.array(z.string().trim().email()).max(20)
});

employeeContractsRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid settings", parsed.error.flatten());
    const before = await getReminderSettings();
    const next_: ReminderSettings = {
      reminder_days: cleanDays(parsed.data.reminder_days),
      remind_employee: parsed.data.remind_employee,
      extra_emails: Array.from(new Set(parsed.data.extra_emails.map((e) => e.toLowerCase())))
    };
    await setStringSystemSetting(SETTINGS_KEY, JSON.stringify(next_));
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_SETTINGS", "00000000-0000-0000-0000-000000000000", before, next_);
    return res.json(next_);
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const row = (await query<any>(`${CONTRACT_SELECT} WHERE c.id = $1`, [req.params.id]))[0];
    if (!row) throw notFound("Contract not found");
    const [documents, reminders, history] = await Promise.all([
      query(
        `SELECT d.id, d.file_name, d.mime_type, d.file_size, d.uploaded_at, u.full_name AS uploaded_by_name
           FROM employee_contract_documents d LEFT JOIN users u ON u.id = d.uploaded_by_id
          WHERE d.contract_id = $1 ORDER BY d.uploaded_at DESC`,
        [req.params.id]
      ),
      query(
        `SELECT days_before, status, recipients, employee_notified_to, sent_at, to_char(end_date, 'YYYY-MM-DD') AS end_date
           FROM employee_contract_reminders WHERE contract_id = $1 AND status <> 'SENDING' ORDER BY created_at DESC`,
        [req.params.id]
      ),
      query(
        `SELECT l.action, l.created_at, l.before_json, l.after_json, u.full_name AS actor_name
           FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
          WHERE l.entity_type = 'EMPLOYEE_CONTRACT' AND l.entity_id::text = $1 ORDER BY l.created_at DESC`,
        [req.params.id]
      )
    ]);
    return res.json({ ...mapContract(row), documents, reminders, history });
  } catch (err) {
    return next(err);
  }
});

const ContractSchema = z.object({
  user_id: z.string().uuid().nullish(),
  person_name: z.string().trim().max(200).nullish(),
  person_email: z.string().trim().email().nullish().or(z.literal("")),
  contract_type: z.enum(["INTERN", "TEMPORARY"]),
  position: z.string().trim().max(200).nullish(),
  department: z.string().trim().max(200).nullish(),
  supervisor_id: z.string().uuid().nullish(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date is required"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "End date is required"),
  reminder_days: z.array(z.number().int().min(1).max(365)).max(10).nullish(),
  notify_employee: z.boolean().nullish(),
  notes: z.string().trim().max(4000).nullish()
});
type ContractInput = z.infer<typeof ContractSchema>;

async function normalizeContractInput(input: ContractInput) {
  if (input.end_date < input.start_date) throw badRequest("The end date can't be before the start date");
  let personName = input.person_name?.trim() || "";
  let personEmail = input.person_email?.trim() || null;
  if (input.user_id) {
    const u = (await query<{ full_name: string | null; email: string }>(`SELECT full_name, email FROM users WHERE id = $1`, [input.user_id]))[0];
    if (!u) throw badRequest("That employee wasn't found");
    personName = u.full_name || u.email;
    personEmail = u.email;
  }
  if (!personName) throw badRequest("Choose the employee or enter their name");
  if (input.notify_employee === true && !personEmail) throw badRequest("Add the employee's email to remind them too");
  return {
    user_id: input.user_id || null,
    person_name: personName,
    person_email: personEmail,
    contract_type: input.contract_type,
    position: input.position?.trim() || null,
    department: input.department?.trim() || null,
    supervisor_id: input.supervisor_id || null,
    start_date: input.start_date,
    end_date: input.end_date,
    reminder_days: input.reminder_days && input.reminder_days.length ? cleanDays(input.reminder_days) : null,
    notify_employee: input.notify_employee ?? null,
    notes: input.notes?.trim() || null
  };
}

async function insertContract(v: Awaited<ReturnType<typeof normalizeContractInput>>, actorId: string, renewedFromId: string | null) {
  const contractNo = await nextSequentialNumber("EC", 4);
  const row = (await query<{ id: string }>(
    `INSERT INTO employee_contracts (contract_no, user_id, person_name, person_email, contract_type, position, department, supervisor_id,
                                     start_date, end_date, reminder_days, notes, renewed_from_id, created_by_id, notify_employee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [contractNo, v.user_id, v.person_name, v.person_email, v.contract_type, v.position, v.department, v.supervisor_id,
     v.start_date, v.end_date, v.reminder_days, v.notes, renewedFromId, actorId, v.notify_employee]
  ))[0];
  return { id: row.id, contract_no: contractNo };
}

employeeContractsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const parsed = ContractSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid contract", parsed.error.flatten());
    const v = await normalizeContractInput(parsed.data);
    const created = await insertContract(v, req.user!.userId, null);
    if (v.user_id) await query(`DELETE FROM employee_contract_dismissals WHERE user_id = $1`, [v.user_id]);
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_CREATED", created.id, null, v);
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const before = (await query<any>(`SELECT * FROM employee_contracts WHERE id = $1`, [req.params.id]))[0];
    if (!before) throw notFound("Contract not found");
    if (before.status !== "ACTIVE") throw badRequest("Only an active contract can be edited");
    const parsed = ContractSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid contract", parsed.error.flatten());
    const v = await normalizeContractInput(parsed.data);
    await query(
      `UPDATE employee_contracts SET user_id=$2, person_name=$3, person_email=$4, contract_type=$5, position=$6, department=$7, supervisor_id=$8,
              start_date=$9, end_date=$10, reminder_days=$11, notes=$12, notify_employee=$13, updated_at=now() WHERE id=$1`,
      [req.params.id, v.user_id, v.person_name, v.person_email, v.contract_type, v.position, v.department, v.supervisor_id,
       v.start_date, v.end_date, v.reminder_days, v.notes, v.notify_employee]
    );
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_UPDATED", req.params.id, before, v);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const RenewSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date is required"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "End date is required"),
  contract_type: z.enum(["INTERN", "TEMPORARY"]).optional(),
  position: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(4000).nullish()
});

// Renewing keeps the old contract as history (status RENEWED) and starts a
// new one linked to it, so reminders and documents stay per contract term.
employeeContractsRouter.post("/:id/renew", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const old = (await query<any>(
      `SELECT *, to_char(end_date,'YYYY-MM-DD') AS end_s FROM employee_contracts WHERE id = $1`, [req.params.id]
    ))[0];
    if (!old) throw notFound("Contract not found");
    if (old.status !== "ACTIVE") throw badRequest("Only an active contract can be renewed");
    const parsed = RenewSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid renewal", parsed.error.flatten());
    const v = await normalizeContractInput({
      user_id: old.user_id, person_name: old.person_name, person_email: old.person_email,
      contract_type: parsed.data.contract_type ?? old.contract_type,
      position: parsed.data.position !== undefined ? parsed.data.position : old.position,
      department: old.department, supervisor_id: old.supervisor_id,
      start_date: parsed.data.start_date, end_date: parsed.data.end_date,
      reminder_days: old.reminder_days, notify_employee: old.notify_employee, notes: parsed.data.notes ?? null
    });
    const created = await insertContract(v, req.user!.userId, old.id);
    await query(
      `UPDATE employee_contracts SET status='RENEWED', closed_at=now(), closed_by_id=$2, close_reason=$3, updated_at=now() WHERE id=$1`,
      [old.id, req.user!.userId, `Renewed as ${created.contract_no}`]
    );
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_RENEWED", old.id, { end_date: old.end_s }, { renewed_as: created.contract_no, start_date: v.start_date, end_date: v.end_date });
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_CREATED", created.id, null, { ...v, renewed_from: old.contract_no });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

const CloseSchema = z.object({
  outcome: z.enum(["ENDED", "TERMINATED"]),
  reason: z.string().trim().max(2000).nullish()
});

employeeContractsRouter.post("/:id/close", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const parsed = CloseSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());
    if (parsed.data.outcome === "TERMINATED" && !parsed.data.reason) throw badRequest("Give a reason for terminating the contract early");
    const old = (await query<any>(`SELECT status FROM employee_contracts WHERE id = $1`, [req.params.id]))[0];
    if (!old) throw notFound("Contract not found");
    if (old.status !== "ACTIVE") throw badRequest("This contract is already closed");
    await query(
      `UPDATE employee_contracts SET status=$2, closed_at=now(), closed_by_id=$3, close_reason=$4, updated_at=now() WHERE id=$1`,
      [req.params.id, parsed.data.outcome, req.user!.userId, parsed.data.reason || null]
    );
    await audit(req.user!.userId, `EMPLOYEE_CONTRACT_${parsed.data.outcome}`, req.params.id, { status: "ACTIVE" }, { status: parsed.data.outcome, reason: parsed.data.reason || null });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const row = (await query<any>(`SELECT * FROM employee_contracts WHERE id = $1`, [req.params.id]))[0];
    if (!row) throw notFound("Contract not found");
    const renewal = await query(`SELECT id FROM employee_contracts WHERE renewed_from_id = $1 LIMIT 1`, [req.params.id]);
    if (renewal.length) throw badRequest("This contract has a renewal linked to it — delete the renewal first");
    await query(`DELETE FROM employee_contracts WHERE id = $1`, [req.params.id]);
    if (row.renewed_from_id) {
      // Deleting a renewal reopens the contract it replaced.
      const reopened = await query(
        `UPDATE employee_contracts SET status='ACTIVE', closed_at=NULL, closed_by_id=NULL, close_reason=NULL, updated_at=now()
          WHERE id=$1 AND status='RENEWED' RETURNING id`,
        [row.renewed_from_id]
      );
      if (reopened.length) {
        await audit(req.user!.userId, "EMPLOYEE_CONTRACT_REOPENED", row.renewed_from_id, { status: "RENEWED" }, { status: "ACTIVE", reason: `Renewal ${row.contract_no} was deleted` });
      }
    }
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_DELETED", req.params.id, row, null);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Documents ───────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "doc", "docx", "png", "jpg", "jpeg"])
});

employeeContractsRouter.post("/:id/documents", upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const exists = await query(`SELECT id FROM employee_contracts WHERE id = $1`, [req.params.id]);
    if (!exists.length) throw notFound("Contract not found");
    if (!req.file) throw badRequest("Choose a file to upload");
    const fileName = sanitizeUploadFilename(req.file.originalname);
    const row = (await query<{ id: string }>(
      `INSERT INTO employee_contract_documents (contract_id, file_name, mime_type, file_size, content, uploaded_by_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.id, fileName, req.file.mimetype, req.file.size, req.file.buffer, req.user!.userId]
    ))[0];
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_DOCUMENT_ADDED", req.params.id, null, { file_name: fileName });
    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.get("/:id/documents/:docId", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const doc = (await query<{ file_name: string; mime_type: string | null; content: Buffer }>(
      `SELECT file_name, mime_type, content FROM employee_contract_documents WHERE id = $1 AND contract_id = $2`,
      [req.params.docId, req.params.id]
    ))[0];
    if (!doc) throw notFound("Document not found");
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${doc.file_name.replace(/"/g, "")}"`);
    return res.send(doc.content);
  } catch (err) {
    return next(err);
  }
});

employeeContractsRouter.delete("/:id/documents/:docId", async (req: AuthedRequest, res, next) => {
  try {
    await requireAccess(req);
    const doc = (await query<{ file_name: string }>(
      `DELETE FROM employee_contract_documents WHERE id = $1 AND contract_id = $2 RETURNING file_name`,
      [req.params.docId, req.params.id]
    ))[0];
    if (!doc) throw notFound("Document not found");
    await audit(req.user!.userId, "EMPLOYEE_CONTRACT_DOCUMENT_REMOVED", req.params.id, { file_name: doc.file_name }, null);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Expiry reminder worker ──────────────────────────────────────────────
// Runs hourly on every node. A reminder is due once today is on or after
// (end date - N days) and the contract is still active and not yet past its
// end date, so a reminder missed while the server was down still goes out.
// When several lead times are due at once (e.g. a contract entered a week
// before it ends), only the nearest one is sent and the rest are marked
// SKIPPED, so HR gets one email rather than a burst.
export async function runEmployeeContractReminderCycle() {
  // A claim left in SENDING (the node died mid-send) is released after 15
  // minutes so that reminder still goes out.
  await query(`DELETE FROM employee_contract_reminders WHERE status = 'SENDING' AND created_at < now() - interval '15 minutes'`);
  const settings = await getReminderSettings();
  let hrPeople: Array<{ email: string }> | null = null;
  const contracts = await query<any>(
    `SELECT id, contract_no, person_name, person_email, user_id, contract_type, position, department, created_by_id, reminder_days, notify_employee,
            to_char(end_date, 'YYYY-MM-DD') AS end_date, (end_date - current_date) AS days_left
       FROM employee_contracts
      WHERE status = 'ACTIVE' AND end_date >= current_date`
  );
  let sent = 0;
  for (const c of contracts) {
    const daysLeft = Number(c.days_left);
    const leadTimes: number[] = [...(c.reminder_days?.length ? c.reminder_days : settings.reminder_days), 0];
    const already = new Set(
      (await query<{ days_before: number }>(
        `SELECT days_before FROM employee_contract_reminders WHERE contract_id = $1 AND end_date = $2`, [c.id, c.end_date]
      )).map((r) => r.days_before)
    );
    const due = Array.from(new Set(leadTimes)).filter((d) => daysLeft <= d && !already.has(d)).sort((a, b) => a - b);
    if (!due.length) continue;
    const nearest = due[0];
    const claimed = await query<{ id: string }>(
      `INSERT INTO employee_contract_reminders (contract_id, end_date, days_before, status)
       VALUES ($1, $2, $3, 'SENDING') ON CONFLICT (contract_id, end_date, days_before) DO NOTHING RETURNING id`,
      [c.id, c.end_date, nearest]
    );
    if (!claimed.length) continue; // the other node got it
    for (const d of due.slice(1)) {
      await query(
        `INSERT INTO employee_contract_reminders (contract_id, end_date, days_before, status)
         VALUES ($1, $2, $3, 'SKIPPED') ON CONFLICT DO NOTHING`,
        [c.id, c.end_date, d]
      );
    }
    try {
      hrPeople ??= await hrReminderPeople();
      const recipients = await reminderRecipients(settings, hrPeople, c);
      if (!recipients.length) throw new Error("no HR recipients configured");
      await notifyEmployeeContractExpiring({
        recipients, contractNo: c.contract_no, personName: c.person_name, contractType: c.contract_type,
        position: c.position, department: c.department, endDate: c.end_date, daysLeft
      });
      // Optional copy to the employee (their own wording). A failure here
      // doesn't undo HR's reminder - it's logged and HR still got theirs.
      let employeeTo: string | null = null;
      if (c.notify_employee ?? settings.remind_employee) {
        const email = c.user_id
          ? (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND is_active`, [c.user_id]))[0]?.email ?? c.person_email
          : c.person_email;
        if (email) {
          try {
            await notifyEmployeeOwnContractExpiring({ email, personName: c.person_name, contractType: c.contract_type, endDate: c.end_date, daysLeft });
            employeeTo = email;
          } catch (err) {
            logger.warn("employee_contract_employee_reminder_failed", { contract: c.contract_no, error: String(err) });
          }
        }
      }
      await query(
        `UPDATE employee_contract_reminders SET status='SENT', sent_at=now(), recipients=$2, employee_notified_to=$3 WHERE id=$1`,
        [claimed[0].id, recipients, employeeTo]
      );
      sent++;
    } catch (err) {
      // Release the claim so the next cycle retries it.
      await query(`DELETE FROM employee_contract_reminders WHERE id = $1`, [claimed[0].id]);
      logger.warn("employee_contract_reminder_failed", { contract: c.contract_no, error: String(err) });
    }
  }
  return sent;
}

export function startEmployeeContractReminderWorker() {
  // Clamped: Node treats any interval over ~24.8 days as 1ms, which would
  // spin this cycle continuously.
  const configured = Number(process.env.EMPLOYEE_CONTRACT_REMINDER_INTERVAL_MINUTES || 60);
  const intervalMinutes = Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 24 * 60) : 60;
  const run = () => { runEmployeeContractReminderCycle().catch((err) => logger.warn("employee_contract_reminder_cycle_failed", { error: String(err) })); };
  // First run shortly after startup, once the schema bootstrap has finished.
  setTimeout(run, 60_000);
  setInterval(run, intervalMinutes * 60_000);
}
