/**
 * Overtime Request & Claim Management.
 *
 * Rebuilt to mirror the Standby module's architecture (see
 * modules/standby/standby.routes.ts): employee-defined, route-versioned
 * approval steps for both the Request and the Claim stage (replacing the
 * old hardcoded Supervisor->HOD->CTO / authorise->hr-note->finance-verify->
 * record-earnings->transfer-summary chains), delegation reuse via
 * /auth/delegations, and a Finance stage gated by the same shared
 * lib/financeAuthority.ts used by Standby (one Finance authority list, one
 * Compensation Queue on the frontend).
 *
 * "Section" in the FlowDesk org-structure mapping is this app's `teams`
 * table (Company/Division/Department/Section -> divisions/departments/
 * sections/teams) — see the Standby module header comment for the full
 * mapping. Overtime never stores a point-in-time snapshot of employee/org
 * fields; it always joins `users`/`getUserOrgPath` live, same as Standby.
 */
import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { AuthedRequest, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import { getUserOrgPath } from "../../lib/departments.js";
import { getUserAccountState, isProfileComplete } from "../../lib/userProfile.js";
import { getDelegatedManagerIds } from "../../lib/delegations.js";
import { isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { getBooleanSystemSetting, getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { LESOTHO_HOLIDAY_SEED } from "./lesothoHolidaySeed.js";
import {
  notifyOvertimeRequestSubmitted,
  notifyOvertimeRequestReturned,
  notifyOvertimeClaimSubmitted,
  notifyOvertimeClaimReturned,
  notifyOvertimeClaimFinanceReady,
  notifyOvertimeClaimProcessed,
  notifyOvertimeClaimSettled
} from "../../lib/notifications.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveOvertimeRequestPdfData, resolveOvertimeClaimPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";

export async function ensureOvertimeSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS overtime_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_no text UNIQUE NOT NULL,
      employee_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      year int NOT NULL,
      month int NOT NULL,
      noc text,
      car_reg text,
      remarks text,
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'DRAFT',
      current_route_version int NOT NULL DEFAULT 1,
      current_step_order int NOT NULL DEFAULT 0,
      submitted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Reconciles an overtime_requests table that pre-dates this rewrite (the
  // old hardcoded-approval-chain version) — CREATE TABLE IF NOT EXISTS above
  // is a no-op against it, so the new columns/default and the dropped old
  // columns have to be applied explicitly. No-ops on a genuinely fresh
  // install where the CREATE TABLE already produced the right shape.
  await query(`ALTER TABLE overtime_requests ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS request_no text`);
  await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS noc text`);
  await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS current_route_version int NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS current_step_order int NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS submitted_at timestamptz`);
  await query(`UPDATE overtime_requests SET request_no = 'OTR-LEGACY-' || substr(id::text, 1, 8) WHERE request_no IS NULL`);
  await query(`ALTER TABLE overtime_requests ALTER COLUMN request_no SET NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_requests_request_no ON overtime_requests(request_no)`);
  for (const col of [
    "employee_name", "employee_no", "job_title", "section_name", "recommended_by_supervisor", "supervisor_date",
    "approved_by_hod", "approved_by_cto", "supervisor_approved_by_id", "supervisor_approved_at", "hod_approved_by_id",
    "hod_approved_at", "cto_approved_by_id", "cto_approved_at", "rejected_by_id", "rejected_at", "rejection_reason"
  ]) {
    await query(`ALTER TABLE overtime_requests DROP COLUMN IF EXISTS ${col}`);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_request_approval_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES overtime_requests(id) ON DELETE CASCADE,
      route_version int NOT NULL,
      step_order int NOT NULL,
      approver_user_id uuid NOT NULL REFERENCES users(id),
      title text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      decided_at timestamptz,
      comments text
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_request_steps_unique ON overtime_request_approval_steps(request_id, route_version, step_order)`);

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_no text UNIQUE NOT NULL,
      employee_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      overtime_request_id uuid REFERENCES overtime_requests(id),
      year int NOT NULL,
      month int NOT NULL,
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      total_overtime numeric(10,2) NOT NULL DEFAULT 0,
      converted_hours numeric(10,2) NOT NULL DEFAULT 0,
      equivalent_days numeric(10,3) NOT NULL DEFAULT 0,
      compensation_preference text,
      hourly_rate numeric(12,2),
      total_amount numeric(12,2),
      cost_centre text,
      account_project text,
      payroll_period text,
      finance_reference text,
      finance_comments text,
      status text NOT NULL DEFAULT 'DRAFT',
      current_route_version int NOT NULL DEFAULT 1,
      current_step_order int NOT NULL DEFAULT 0,
      submitted_at timestamptz,
      finance_processed_at timestamptz,
      paid_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Same reconciliation as overtime_requests above, for a pre-existing
  // overtime_claims table.
  await query(`ALTER TABLE overtime_claims ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS claim_no text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS converted_hours numeric(10,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS equivalent_days numeric(10,3) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS compensation_preference text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS cost_centre text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS account_project text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS payroll_period text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS finance_reference text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS finance_comments text`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS current_route_version int NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS current_step_order int NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS submitted_at timestamptz`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS finance_processed_at timestamptz`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS paid_at timestamptz`);
  await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
  await query(`ALTER TABLE overtime_claims ALTER COLUMN hourly_rate DROP NOT NULL`);
  await query(`ALTER TABLE overtime_claims ALTER COLUMN hourly_rate DROP DEFAULT`);
  await query(`ALTER TABLE overtime_claims ALTER COLUMN total_amount DROP NOT NULL`);
  await query(`ALTER TABLE overtime_claims ALTER COLUMN total_amount DROP DEFAULT`);
  await query(`UPDATE overtime_claims SET claim_no = 'OTCL-LEGACY-' || substr(id::text, 1, 8) WHERE claim_no IS NULL`);
  await query(`ALTER TABLE overtime_claims ALTER COLUMN claim_no SET NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_claims_claim_no ON overtime_claims(claim_no)`);
  for (const col of [
    "employee_name", "employee_no", "job_title", "division", "compensated_hours", "pay_days", "authorised_by",
    "checked_by_supervisor", "approved_by_manager", "approved_by_cto", "notation_hr", "compensation_type",
    "salary_class", "number_of_hours", "calculated_by", "checked_noted_earning_by", "transferred_to_summary_by",
    "manager_authorised_by_id", "manager_authorised_at", "hr_noted_at", "finance_verified_at",
    "earnings_recorded_at", "summary_transferred_at"
  ]) {
    await query(`ALTER TABLE overtime_claims DROP COLUMN IF EXISTS ${col}`);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_claim_approval_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_id uuid NOT NULL REFERENCES overtime_claims(id) ON DELETE CASCADE,
      route_version int NOT NULL,
      step_order int NOT NULL,
      approver_user_id uuid NOT NULL REFERENCES users(id),
      title text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      decided_at timestamptz,
      comments text
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_claim_steps_unique ON overtime_claim_approval_steps(claim_id, route_version, step_order)`);

  // Governed public-holiday calendar driving the 200% rate bucket, instead
  // of a hardcoded date list — see lib/pdf or lesothoHolidaySeed.ts for the
  // one-time algorithmic seed (Easter-based + fixed dates), used only to
  // populate this table on first boot so admins aren't starting empty.
  await query(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      holiday_date date UNIQUE NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // A holiday observed on a different (weekday) date than its gazetted date
  // — the common case being a holiday that falls on a Saturday/Sunday, moved
  // to the following Monday. Both dates earn the 200% rate; see
  // getActiveHolidayDates(). Admin and Finance (isCompensationFinanceUser)
  // manage this, not Admin-only — see the relaxed permission on the
  // POST/DELETE routes below.
  await query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS observed_date date`);
  const existingHolidays = (await query<{ count: string }>(`SELECT count(*)::text AS count FROM public_holidays`))[0];
  if (Number(existingHolidays.count) === 0) {
    for (const h of LESOTHO_HOLIDAY_SEED) {
      await query(`INSERT INTO public_holidays (holiday_date, name) VALUES ($1,$2) ON CONFLICT (holiday_date) DO NOTHING`, [h.date, h.name]);
    }
  }

  // Claim periods — Admin/Finance open a specific year+month before
  // employees can submit an Overtime Claim for it (payroll-cycle gate; see
  // POST /claims/:id/submit). Requests are unaffected — only Claim
  // submission is gated, since a Claim is what actually reaches Finance for
  // payment.
  await query(`
    CREATE TABLE IF NOT EXISTS overtime_claim_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      year int NOT NULL,
      month int NOT NULL,
      status text NOT NULL DEFAULT 'OPEN',
      opened_by_id uuid REFERENCES users(id),
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_by_id uuid REFERENCES users(id),
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_claim_periods_year_month ON overtime_claim_periods(year, month)`);
}

async function writeOvertimeAudit(args: { actorId: string; entityType: string; entityId: string; action: string; before?: unknown; after?: unknown }) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6)`,
    [args.actorId, args.action, args.entityType, args.entityId, args.before ? JSON.stringify(args.before) : null, args.after ? JSON.stringify(args.after) : null]
  );
}

async function getUserContact(userId: string | null | undefined) {
  if (!userId) return null;
  const rows = await query<{ id: string; full_name: string | null; email: string; role: string }>(
    `SELECT id, full_name, email, role FROM users WHERE id=$1`,
    [userId]
  );
  return rows[0] || null;
}

async function nextRequestNo() {
  return nextSequentialNumber("OTR", 5);
}

async function nextClaimNo() {
  return nextSequentialNumber("OTCL", 5);
}

const APPROVAL_ROUTE_SCHEMA = z
  .array(z.object({ approver_user_id: z.string().uuid(), title: z.string().trim().min(1) }))
  .min(1, "At least one approver is required");

// ---------------------------------------------------------------------------
// Rate classification — server-side and authoritative (never trust the
// client's hours_125/hours_150/hours_200/converted_hours at submit time),
// configurable via system settings instead of hardcoded weekday/weekend
// assumptions. The frontend runs the same logic client-side only as a live
// preview; what actually gets stored/approved is recomputed here.
// ---------------------------------------------------------------------------

async function getOvertimeRateSettings() {
  const [weekdayPct, saturdayPct, sundayHolidayPct, workingHoursPerDay] = await Promise.all([
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateWeekdayPct, 125),
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateSaturdayPct, 150),
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateSundayHolidayPct, 200),
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.workingHoursPerDay, 8)
  ]);
  return { weekdayPct, saturdayPct, sundayHolidayPct, workingHoursPerDay };
}

// Includes both the gazetted date and, when set, the observed weekday it was
// moved to — a holiday shifted off a weekend still earns 200% on whichever
// of the two dates someone actually works.
async function getActiveHolidayDates(): Promise<Set<string>> {
  const rows = await query<{ holiday_date: string; observed_date: string | null }>(
    `SELECT holiday_date::text AS holiday_date, observed_date::text AS observed_date FROM public_holidays WHERE active=true`
  );
  const dates = new Set<string>();
  for (const r of rows) {
    dates.add(r.holiday_date);
    if (r.observed_date) dates.add(r.observed_date);
  }
  return dates;
}

function hoursBetween(fromTime: string, toTime: string): number {
  const [fh, fm] = (fromTime || "00:00").split(":").map(Number);
  const [th, tm] = (toTime || "00:00").split(":").map(Number);
  let minutes = th * 60 + tm - (fh * 60 + fm);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

function dayOfWeekName(dateStr: string): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const d = new Date(`${dateStr}T00:00:00`);
  return names[d.getDay()] ?? "";
}

// Recomputes one claim line's day/hours/rate bucket authoritatively.
// `observed_holiday` lets the approver mark a weekend-observed holiday that
// the algorithmic calendar wouldn't otherwise catch (e.g. a holiday shifted
// to the following Monday) — the same override the frontend preview offers.
async function classifyClaimLine(line: any, holidays: Set<string>, rates: { weekdayPct: number; saturdayPct: number; sundayHolidayPct: number }) {
  const day = dayOfWeekName(line.date);
  const hours = hoursBetween(line.from_time, line.to_time);
  const isHoliday = holidays.has(line.date) || Boolean(line.observed_holiday);
  const pct = day === "Sunday" || isHoliday ? rates.sundayHolidayPct : day === "Saturday" ? rates.saturdayPct : rates.weekdayPct;
  const converted = Math.round(hours * (pct / 100) * 100) / 100;
  return {
    ...line,
    day,
    hours_125: pct === 125 ? hours : 0,
    hours_150: pct === 150 ? hours : 0,
    hours_200: pct === 200 ? hours : 0,
    converted_hours: converted
  };
}

async function recomputeClaimLines(lines: any[]) {
  const [holidays, rates] = await Promise.all([getActiveHolidayDates(), getOvertimeRateSettings()]);
  const computed = [];
  for (const line of lines) computed.push(await classifyClaimLine(line, holidays, rates));
  const totalOvertime = Math.round(computed.reduce((sum, l) => sum + Number(hoursBetween(l.from_time, l.to_time)), 0) * 100) / 100;
  const convertedHours = Math.round(computed.reduce((sum, l) => sum + Number(l.converted_hours), 0) * 100) / 100;
  const equivalentDays = rates.workingHoursPerDay > 0 ? Math.round((convertedHours / rates.workingHoursPerDay) * 1000) / 1000 : 0;
  return { lines: computed, totalOvertime, convertedHours, equivalentDays };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const overtimeRouter = Router();
overtimeRouter.use(requireAuth);

// ADMIN/MANAGER may create a request/claim on behalf of someone in the same
// (legacy) department — same on-behalf-of pattern as Advance requests.
async function resolveEmployee(actorId: string, requestedEmployeeId?: string) {
  const actor = await getUserAccountState(actorId);
  if (!isProfileComplete(actor)) throw badRequest("Complete your profile first");
  const employeeId = requestedEmployeeId || actorId;
  const employee = await getUserAccountState(employeeId);
  if (employee.id !== actor.id && String(employee.department || "").trim() !== String(actor.department || "").trim()) {
    throw forbidden("Overtime records can only be created within your division");
  }
  return employee;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const REQUEST_LINE_SCHEMA = z.object({
  date: z.string(),
  day: z.string().optional(),
  estimated_start: z.string().optional(),
  estimated_end: z.string().optional(),
  actual_start: z.string().optional(),
  actual_end: z.string().optional(),
  reason: z.string().optional()
});

async function loadRequestDetail(requestId: string) {
  const request = (await query<any>(
    `SELECT r.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title
       FROM overtime_requests r JOIN users u ON u.id = r.employee_id
      WHERE r.id=$1`,
    [requestId]
  ))[0];
  if (!request) return null;
  const steps = await query<any>(
    `SELECT s.*, u.full_name AS approver_name FROM overtime_request_approval_steps s
       JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 AND s.route_version=$2 ORDER BY s.step_order`,
    [requestId, request.current_route_version]
  );
  const routeHistory =
    request.current_route_version > 1
      ? await query<any>(
          `SELECT s.*, u.full_name AS approver_name FROM overtime_request_approval_steps s
             JOIN users u ON u.id = s.approver_user_id
            WHERE s.request_id=$1 AND s.route_version < $2 ORDER BY s.route_version, s.step_order`,
          [requestId, request.current_route_version]
        )
      : [];
  const orgPath = await getUserOrgPath(request.employee_id);
  const claim = (await query<{ id: string; claim_no: string; status: string }>(`SELECT id, claim_no, status FROM overtime_claims WHERE overtime_request_id=$1 LIMIT 1`, [requestId]))[0] || null;
  return { ...request, approval_steps: steps, route_history: routeHistory, org_path: orgPath, claim };
}

function isRequestOwner(row: any, userId: string) {
  return row.employee_id === userId || row.created_by_id === userId;
}

const REQUEST_LIST_SELECT = `
  SELECT r.*, u.full_name AS employee_name, cs.title AS current_step_title,
         (SELECT c.id FROM overtime_claims c WHERE c.overtime_request_id = r.id LIMIT 1) AS claim_id,
         (SELECT c.status FROM overtime_claims c WHERE c.overtime_request_id = r.id LIMIT 1) AS claim_status
    FROM overtime_requests r
    JOIN users u ON u.id = r.employee_id
    LEFT JOIN overtime_request_approval_steps cs
      ON cs.request_id = r.id AND cs.route_version = r.current_route_version AND cs.step_order = r.current_step_order
`;

overtimeRouter.get("/requests", async (req: AuthedRequest, res, next) => {
  try {
    const rows =
      req.user!.role === "ADMIN"
        ? await query<any>(`${REQUEST_LIST_SELECT} ORDER BY r.created_at DESC`)
        : await query<any>(`${REQUEST_LIST_SELECT} WHERE r.employee_id=$1 OR r.created_by_id=$1 ORDER BY r.created_at DESC`, [req.user!.userId]);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/requests/:id", async (req: AuthedRequest, res, next) => {
  try {
    const request = await loadRequestDetail(req.params.id);
    if (!request) throw notFound();
    const isOwner = isRequestOwner(request, req.user!.userId);
    const isApprover = (request.approval_steps as any[]).some((s) => s.approver_user_id === req.user!.userId);
    if (!isOwner && !isApprover && req.user!.role !== "ADMIN") throw forbidden();
    const currentStep = (request.approval_steps as any[]).find((s) => s.step_order === request.current_step_order);
    const can_view_pdf = await canAccessPdf({ requestType: "OVERTIME_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" });
    return res.json({ ...request, is_owner: isOwner, is_current_approver: Boolean(currentStep && currentStep.approver_user_id === req.user!.userId), can_view_pdf });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/requests/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const request = await loadRequestDetail(req.params.id);
    if (!request) throw notFound();
    const isOwner = isRequestOwner(request, req.user!.userId);
    if (!(await canAccessPdf({ requestType: "OVERTIME_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }
    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'OVERTIME_REQUEST' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for overtime requests yet.");
    const data = await resolveOvertimeRequestPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("OVERTIME_REQUEST");
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="overtime-request-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/requests", requireFeatureAccess("overtime_request", ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"]), async (req: AuthedRequest, res, next) => {
  try {
    if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.overtimeModuleEnabled, true))) {
      throw forbidden("Overtime requests are currently disabled by admin.");
    }
    const body = z
      .object({
        employee_id: z.string().uuid().optional(),
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        noc: z.string().trim().optional(),
        car_reg: z.string().trim().optional(),
        remarks: z.string().trim().optional(),
        lines: z.array(REQUEST_LINE_SCHEMA).default([])
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid overtime request payload", body.error.flatten());
    const employee = await resolveEmployee(req.user!.userId, body.data.employee_id);
    const requestNo = await nextRequestNo();
    const rows = await query<{ id: string }>(
      `INSERT INTO overtime_requests (request_no, employee_id, created_by_id, year, month, noc, car_reg, remarks, lines)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [requestNo, employee.id, req.user!.userId, body.data.year, body.data.month, body.data.noc || null, body.data.car_reg || null, body.data.remarks || null, JSON.stringify(body.data.lines)]
    );
    return res.status(201).json({ id: rows[0].id, request_no: requestNo });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.patch("/requests/:id", async (req: AuthedRequest, res, next) => {
  try {
    const request = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!request) throw notFound();
    if (!isRequestOwner(request, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (request.status !== "DRAFT") throw badRequest("Only a draft request can be edited");

    const body = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
        noc: z.string().trim().optional(),
        car_reg: z.string().trim().optional(),
        remarks: z.string().trim().optional(),
        lines: z.array(REQUEST_LINE_SCHEMA).optional(),
        approval_route: APPROVAL_ROUTE_SCHEMA.optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request update", body.error.flatten());

    await query(
      `UPDATE overtime_requests SET
         year=COALESCE($1,year), month=COALESCE($2,month), noc=COALESCE($3,noc), car_reg=COALESCE($4,car_reg),
         remarks=COALESCE($5,remarks), lines=COALESCE($6,lines), updated_at=now()
       WHERE id=$7`,
      [body.data.year ?? null, body.data.month ?? null, body.data.noc ?? null, body.data.car_reg ?? null, body.data.remarks ?? null, body.data.lines ? JSON.stringify(body.data.lines) : null, req.params.id]
    );

    if (body.data.approval_route) {
      // A request owner can never name themself (or whoever prepared the
      // request on their behalf) as their own approver.
      if (body.data.approval_route.some((step) => step.approver_user_id === request.employee_id || step.approver_user_id === request.created_by_id)) {
        throw badRequest("You cannot select yourself as an approver on your own request");
      }
      await query(`DELETE FROM overtime_request_approval_steps WHERE request_id=$1 AND route_version=$2`, [req.params.id, request.current_route_version]);
      let order = 1;
      for (const step of body.data.approval_route) {
        await query(
          `INSERT INTO overtime_request_approval_steps (request_id, route_version, step_order, approver_user_id, title) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, request.current_route_version, order, step.approver_user_id, step.title]
        );
        order += 1;
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/requests/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const request = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!request) throw notFound();
    if (!isRequestOwner(request, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (request.status !== "DRAFT") throw badRequest("Request has already been submitted");

    const steps = await query<any>(
      `SELECT * FROM overtime_request_approval_steps WHERE request_id=$1 AND route_version=$2 ORDER BY step_order`,
      [req.params.id, request.current_route_version]
    );
    if (!steps.length) throw badRequest("Add at least one approver to the Approval Route before submitting");

    await query(`UPDATE overtime_requests SET status='SUBMITTED', current_step_order=1, submitted_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_requests", entityId: req.params.id, action: "REQUEST_SUBMITTED" });

    const employee = await getUserContact(request.employee_id);
    const firstApprover = await getUserContact(steps[0].approver_user_id);
    void notifyOvertimeRequestSubmitted({
      requestId: req.params.id, requestNo: request.request_no, employeeName: employee?.full_name || null,
      approverName: firstApprover?.full_name || null, approverEmail: firstApprover?.email || null, title: steps[0].title,
      approverId: steps[0].approver_user_id, stepOrder: 1, routeVersion: request.current_route_version
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/requests/:id/withdraw", async (req: AuthedRequest, res, next) => {
  try {
    const request = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!request) throw notFound();
    if (!isRequestOwner(request, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (!["DRAFT", "SUBMITTED"].includes(request.status)) throw badRequest("Only a draft or submitted request can be withdrawn");
    await query(`UPDATE overtime_requests SET status='WITHDRAWN', updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_requests", entityId: req.params.id, action: "REQUEST_WITHDRAWN" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/request-approvals", async (req: AuthedRequest, res, next) => {
  try {
    // Delegated items are flagged, not silently merged — same as the
    // generic Inbox does for Advance/Clearance and Standby's approvals.
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_REQUEST");
    const approverIds = [req.user!.userId, ...delegatedFor];
    const rows = await query<any>(
      `SELECT r.*, u.full_name AS employee_name, s.title AS my_title, s.approver_user_id
         FROM overtime_requests r
         JOIN overtime_request_approval_steps s ON s.request_id = r.id AND s.step_order = r.current_step_order AND s.route_version = r.current_route_version
         JOIN users u ON u.id = r.employee_id
        WHERE s.approver_user_id = ANY($1::uuid[]) AND s.status='PENDING'
        ORDER BY r.submitted_at`,
      [approverIds]
    );
    const delegatingManagerNames = delegatedFor.length
      ? new Map((await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [delegatedFor])).map((u) => [u.id, u.full_name]))
      : new Map<string, string | null>();
    return res.json(rows.map((r) => ({
      ...r,
      is_delegated: r.approver_user_id !== req.user!.userId,
      delegated_from_manager_name: r.approver_user_id !== req.user!.userId ? delegatingManagerNames.get(r.approver_user_id) ?? null : null
    })));
  } catch (err) {
    return next(err);
  }
});

// Locks the request row (SELECT ... FOR UPDATE) inside the caller's
// transaction and re-reads current_step_order/current_route_version fresh
// from it — otherwise two concurrent approve calls (a double-click, or a
// race between an approver and their active delegate) can each pass this
// check for the same step and each proceed to increment current_step_order,
// skipping the next approver.
async function assertCurrentRequestApprover(requestId: string, actor: { userId: string; role: string }, client: PoolClient) {
  const requestRows = await client.query<any>(`SELECT * FROM overtime_requests WHERE id=$1 FOR UPDATE`, [requestId]);
  const request = requestRows.rows[0];
  if (!request) throw notFound();
  const stepRows = await client.query<any>(
    `SELECT * FROM overtime_request_approval_steps WHERE request_id=$1 AND route_version=$2 AND step_order=$3`,
    [requestId, request.current_route_version, request.current_step_order]
  );
  const step = stepRows.rows[0];
  if (!step || step.approver_user_id !== actor.userId) {
    const delegatedFor = actor.role !== "ADMIN" ? await getDelegatedManagerIds(actor.userId, "OVERTIME_REQUEST") : [];
    const isDelegate = Boolean(step && delegatedFor.includes(step.approver_user_id));
    if (!isDelegate && actor.role !== "ADMIN") throw forbidden("You are not the current approver for this request");
  }
  return { request, step };
}

// Shared by POST /requests/:id/approve and the email-approval flow.
export async function performOvertimeRequestApprove(requestId: string, actor: { userId: string; role: string }, comments?: string | null) {
  const { request, isFinal } = await withTransaction(async (client) => {
    const { request, step } = await assertCurrentRequestApprover(requestId, actor, client);
    if (request.status !== "SUBMITTED") throw badRequest("Request is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE overtime_request_approval_steps SET status='APPROVED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments ?? null]);

    const totalStepsRows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM overtime_request_approval_steps WHERE request_id=$1 AND route_version=$2`, [requestId, request.current_route_version]);
    const isFinal = request.current_step_order >= Number(totalStepsRows.rows[0].count);

    if (isFinal) {
      await client.query(`UPDATE overtime_requests SET status='APPROVED', updated_at=now() WHERE id=$1`, [requestId]);
    } else {
      await client.query(`UPDATE overtime_requests SET current_step_order=current_step_order+1, updated_at=now() WHERE id=$1`, [requestId]);
    }
    return { request, isFinal };
  });

  await writeOvertimeAudit({ actorId: actor.userId, entityType: "overtime_requests", entityId: requestId, action: "REQUEST_STEP_APPROVED", after: { step_order: request.current_step_order, comments } });

  if (!isFinal) {
    const nextStep = (await query<any>(`SELECT * FROM overtime_request_approval_steps WHERE request_id=$1 AND route_version=$2 AND step_order=$3`, [requestId, request.current_route_version, request.current_step_order + 1]))[0];
    const employee = await getUserContact(request.employee_id);
    const nextApprover = nextStep ? await getUserContact(nextStep.approver_user_id) : null;
    if (nextStep && nextApprover) {
      void notifyOvertimeRequestSubmitted({
        requestId, requestNo: request.request_no, employeeName: employee?.full_name || null,
        approverName: nextApprover.full_name, approverEmail: nextApprover.email, title: nextStep.title,
        approverId: nextStep.approver_user_id, stepOrder: request.current_step_order + 1, routeVersion: request.current_route_version
      });
    }
  }
  return { status: isFinal ? "APPROVED" : "SUBMITTED", isFinal };
}

overtimeRouter.post("/requests/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const comments = String(req.body?.comments || "").trim() || null;
    const { isFinal } = await performOvertimeRequestApprove(req.params.id, { userId: req.user!.userId, role: req.user!.role }, comments);
    return res.json({ ok: true, final: isFinal });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /requests/:id/reject and the email-approval flow.
export async function performOvertimeRequestReject(requestId: string, actor: { userId: string; role: string }, comments: string) {
  const { request } = await withTransaction(async (client) => {
    const { request, step } = await assertCurrentRequestApprover(requestId, actor, client);
    if (request.status !== "SUBMITTED") throw badRequest("Request is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE overtime_request_approval_steps SET status='REJECTED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments]);
    await client.query(`UPDATE overtime_requests SET status='REJECTED', updated_at=now() WHERE id=$1`, [requestId]);
    return { request };
  });
  await writeOvertimeAudit({ actorId: actor.userId, entityType: "overtime_requests", entityId: requestId, action: "REQUEST_REJECTED", after: { comments } });

  const employee = await getUserContact(request.employee_id);
  void notifyOvertimeRequestReturned({
    requestId, requestNo: request.request_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
    reason: comments, action: "REJECTED"
  });
  return { status: "REJECTED" };
}

overtimeRouter.post("/requests/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to reject");
    await performOvertimeRequestReject(req.params.id, { userId: req.user!.userId, role: req.user!.role }, body.data.comments);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/requests/:id/send-back", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to send back");

    const { request } = await withTransaction(async (client) => {
      const { request, step } = await assertCurrentRequestApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (request.status !== "SUBMITTED") throw badRequest("Request is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

      await client.query(`UPDATE overtime_request_approval_steps SET status='SENT_BACK', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, body.data.comments]);
      await client.query(
        `UPDATE overtime_requests SET status='DRAFT', current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return { request };
    });
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_requests", entityId: req.params.id, action: "REQUEST_SENT_BACK", after: { comments: body.data.comments } });

    const employee = await getUserContact(request.employee_id);
    void notifyOvertimeRequestReturned({
      requestId: req.params.id, requestNo: request.request_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_LINE_SCHEMA = z.object({
  date: z.string(),
  day: z.string().optional(),
  from_time: z.string(),
  to_time: z.string(),
  ordered_by: z.string().optional(),
  observed_holiday: z.boolean().optional(),
  account_number: z.string().optional(),
  account_name: z.string().optional(),
  // Client-computed preview values — always overwritten server-side at
  // submit (see recomputeClaimLines) but accepted here so Save Draft can
  // still show a consistent preview before the first authoritative pass.
  hours_125: z.coerce.number().nonnegative().default(0),
  hours_150: z.coerce.number().nonnegative().default(0),
  hours_200: z.coerce.number().nonnegative().default(0),
  converted_hours: z.coerce.number().nonnegative().default(0)
});

function isClaimOwner(claim: any, userId: string) {
  return claim.employee_id === userId || claim.created_by_id === userId;
}

async function loadClaimDetail(claimId: string) {
  const claim = (await query<any>(
    `SELECT c.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title
       FROM overtime_claims c JOIN users u ON u.id = c.employee_id
      WHERE c.id=$1`,
    [claimId]
  ))[0];
  if (!claim) return null;
  const steps = await query<any>(
    `SELECT s.*, u.full_name AS approver_name FROM overtime_claim_approval_steps s
       JOIN users u ON u.id = s.approver_user_id
      WHERE s.claim_id=$1 AND s.route_version=$2 ORDER BY s.step_order`,
    [claimId, claim.current_route_version]
  );
  const routeHistory =
    claim.current_route_version > 1
      ? await query<any>(
          `SELECT s.*, u.full_name AS approver_name FROM overtime_claim_approval_steps s
             JOIN users u ON u.id = s.approver_user_id
            WHERE s.claim_id=$1 AND s.route_version < $2 ORDER BY s.route_version, s.step_order`,
          [claimId, claim.current_route_version]
        )
      : [];
  const orgPath = await getUserOrgPath(claim.employee_id);
  const sourceRequest = claim.overtime_request_id
    ? (await query<{ id: string; request_no: string }>(`SELECT id, request_no FROM overtime_requests WHERE id=$1`, [claim.overtime_request_id]))[0]
    : null;
  return { ...claim, approval_steps: steps, route_history: routeHistory, org_path: orgPath, source_request: sourceRequest };
}

const CLAIM_LIST_SELECT = `
  SELECT c.*, u.full_name AS employee_name, cs.title AS current_step_title
    FROM overtime_claims c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN overtime_claim_approval_steps cs
      ON cs.claim_id = c.id AND cs.route_version = c.current_route_version AND cs.step_order = c.current_step_order
`;

overtimeRouter.get("/claims", async (req: AuthedRequest, res, next) => {
  try {
    const rows =
      req.user!.role === "ADMIN"
        ? await query<any>(`${CLAIM_LIST_SELECT} ORDER BY c.created_at DESC`)
        : await query<any>(`${CLAIM_LIST_SELECT} WHERE c.employee_id=$1 OR c.created_by_id=$1 ORDER BY c.created_at DESC`, [req.user!.userId]);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadClaimDetail(req.params.id);
    if (!claim) throw notFound();
    const isOwner = isClaimOwner(claim, req.user!.userId);
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_CLAIM");
    const isApprover = (claim.approval_steps as any[]).some((s) => s.approver_user_id === req.user!.userId || delegatedFor.includes(s.approver_user_id));
    const isFinance = await isCompensationFinanceUser(req);
    if (!isOwner && !isApprover && !isFinance && req.user!.role !== "ADMIN") throw forbidden();
    const currentStep = (claim.approval_steps as any[]).find((s) => s.step_order === claim.current_step_order);
    const isCurrentApprover = Boolean(currentStep && (currentStep.approver_user_id === req.user!.userId || delegatedFor.includes(currentStep.approver_user_id)));
    const can_view_pdf = await canAccessPdf({ requestType: "OVERTIME_CLAIM", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" });
    // Hide the rate/amount Finance has set until Finance actually enters it —
    // "sensitive compensation data must not be exposed... without finance/HR
    // privileges" — everyone else sees it only once it's been processed.
    const canSeeAmount = isFinance || ["PAYMENT_PENDING", "CLOSED"].includes(claim.status);
    return res.json({
      ...claim,
      hourly_rate: canSeeAmount ? claim.hourly_rate : null,
      total_amount: canSeeAmount ? claim.total_amount : null,
      is_owner: isOwner,
      is_current_approver: isCurrentApprover,
      is_finance: isFinance,
      can_view_pdf
    });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/claims/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadClaimDetail(req.params.id);
    if (!claim) throw notFound();
    const isOwner = isClaimOwner(claim, req.user!.userId);
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_CLAIM");
    const isApprover = (claim.approval_steps as any[]).some((s) => s.approver_user_id === req.user!.userId || delegatedFor.includes(s.approver_user_id));
    const isFinance = await isCompensationFinanceUser(req);
    if (!isOwner && !isApprover && !isFinance && req.user!.role !== "ADMIN") throw forbidden();
    if (!(await canAccessPdf({ requestType: "OVERTIME_CLAIM", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }
    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'OVERTIME_CLAIM' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for overtime claims yet.");
    const data = await resolveOvertimeClaimPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("OVERTIME_CLAIM");
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="overtime-claim-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// Generates a DRAFT claim from an APPROVED request's lines (actual time if
// captured, else estimated), maintaining traceability via
// overtime_request_id — "reduce duplicate data entry" per spec.
overtimeRouter.post("/requests/:id/generate-claim", requireFeatureAccess("overtime_claim", ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"]), async (req: AuthedRequest, res, next) => {
  try {
    const request = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!request) throw notFound();
    if (!isRequestOwner(request, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (request.status !== "APPROVED") throw badRequest("Only an approved request can generate a claim");

    // REJECTED is excluded so a formally-rejected claim doesn't permanently
    // block ever generating a new one against this (already-approved) request.
    const existing = (await query<{ id: string }>(`SELECT id FROM overtime_claims WHERE overtime_request_id=$1 AND status <> 'REJECTED'`, [req.params.id]))[0];
    if (existing) return res.json({ id: existing.id });

    const requestLines: any[] = Array.isArray(request.lines) ? request.lines : [];
    const claimLines = requestLines.map((l) => ({
      date: l.date,
      from_time: l.actual_start || l.estimated_start || "00:00",
      to_time: l.actual_end || l.estimated_end || "00:00",
      ordered_by: "",
      observed_holiday: false,
      account_number: "",
      account_name: ""
    }));
    const { lines, totalOvertime, convertedHours, equivalentDays } = await recomputeClaimLines(claimLines);

    const claimNo = await nextClaimNo();
    const rows = await query<{ id: string }>(
      `INSERT INTO overtime_claims (claim_no, employee_id, created_by_id, overtime_request_id, year, month, lines, total_overtime, converted_hours, equivalent_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [claimNo, request.employee_id, req.user!.userId, req.params.id, request.year, request.month, JSON.stringify(lines), totalOvertime, convertedHours, equivalentDays]
    );
    return res.status(201).json({ id: rows[0].id, claim_no: claimNo });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.patch("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isClaimOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Only a draft claim can be edited");

    const body = z
      .object({
        lines: z.array(CLAIM_LINE_SCHEMA).optional(),
        compensation_preference: z.enum(["PAY", "DAYS"]).optional(),
        approval_route: APPROVAL_ROUTE_SCHEMA.optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid claim update", body.error.flatten());

    if (body.data.lines) {
      const { lines, totalOvertime, convertedHours, equivalentDays } = await recomputeClaimLines(body.data.lines);
      await query(
        `UPDATE overtime_claims SET lines=$1, total_overtime=$2, converted_hours=$3, equivalent_days=$4, updated_at=now() WHERE id=$5`,
        [JSON.stringify(lines), totalOvertime, convertedHours, equivalentDays, req.params.id]
      );
    }
    if (body.data.compensation_preference !== undefined) {
      await query(`UPDATE overtime_claims SET compensation_preference=$1, updated_at=now() WHERE id=$2`, [body.data.compensation_preference, req.params.id]);
    }
    if (body.data.approval_route) {
      // A claim owner can never name themself (or whoever prepared the
      // claim on their behalf) as their own approver.
      if (body.data.approval_route.some((step) => step.approver_user_id === claim.employee_id || step.approver_user_id === claim.created_by_id)) {
        throw badRequest("You cannot select yourself as an approver on your own claim");
      }
      await query(`DELETE FROM overtime_claim_approval_steps WHERE claim_id=$1 AND route_version=$2`, [req.params.id, claim.current_route_version]);
      let order = 1;
      for (const step of body.data.approval_route) {
        await query(
          `INSERT INTO overtime_claim_approval_steps (claim_id, route_version, step_order, approver_user_id, title) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, claim.current_route_version, order, step.approver_user_id, step.title]
        );
        order += 1;
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isClaimOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Claim has already been submitted");
    if (!claim.compensation_preference) throw badRequest("Choose a Compensation Preference (Pay or Days) before submitting");

    const period = (await query<{ status: string }>(`SELECT status FROM overtime_claim_periods WHERE year=$1 AND month=$2`, [claim.year, claim.month]))[0];
    if (!period || period.status !== "OPEN") {
      throw badRequest(`Claims for ${claim.month}/${claim.year} are not open yet — Admin or Finance need to open this claim period first.`);
    }

    const steps = await query<any>(
      `SELECT * FROM overtime_claim_approval_steps WHERE claim_id=$1 AND route_version=$2 ORDER BY step_order`,
      [req.params.id, claim.current_route_version]
    );
    if (!steps.length) throw badRequest("Add at least one approver to the Approval Route before submitting");

    await query(`UPDATE overtime_claims SET status='SUBMITTED', current_step_order=1, submitted_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_SUBMITTED" });

    const employee = await getUserContact(claim.employee_id);
    const firstApprover = await getUserContact(steps[0].approver_user_id);
    void notifyOvertimeClaimSubmitted({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null,
      approverName: firstApprover?.full_name || null, approverEmail: firstApprover?.email || null, title: steps[0].title,
      approverId: steps[0].approver_user_id, stepOrder: 1, routeVersion: claim.current_route_version
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims/:id/withdraw", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isClaimOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (!["DRAFT", "SUBMITTED"].includes(claim.status)) throw badRequest("Only a draft or submitted claim can be withdrawn");
    await query(`UPDATE overtime_claims SET status='WITHDRAWN', updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_WITHDRAWN" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/approvals", async (req: AuthedRequest, res, next) => {
  try {
    // Delegated items are flagged, not silently merged — same as the
    // generic Inbox does for Advance/Clearance and Standby's approvals.
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_CLAIM");
    const approverIds = [req.user!.userId, ...delegatedFor];
    const rows = await query<any>(
      `SELECT c.*, u.full_name AS employee_name, s.title AS my_title, s.approver_user_id
         FROM overtime_claims c
         JOIN overtime_claim_approval_steps s ON s.claim_id = c.id AND s.step_order = c.current_step_order AND s.route_version = c.current_route_version
         JOIN users u ON u.id = c.employee_id
        WHERE s.approver_user_id = ANY($1::uuid[]) AND s.status='PENDING'
        ORDER BY c.submitted_at`,
      [approverIds]
    );
    const delegatingManagerNames = delegatedFor.length
      ? new Map((await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [delegatedFor])).map((u) => [u.id, u.full_name]))
      : new Map<string, string | null>();
    return res.json(rows.map((r) => ({
      ...r,
      is_delegated: r.approver_user_id !== req.user!.userId,
      delegated_from_manager_name: r.approver_user_id !== req.user!.userId ? delegatingManagerNames.get(r.approver_user_id) ?? null : null
    })));
  } catch (err) {
    return next(err);
  }
});

// Same fix as assertCurrentRequestApprover above — locks the claim row and
// re-reads current_step_order/current_route_version fresh inside it.
async function assertCurrentClaimApprover(claimId: string, actor: { userId: string; role: string }, client: PoolClient) {
  const claimRows = await client.query<any>(`SELECT * FROM overtime_claims WHERE id=$1 FOR UPDATE`, [claimId]);
  const claim = claimRows.rows[0];
  if (!claim) throw notFound();
  const stepRows = await client.query<any>(
    `SELECT * FROM overtime_claim_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`,
    [claimId, claim.current_route_version, claim.current_step_order]
  );
  const step = stepRows.rows[0];
  if (!step || step.approver_user_id !== actor.userId) {
    const delegatedFor = actor.role !== "ADMIN" ? await getDelegatedManagerIds(actor.userId, "OVERTIME_CLAIM") : [];
    const isDelegate = Boolean(step && delegatedFor.includes(step.approver_user_id));
    if (!isDelegate && actor.role !== "ADMIN") throw forbidden("You are not the current approver for this claim");
  }
  return { claim, step };
}

// Shared by POST /claims/:id/approve and the email-approval flow.
export async function performOvertimeClaimApprove(claimId: string, actor: { userId: string; role: string }, comments?: string | null) {
  const { claim, isFinal } = await withTransaction(async (client) => {
    const { claim, step } = await assertCurrentClaimApprover(claimId, actor, client);
    if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE overtime_claim_approval_steps SET status='APPROVED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments ?? null]);

    const totalStepsRows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM overtime_claim_approval_steps WHERE claim_id=$1 AND route_version=$2`, [claimId, claim.current_route_version]);
    const isFinal = claim.current_step_order >= Number(totalStepsRows.rows[0].count);

    if (isFinal) {
      await client.query(`UPDATE overtime_claims SET status='FINANCE_PROCESSING', updated_at=now() WHERE id=$1`, [claimId]);
    } else {
      await client.query(`UPDATE overtime_claims SET current_step_order=current_step_order+1, updated_at=now() WHERE id=$1`, [claimId]);
    }
    return { claim, isFinal };
  });

  await writeOvertimeAudit({ actorId: actor.userId, entityType: "overtime_claims", entityId: claimId, action: "CLAIM_STEP_APPROVED", after: { step_order: claim.current_step_order, comments } });

  if (isFinal) {
    const employee = await getUserContact(claim.employee_id);
    void notifyOvertimeClaimFinanceReady({ claimId, claimNo: claim.claim_no, employeeName: employee?.full_name || null });
  } else {
    const nextStep = (await query<any>(`SELECT * FROM overtime_claim_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`, [claimId, claim.current_route_version, claim.current_step_order + 1]))[0];
    const employee = await getUserContact(claim.employee_id);
    const nextApprover = nextStep ? await getUserContact(nextStep.approver_user_id) : null;
    if (nextStep && nextApprover) {
      void notifyOvertimeClaimSubmitted({
        claimId, claimNo: claim.claim_no, employeeName: employee?.full_name || null,
        approverName: nextApprover.full_name, approverEmail: nextApprover.email, title: nextStep.title,
        approverId: nextStep.approver_user_id, stepOrder: claim.current_step_order + 1, routeVersion: claim.current_route_version
      });
    }
  }
  return { status: isFinal ? "FINANCE_PROCESSING" : "SUBMITTED", isFinal };
}

overtimeRouter.post("/claims/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const comments = String(req.body?.comments || "").trim() || null;
    const { isFinal } = await performOvertimeClaimApprove(req.params.id, { userId: req.user!.userId, role: req.user!.role }, comments);
    return res.json({ ok: true, finance: isFinal });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /claims/:id/reject and the email-approval flow.
export async function performOvertimeClaimReject(claimId: string, actor: { userId: string; role: string }, comments: string) {
  const { claim } = await withTransaction(async (client) => {
    const { claim, step } = await assertCurrentClaimApprover(claimId, actor, client);
    if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE overtime_claim_approval_steps SET status='REJECTED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments]);
    await client.query(`UPDATE overtime_claims SET status='REJECTED', updated_at=now() WHERE id=$1`, [claimId]);
    return { claim };
  });
  await writeOvertimeAudit({ actorId: actor.userId, entityType: "overtime_claims", entityId: claimId, action: "CLAIM_REJECTED", after: { comments } });

  const employee = await getUserContact(claim.employee_id);
  void notifyOvertimeClaimReturned({
    claimId, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
    reason: comments, action: "REJECTED"
  });
  return { status: "REJECTED" };
}

overtimeRouter.post("/claims/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to reject");
    await performOvertimeClaimReject(req.params.id, { userId: req.user!.userId, role: req.user!.role }, body.data.comments);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims/:id/send-back", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to send back");

    const { claim } = await withTransaction(async (client) => {
      const { claim, step } = await assertCurrentClaimApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

      await client.query(`UPDATE overtime_claim_approval_steps SET status='SENT_BACK', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, body.data.comments]);
      await client.query(
        `UPDATE overtime_claims SET status='DRAFT', current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return { claim };
    });
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_SENT_BACK", after: { comments: body.data.comments } });

    const employee = await getUserContact(claim.employee_id);
    void notifyOvertimeClaimReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true, comments: body.data.comments });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Finance — shares Finance authority + the governed cost-centre/account list
// with Standby (isCompensationFinanceUser, standby_finance_codes) so there
// is one Finance authority list rather than a separate one per module.
// ---------------------------------------------------------------------------

overtimeRouter.get("/finance/queue", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const status = String(req.query.status || "").trim().toUpperCase();
    const filters = ["c.status IN ('FINANCE_PROCESSING','PAYMENT_PENDING','CLOSED')"];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      filters.push(`c.status=$${params.length}`);
    }
    const rows = await query<any>(
      `SELECT c.*, u.full_name AS employee_name, t.name AS team_name
         FROM overtime_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN teams t ON t.id = u.team_id
        WHERE ${filters.join(" AND ")}
        ORDER BY c.submitted_at`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims/:id/finance-process", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (claim.status !== "FINANCE_PROCESSING") throw badRequest("Claim is not awaiting Finance processing");

    const body = z
      .object({
        hourly_rate: z.coerce.number().nonnegative(),
        cost_centre: z.string().trim().optional(),
        account_project: z.string().trim().optional(),
        payroll_period: z.string().trim().optional(),
        finance_reference: z.string().trim().optional(),
        finance_comments: z.string().trim().optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid finance processing payload", body.error.flatten());

    for (const [kind, value] of [
      ["COST_CENTRE", body.data.cost_centre],
      ["ACCOUNT_PROJECT", body.data.account_project]
    ] as const) {
      if (!value) continue;
      const activeCodes = await query<{ name: string }>(`SELECT name FROM standby_finance_codes WHERE kind=$1 AND active=true`, [kind]);
      if (activeCodes.length > 0 && !activeCodes.some((c) => c.name === value)) {
        throw badRequest(`"${value}" is not a configured ${kind === "COST_CENTRE" ? "cost centre" : "account/project"}`);
      }
    }

    const calculatedAmount = claim.compensation_preference === "DAYS" ? null : Math.round(Number(claim.converted_hours) * body.data.hourly_rate * 100) / 100;

    await query(
      `UPDATE overtime_claims SET
         hourly_rate=$1, total_amount=$2, cost_centre=$3, account_project=$4,
         payroll_period=$5, finance_reference=$6, finance_comments=$7,
         status='PAYMENT_PENDING', finance_processed_at=now(), updated_at=now()
       WHERE id=$8`,
      [
        body.data.hourly_rate, calculatedAmount, body.data.cost_centre || null, body.data.account_project || null,
        body.data.payroll_period || null, body.data.finance_reference || null, body.data.finance_comments || null, req.params.id
      ]
    );
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_FINANCE_PROCESSED", after: { ...body.data, calculated_amount: calculatedAmount } });

    const employee = await getUserContact(claim.employee_id);
    void notifyOvertimeClaimProcessed({ claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null, amount: calculatedAmount || 0 });
    return res.json({ ok: true, calculated_amount: calculatedAmount });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims/:id/finance-return", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const body = z.object({ comments: z.string().trim().min(1, "A reason is required") }).safeParse(req.body);
    if (!body.success) throw badRequest("A reason is required to return a claim");
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!["FINANCE_PROCESSING", "PAYMENT_PENDING"].includes(claim.status)) throw badRequest("Claim is not with Finance");

    await query(
      `UPDATE overtime_claims SET status='DRAFT', finance_comments=$2, current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
      [req.params.id, body.data.comments]
    );
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_FINANCE_RETURNED", after: { comments: body.data.comments } });

    const employee = await getUserContact(claim.employee_id);
    void notifyOvertimeClaimReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Settles a PAYMENT_PENDING claim — PAY closes it out as a payment, DAYS as
// a time-credit, per compensation_preference. Self-contained, same as
// Standby's "mark paid" — not integrated with the generic Payments module.
overtimeRouter.post("/claims/:id/mark-settled", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const claim = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (claim.status !== "PAYMENT_PENDING") throw badRequest("Claim is not awaiting settlement");

    await query(`UPDATE overtime_claims SET status='CLOSED', paid_at=now(), closed_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claims", entityId: req.params.id, action: "CLAIM_SETTLED" });

    const employee = await getUserContact(claim.employee_id);
    void notifyOvertimeClaimSettled({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      amount: Number(claim.total_amount || 0), preference: claim.compensation_preference
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Eligible approvers — generic active-user search, identical query to
// Standby's /standby/eligible-approvers (duplicated rather than shared
// cross-module, consistent with this app's per-module-router convention).
// ---------------------------------------------------------------------------

overtimeRouter.get("/eligible-approvers", async (req: AuthedRequest, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    if (search.length < 2) return res.json([]);
    const rows = await query<any>(
      `SELECT id, full_name, employee_no, title, role, department
         FROM users
        WHERE is_active=true AND id <> $1
          AND (full_name ILIKE $2 OR employee_no ILIKE $2)
        ORDER BY full_name LIMIT 20`,
      [req.user!.userId, `%${search}%`]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Public holiday calendar (Admin & Finance) — drives the 200% rate bucket.
// Admin assigns which sections carry Finance authority
// (isCompensationFinanceUser); anyone in one of those sections can manage
// the calendar alongside Admin, same authority as Overtime Finance
// processing — no separate permission concept.
// ---------------------------------------------------------------------------

async function requireHolidayManager(req: AuthedRequest) {
  if (req.user!.role === "ADMIN") return;
  if (await isCompensationFinanceUser(req)) return;
  throw forbidden("Only an administrator or Finance can manage the public holiday calendar");
}

overtimeRouter.get("/public-holidays", async (req: AuthedRequest, res, next) => {
  try {
    // Cast to text: node-postgres parses `date` columns using the server's
    // local timezone, not UTC, so a bare `SELECT *` here serializes each date
    // as a full ISO timestamp that's shifted a day off in any timezone ahead
    // of UTC (e.g. 2025-01-01 becomes "2024-12-31T22:00:00.000Z" at UTC+2).
    const rows = await query<any>(
      `SELECT id, holiday_date::text AS holiday_date, observed_date::text AS observed_date, name, active FROM public_holidays ORDER BY holiday_date`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/public-holidays", async (req: AuthedRequest, res, next) => {
  try {
    await requireHolidayManager(req);
    const body = z
      .object({
        holiday_date: z.string(),
        name: z.string().trim().min(1).max(120),
        observed_date: z.string().nullable().optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid holiday payload", body.error.flatten());
    if (body.data.observed_date && body.data.observed_date === body.data.holiday_date) {
      throw badRequest("The observed date must be different from the gazetted date");
    }
    const rows = await query<{ id: string }>(
      `INSERT INTO public_holidays (holiday_date, name, observed_date) VALUES ($1,$2,$3)
       ON CONFLICT (holiday_date) DO UPDATE SET name=EXCLUDED.name, observed_date=EXCLUDED.observed_date, active=true RETURNING id`,
      [body.data.holiday_date, body.data.name, body.data.observed_date || null]
    );
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "public_holidays", entityId: rows[0].id, action: "HOLIDAY_CREATED", after: body.data });
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

// Sets (or clears, with observed_date: null) just the observed date on an
// existing holiday — the "move to weekday" action, separate from re-creating
// the whole holiday row.
overtimeRouter.patch("/public-holidays/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireHolidayManager(req);
    const body = z.object({ observed_date: z.string().nullable() }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());
    const holiday = (await query<{ holiday_date: string }>(`SELECT holiday_date::text AS holiday_date FROM public_holidays WHERE id=$1`, [req.params.id]))[0];
    if (!holiday) throw notFound();
    if (body.data.observed_date && body.data.observed_date === holiday.holiday_date) {
      throw badRequest("The observed date must be different from the gazetted date");
    }
    await query(`UPDATE public_holidays SET observed_date=$1 WHERE id=$2`, [body.data.observed_date || null, req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "public_holidays", entityId: req.params.id, action: "HOLIDAY_OBSERVED_DATE_SET", after: body.data });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.delete("/public-holidays/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireHolidayManager(req);
    await query(`DELETE FROM public_holidays WHERE id=$1`, [req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "public_holidays", entityId: req.params.id, action: "HOLIDAY_DELETED" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Claim periods (Admin & Finance) — a year+month must be OPEN before an
// employee can submit an Overtime Claim for it; see the check inside
// POST /claims/:id/submit. Requests are unaffected.
// ---------------------------------------------------------------------------

overtimeRouter.get("/claim-periods", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT p.*, ou.full_name AS opened_by_name, cu.full_name AS closed_by_name
       FROM overtime_claim_periods p
       LEFT JOIN users ou ON ou.id = p.opened_by_id
       LEFT JOIN users cu ON cu.id = p.closed_by_id
      ORDER BY p.year DESC, p.month DESC`);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claim-periods", async (req: AuthedRequest, res, next) => {
  try {
    await requireHolidayManager(req);
    const body = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid period payload", body.error.flatten());
    const rows = await query<{ id: string }>(
      `INSERT INTO overtime_claim_periods (year, month, status, opened_by_id, opened_at)
       VALUES ($1,$2,'OPEN',$3,now())
       ON CONFLICT (year, month) DO UPDATE SET status='OPEN', opened_by_id=$3, opened_at=now(), closed_by_id=NULL, closed_at=NULL
       RETURNING id`,
      [body.data.year, body.data.month, req.user!.userId]
    );
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claim_periods", entityId: rows[0].id, action: "CLAIM_PERIOD_OPENED", after: body.data });
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claim-periods/:id/close", async (req: AuthedRequest, res, next) => {
  try {
    await requireHolidayManager(req);
    const period = (await query<{ id: string }>(`SELECT id FROM overtime_claim_periods WHERE id=$1`, [req.params.id]))[0];
    if (!period) throw notFound();
    await query(`UPDATE overtime_claim_periods SET status='CLOSED', closed_by_id=$1, closed_at=now() WHERE id=$2`, [req.user!.userId, req.params.id]);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_claim_periods", entityId: req.params.id, action: "CLAIM_PERIOD_CLOSED" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Settings (ADMIN only to change) — rate percentages + working hours/day.
// ---------------------------------------------------------------------------

overtimeRouter.get("/settings", async (req: AuthedRequest, res, next) => {
  try {
    const rates = await getOvertimeRateSettings();
    return res.json({
      rate_weekday_pct: rates.weekdayPct,
      rate_saturday_pct: rates.saturdayPct,
      rate_sunday_holiday_pct: rates.sundayHolidayPct,
      working_hours_per_day: rates.workingHoursPerDay
    });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can change Overtime settings");
    const body = z
      .object({
        rate_weekday_pct: z.coerce.number().min(100).max(500),
        rate_saturday_pct: z.coerce.number().min(100).max(500),
        rate_sunday_holiday_pct: z.coerce.number().min(100).max(500),
        working_hours_per_day: z.coerce.number().min(1).max(24)
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid settings payload", body.error.flatten());
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateWeekdayPct, body.data.rate_weekday_pct);
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateSaturdayPct, body.data.rate_saturday_pct);
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.overtimeRateSundayHolidayPct, body.data.rate_sunday_holiday_pct);
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.workingHoursPerDay, body.data.working_hours_per_day);
    await writeOvertimeAudit({ actorId: req.user!.userId, entityType: "overtime_settings", entityId: req.user!.userId, action: "SETTINGS_UPDATED", after: body.data });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

overtimeRouter.get("/reports/summary", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN" && !(await isCompensationFinanceUser(req))) throw forbidden();

    const byStatus = await query<any>(`SELECT status, count(*)::int AS count FROM overtime_claims GROUP BY status`);
    const byPreference = await query<any>(
      `SELECT compensation_preference, count(*)::int AS count, COALESCE(SUM(total_amount),0)::numeric(14,2) AS total_amount
         FROM overtime_claims WHERE status='CLOSED' GROUP BY compensation_preference`
    );
    const byRateCategory = await query<any>(
      `SELECT
         COALESCE(SUM((l->>'hours_125')::numeric),0)::numeric(12,2) AS hours_125,
         COALESCE(SUM((l->>'hours_150')::numeric),0)::numeric(12,2) AS hours_150,
         COALESCE(SUM((l->>'hours_200')::numeric),0)::numeric(12,2) AS hours_200
       FROM overtime_claims c, jsonb_array_elements(c.lines) l
       WHERE c.status <> 'DRAFT'`
    );
    const allowanceRows = await query<any>(
      `SELECT c.claim_no, u.full_name AS employee_name, u.employee_no, u.title AS job_title,
              c.total_overtime, c.converted_hours, c.total_amount, c.compensation_preference, c.status
         FROM overtime_claims c JOIN users u ON u.id = c.employee_id
        WHERE c.status <> 'DRAFT'
        ORDER BY c.submitted_at DESC`
    );

    return res.json({ by_status: byStatus, by_preference: byPreference, by_rate_category: byRateCategory[0] || { hours_125: 0, hours_150: 0, hours_200: 0 }, allowance_rows: allowanceRows });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

overtimeRouter.get("/dashboard", async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();

    const thisMonthRequests = await query<{ lines: any }>(
      `SELECT lines FROM overtime_requests WHERE employee_id=$1 AND year=$2 AND month=$3`,
      [userId, now.getFullYear(), now.getMonth() + 1]
    );
    const estimatedHoursThisMonth = thisMonthRequests
      .flatMap((r) => (Array.isArray(r.lines) ? r.lines : []))
      .reduce((sum: number, l: any) => sum + hoursBetween(l.estimated_start, l.estimated_end), 0);

    const convertedThisMonth = (await query<{ total: string }>(
      `SELECT COALESCE(SUM(converted_hours),0)::text AS total FROM overtime_claims WHERE employee_id=$1 AND year=$2 AND month=$3`,
      [userId, now.getFullYear(), now.getMonth() + 1]
    ))[0];

    const pendingApprovals = (await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM overtime_claim_approval_steps s
         JOIN overtime_claims c ON c.id = s.claim_id AND s.route_version = c.current_route_version AND s.step_order = c.current_step_order
        WHERE s.approver_user_id=$1 AND s.status='PENDING'`,
      [userId]
    ))[0];

    const approvedYtd = (await query<{ total: string }>(
      `SELECT COALESCE(SUM(converted_hours),0)::text AS total FROM overtime_claims
        WHERE employee_id=$1 AND year=$2 AND status NOT IN ('DRAFT','REJECTED','WITHDRAWN')`,
      [userId, now.getFullYear()]
    ))[0];

    const paidYtd = (await query<{ total: string }>(
      `SELECT COALESCE(SUM(total_amount),0)::text AS total FROM overtime_claims WHERE employee_id=$1 AND year=$2 AND status='CLOSED'`,
      [userId, now.getFullYear()]
    ))[0];

    const recentClaims = await query<any>(
      `SELECT id, claim_no, year, month, status FROM overtime_claims WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [userId]
    );

    return res.json({
      estimated_hours_this_month: Math.round(estimatedHoursThisMonth * 100) / 100,
      converted_hours_this_month: Number(convertedThisMonth.total),
      pending_approvals: Number(pendingApprovals.count),
      approved_ytd_converted_hours: Number(approvedYtd.total),
      paid_ytd_amount: Number(paidYtd.total),
      recent_claims: recentClaims,
      is_finance: await isCompensationFinanceUser(req)
    });
  } catch (err) {
    return next(err);
  }
});
