import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, isFinanceDept, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { advanceWorkflowStep, createAdvance, getAdvanceById, nextStatusOrThrow, setAdvanceStatus } from "./advances.service.js";
import { canCreateAdvanceOnBehalf, getUserAccountState, isPermanentEmployee, isProfileComplete } from "../../lib/userProfile.js";
import type { AdvanceStatus } from "./advances.types.js";
import { notifyAdvanceCancelled, notifyAdvancePaid, notifyAdvanceReminder, notifyAdvanceTask } from "../../lib/notifications.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";
import { assertAdvanceTypeAllowed, getTravelRateForCode, getTravelTypeByCode, isTravelAdvanceType } from "../../lib/travel.js";
import { getDepartmentLeadership } from "../../lib/departments.js";
import { canApproveStep, chainStepToStatus, getPendingGroup, hoursBetween, resolveWorkflowChain, type ChainStep } from "../../lib/workflowEngine.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";
import { buildAdvanceRequestPdf } from "../../lib/pdf/advanceFormPdf.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveAdvancePdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";

const ECOCASH_NUMBER_MESSAGE = "Invalid EcoCash number format. Use 7-15 digits, with optional + country code.";

function normalizeEcoCashNumber(value: string | undefined) {
  return String(value || "").trim().replace(/[\s-]/g, "");
}

function validateEcoCashNumber(data: { ecocash_number?: string; payment_account?: string }, ctx: z.RefinementCtx) {
  const num = normalizeEcoCashNumber(data.ecocash_number || data.payment_account);
  if (!num) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ecocash_number"], message: "EcoCash number is required" });
  } else if (!/^\+?\d{7,15}$/.test(num)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ecocash_number"], message: ECOCASH_NUMBER_MESSAGE });
  }
}

const CreateAdvanceSchema = z.object({
  type: z.string().trim().min(1, "type is required"),
  purpose: z.string().trim().min(1, "purpose is required"),
  project_number: z.string().optional(),
  payment_method: z.enum(["ECOCASH", "BANK"]).default("ECOCASH"),
  payment_account: z.string().optional(),
  ecocash_number: z.string().optional(),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_branch: z.string().optional(),
  requested_total: z.coerce.number().nonnegative(),
  beneficiary_user_id: z.string().uuid().optional(),
  override_chain: z.array(z.object({
    label: z.string().trim().min(1),
    user_id: z.string().uuid(),
    user_name: z.string()
  })).optional()
}).superRefine((data, ctx) => {
  if (data.payment_method === "ECOCASH") {
    validateEcoCashNumber(data, ctx);
  }
  if (data.payment_method === "BANK") {
    if (!String(data.bank_name || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_name"], message: "Bank is required" });
    }
    if (!String(data.bank_account_number || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_account_number"], message: "Bank account number is required" });
    }
    if (!String(data.bank_branch || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_branch"], message: "Bank branch is required" });
    }
  }
});

const UpdateAdvanceSchema = z.object({
  type: z.string().trim().min(1, "type cannot be empty").optional(),
  purpose: z.string().trim().min(1, "purpose cannot be empty").optional(),
  project_number: z.string().optional(),
  payment_method: z.enum(["ECOCASH", "BANK"]).optional(),
  payment_account: z.string().optional(),
  ecocash_number: z.string().optional(),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_branch: z.string().optional(),
  requested_total: z.coerce.number().nonnegative().optional(),
  salary_month: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.payment_method === "ECOCASH") {
    validateEcoCashNumber(data, ctx);
  }
  if (data.payment_method === "BANK") {
    if (!String(data.bank_name || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_name"], message: "Bank is required" });
    }
    if (!String(data.bank_account_number || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_account_number"], message: "Bank account number is required" });
    }
    if (!String(data.bank_branch || "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_branch"], message: "Bank branch is required" });
    }
  }
});

const LinesSchema = z.object({
  lines: z
    .array(
      z.object({
        line_date: z.string(),
        location: z.string().optional(),
        travel_meta: z.record(z.unknown()).optional(),
        meals_count: z.coerce.number().int().nonnegative().optional(),
        meal_value: z.coerce.number().nonnegative().optional(),
        lunch: z.coerce.number().nonnegative().default(0),
        dinner: z.coerce.number().nonnegative().default(0)
      })
    )
    .min(1, "At least one table entry is required")
});

const ApproveSchema = z.object({ approved_total: z.coerce.number().positive() });
const ActionCommentSchema = z.object({
  comments: z.string().trim().min(1, "comments are required")
});

export const advancesRouter = Router();
advancesRouter.use(requireAuth);

// Roll back / reject on legacy (non-workflow) advances: allowed for the usual
// approval-chain roles, or for anyone in the Finance department (org structure).
function requireAdvanceActionAccess(req: AuthedRequest, _res: import("express").Response, next: import("express").NextFunction) {
  const role = req.user!.role;
  if (["MANAGER", "HOD", "EXCO", "ADMIN"].includes(role) || isFinanceDept(req.user!.department)) return next();
  return next(forbidden());
}

function toPaymentAccount(args: {
  payment_method: "ECOCASH" | "BANK";
  payment_account?: string;
  ecocash_number?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch?: string;
}) {
  if (args.payment_method === "BANK") {
    const bank = String(args.bank_name || "").trim();
    const account = String(args.bank_account_number || "").trim();
    const branch = String(args.bank_branch || "").trim();
    return `BANK:${bank};ACCOUNT:${account};BRANCH:${branch}`;
  }
  return normalizeEcoCashNumber(args.ecocash_number || args.payment_account);
}

function toMoney(value: number) {
  return Number(value.toFixed(2));
}

export async function writeAdvanceAudit(args: {
  actorId: string;
  advanceId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1,$2,'advance_requests',$3,$4,$5)`,
    [args.actorId, args.action, args.advanceId, args.before ? JSON.stringify(args.before) : null, args.after ? JSON.stringify(args.after) : null]
  );
}

async function resolveAdvanceRequester(actorId: string, beneficiaryUserId?: string) {
  const actor = await getUserAccountState(actorId);
  if (!isProfileComplete(actor)) {
    throw badRequest("Complete your profile before requesting an advance");
  }

  const beneficiaryId = String(beneficiaryUserId || "").trim();
  if (!beneficiaryId || beneficiaryId === actor.id) {
    if (!isPermanentEmployee(actor)) {
      throw forbidden("Only permanent employees can request advances for themselves");
    }
    return { actor, requester: actor };
  }

  if (!canCreateAdvanceOnBehalf(actor)) {
    throw forbidden("You are not allowed to create advances on behalf of other employees");
  }

  const requester = await getUserAccountState(beneficiaryId);
  if (!requester.is_active) {
    throw badRequest("The selected employee is inactive");
  }
  if (!isProfileComplete(requester)) {
    throw badRequest("The selected employee must complete their profile before an advance can be created");
  }
  if (!["INTERN", "TEMPORARY"].includes(String(requester.employment_type || "").trim().toUpperCase())) {
    throw badRequest("On-behalf advances are only available for interns and temporary employees");
  }

  const actorDepartment = String(actor.department || "").trim();
  const requesterDepartment = String(requester.department || "").trim();
  if (!actorDepartment || !requesterDepartment || actorDepartment !== requesterDepartment) {
    throw forbidden("On-behalf advances must stay within the same department");
  }

  return { actor, requester };
}

export async function getAdvanceNotificationContext(advanceId: string) {
  return (
    await query<{ full_name: string | null; email: string | null; department: string | null; requested_total: string; approved_total: string; type: string; status: string; paid_reference: string | null }>(
      `SELECT u.full_name, u.email, u.department, ar.requested_total, ar.approved_total, ar.type, ar.status, ar.paid_reference
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
        WHERE ar.id = $1`,
      [advanceId]
    )
  )[0] ?? null;
}

export async function canViewAdvance(args: {
  role: string; requesterId: string; createdById: string; userId: string;
  approvalChain?: ChainStep[] | null; managerChainIds?: string[];
}) {
  if (args.role === "ADMIN") return true;
  if (args.requesterId === args.userId) return true;
  if (args.createdById === args.userId) return true;

  // Anyone in the workflow's resolved approval chain can view
  if (args.approvalChain?.length) {
    if (args.approvalChain.some(s => s.approver_id === args.userId)) return true;
    // "Team: X" (ANY_ONE) steps list the department HOD as approver_id for
    // routing purposes, but any member of that permission group is a real
    // participant in the chain and should be able to track the request.
    if (args.approvalChain.some(s => s.approval_group_name)) {
      const groups = await getUserGroups(args.userId);
      if (args.approvalChain.some(s => s.approval_group_name && groups.includes(s.approval_group_name))) return true;
    }
  }

  // Anyone in the requester's management chain (org structure) can view
  if (args.managerChainIds?.includes(args.userId)) return true;

  return false;
}

// ── SLA Report ──────────────────────────────────────────────────────────────
const SLA_TARGETS = { submission_hours: 48, approval_hours: 72, payment_hours: 48 };

advancesRouter.get("/sla-report", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const periodDays = Number(req.query.period_days || 90);

    const rows = await query<any>(
      `SELECT ar.id, ar.type, ar.status, ar.requested_total, ar.approved_total,
              ar.created_at, ar.submitted_at, ar.approved_at, ar.paid_at,
              u.full_name AS requester_name, u.department, u.division_id,
              dv.name AS division_name
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ar.created_at >= now() - ($1 || ' days')::interval
          ${!isAdmin ? "AND (ar.requester_id = $2 OR ar.created_by_id = $2)" : ""}
        ORDER BY ar.created_at DESC`,
      isAdmin ? [periodDays] : [periodDays, req.user!.userId]
    );

    // Compute per-request metrics
    const requests = rows.map((r: any) => {
      const submissionHrs = hoursBetween(r.created_at, r.submitted_at);
      const approvalHrs   = hoursBetween(r.submitted_at, r.approved_at);
      const paymentHrs    = hoursBetween(r.approved_at, r.paid_at);
      const totalHrs      = r.status === "CANCELLED"
        ? null
        : hoursBetween(r.created_at, r.paid_at ?? new Date().toISOString());

      // At-risk = still pending and approaching SLA limit (> 75%)
      const nowMs = Date.now();
      let slaStatus: "on_time" | "breached" | "at_risk" | "pending" = "pending";

      if (r.status === "CANCELLED") {
        slaStatus = "pending";
      } else if (r.status === "PAID") {
        const sub = submissionHrs ?? 0;
        const apr = approvalHrs ?? 0;
        const pay = paymentHrs ?? 0;
        slaStatus = sub <= SLA_TARGETS.submission_hours && apr <= SLA_TARGETS.approval_hours && pay <= SLA_TARGETS.payment_hours
          ? "on_time" : "breached";
      } else {
        // In-flight: check if we're overdue yet
        const pendingHrs = (nowMs - new Date(r.created_at).getTime()) / 3_600_000;
        const totalTarget = SLA_TARGETS.submission_hours + SLA_TARGETS.approval_hours + SLA_TARGETS.payment_hours;
        if (pendingHrs > totalTarget) slaStatus = "breached";
        else if (pendingHrs > totalTarget * 0.75) slaStatus = "at_risk";
      }

      return {
        id: r.id,
        type: r.type,
        status: r.status,
        requester_name: r.requester_name,
        department: r.department,
        division_name: r.division_name,
        requested_total: r.requested_total,
        approved_total: r.approved_total,
        created_at: r.created_at,
        submitted_at: r.submitted_at,
        approved_at: r.approved_at,
        paid_at: r.paid_at,
        submission_hours: submissionHrs,
        approval_hours: approvalHrs,
        payment_hours: paymentHrs,
        total_hours: totalHrs,
        sla_status: slaStatus,
      };
    });

    // Aggregations
    const summary = {
      total:    requests.length,
      on_time:  requests.filter((r: any) => r.sla_status === "on_time").length,
      at_risk:  requests.filter((r: any) => r.sla_status === "at_risk").length,
      breached: requests.filter((r: any) => r.sla_status === "breached").length,
      pending:  requests.filter((r: any) => r.sla_status === "pending").length,
    };

    const avgHrs = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
    const avgMetrics = {
      avg_submission_hours: avgHrs(requests.map((r: any) => r.submission_hours).filter((v: any) => v != null)),
      avg_approval_hours:   avgHrs(requests.map((r: any) => r.approval_hours).filter((v: any) => v != null)),
      avg_payment_hours:    avgHrs(requests.map((r: any) => r.payment_hours).filter((v: any) => v != null)),
    };

    const byDept: Record<string, { total: number; on_time: number; breached: number; at_risk: number }> = {};
    requests.forEach((r: any) => {
      const k = r.department || "Unassigned";
      if (!byDept[k]) byDept[k] = { total: 0, on_time: 0, breached: 0, at_risk: 0 };
      byDept[k].total++;
      if (r.sla_status === "on_time")  byDept[k].on_time++;
      if (r.sla_status === "breached") byDept[k].breached++;
      if (r.sla_status === "at_risk")  byDept[k].at_risk++;
    });

    const byType: Record<string, { total: number; on_time: number; breached: number; avg_total_hours: number | null }> = {};
    requests.forEach((r: any) => {
      const k = r.type || "Unknown";
      if (!byType[k]) byType[k] = { total: 0, on_time: 0, breached: 0, avg_total_hours: null };
      byType[k].total++;
      if (r.sla_status === "on_time") byType[k].on_time++;
      if (r.sla_status === "breached") byType[k].breached++;
    });
    Object.keys(byType).forEach((k) => {
      const hrs = requests.filter((r: any) => r.type === k && r.total_hours != null).map((r: any) => r.total_hours as number);
      byType[k].avg_total_hours = avgHrs(hrs);
    });

    return res.json({ sla_targets: SLA_TARGETS, summary, avg_metrics: avgMetrics, by_department: byDept, by_type: byType, requests });
  } catch (err) {
    return next(err);
  }
});

// ── Advance Clearance Recovery Policy ────────────────────────────────────────
// Admin-configurable clearance window + recovery period. This only computes
// and displays a figure for Finance/HR to act on manually — it never touches
// payroll or auto-deducts anything.
const RECOVERY_FEATURE_KEY = "advance_recovery_settings";

advancesRouter.get("/recovery-settings", requireAuth, requireFeatureAccess(RECOVERY_FEATURE_KEY, ["ADMIN", "FINANCE"]), async (_req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT clearance_duration_days, recovery_months, updated_at FROM advance_recovery_settings LIMIT 1`))[0];
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

const RecoverySettingsSchema = z.object({
  clearance_duration_days: z.coerce.number().int().min(1),
  recovery_months: z.coerce.number().int().min(1)
});

advancesRouter.put("/recovery-settings", requireAuth, requireFeatureAccess(RECOVERY_FEATURE_KEY, ["ADMIN", "FINANCE"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RecoverySettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid settings payload", parsed.error.flatten());
    await query(
      `UPDATE advance_recovery_settings SET clearance_duration_days=$1, recovery_months=$2, updated_by_id=$3, updated_at=now()`,
      [parsed.data.clearance_duration_days, parsed.data.recovery_months, req.user!.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Finance/HR/Admin confirms a paid, overdue advance will never be cleared —
// calculates (and stores) the monthly deduction figure it would be recovered
// over. Requires the advance to actually be overdue, and only once.
advancesRouter.post("/:id/confirm-not-cleared", requireAuth, requireFeatureAccess(RECOVERY_FEATURE_KEY, ["ADMIN", "FINANCE"]), async (req: AuthedRequest, res, next) => {
  try {
    const adv = (await query<any>(
      `SELECT ar.*, ${OVERDUE_SELECT}
         FROM advance_requests ar
         CROSS JOIN advance_recovery_settings ars
        WHERE ar.id=$1`,
      [req.params.id]
    ))[0];
    if (!adv) throw notFound();
    if (adv.not_cleared_confirmed_at) throw badRequest("Already confirmed as not cleared");
    if (!adv.is_overdue) throw badRequest("This advance is not overdue for clearance yet");

    const settings = (await query<{ recovery_months: number }>(`SELECT recovery_months FROM advance_recovery_settings LIMIT 1`))[0];
    const months = settings.recovery_months;
    const amount = Number((Number(adv.approved_total || adv.requested_total || 0) / months).toFixed(2));

    await query(
      `UPDATE advance_requests SET not_cleared_confirmed_at=now(), not_cleared_confirmed_by_id=$2,
         recovery_deduction_amount=$3, recovery_months_at_confirmation=$4
       WHERE id=$1`,
      [req.params.id, req.user!.userId, amount, months]
    );
    return res.json({ ok: true, recovery_deduction_amount: amount, recovery_months: months });
  } catch (err) {
    return next(err);
  }
});

// ── Finance Reconciliation Report ───────────────────────────────────────────
advancesRouter.get("/reconciliation-report", requireAuth, requireFeatureAccess("report_reconciliation", ["ADMIN", "FINANCE"]), async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultTo = now.toISOString().slice(0, 10);
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : defaultFrom;
    const to = typeof req.query.to === "string" && req.query.to ? req.query.to : defaultTo;
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw badRequest("from/to must be valid dates (YYYY-MM-DD)");
    }

    const rows = await query<any>(
      `WITH adv AS (
         SELECT requester_id AS user_id,
                SUM(CASE WHEN status = 'PAID' AND paid_at < $1 THEN approved_total ELSE 0 END) AS paid_before,
                SUM(CASE WHEN status = 'PAID' AND paid_at >= $1 AND paid_at <= $2 THEN approved_total ELSE 0 END) AS paid_in_period,
                SUM(CASE WHEN created_at >= $1 AND created_at <= $2 THEN requested_total ELSE 0 END) AS requested_in_period
           FROM advance_requests
          GROUP BY requester_id
       ),
       clm AS (
         SELECT claimant_id AS user_id,
                SUM(CASE WHEN status = 'SETTLED' AND settled_at < $1 THEN claim_total ELSE 0 END) AS settled_before,
                SUM(CASE WHEN status = 'SETTLED' AND settled_at >= $1 AND settled_at <= $2 THEN claim_total ELSE 0 END) AS settled_in_period
           FROM clearance_claims
          GROUP BY claimant_id
       )
       SELECT u.id AS requester_id, u.full_name AS requester_name, u.department,
              COALESCE(adv.paid_before, 0) - COALESCE(clm.settled_before, 0) AS opening_balance,
              COALESCE(adv.requested_in_period, 0) AS total_requested,
              COALESCE(adv.paid_in_period, 0) AS total_paid,
              COALESCE(clm.settled_in_period, 0) AS total_settled,
              (COALESCE(adv.paid_before, 0) - COALESCE(clm.settled_before, 0))
                + COALESCE(adv.paid_in_period, 0) - COALESCE(clm.settled_in_period, 0) AS closing_balance
         FROM users u
         LEFT JOIN adv ON adv.user_id = u.id
         LEFT JOIN clm ON clm.user_id = u.id
        WHERE (adv.user_id IS NOT NULL OR clm.user_id IS NOT NULL)
          AND (COALESCE(adv.paid_before, 0) <> 0 OR COALESCE(clm.settled_before, 0) <> 0
           OR COALESCE(adv.requested_in_period, 0) <> 0 OR COALESCE(adv.paid_in_period, 0) <> 0
           OR COALESCE(clm.settled_in_period, 0) <> 0)
        ORDER BY u.full_name`,
      [from + "T00:00:00", to + "T23:59:59"]
    );

    return res.json({ from, to, rows });
  } catch (err) {
    return next(err);
  }
});

// A paid advance is "Overdue" once it's past the admin-configured clearance
// window with no clearance claim even started for it yet — purely a derived
// display flag (not a stored status), so changing the setting immediately
// reflects on every advance rather than needing a backfill/migration.
const OVERDUE_SELECT = `
  (ar.status = 'PAID' AND ar.not_cleared_confirmed_at IS NULL AND ar.paid_at IS NOT NULL
    AND now() > ar.paid_at + (ars.clearance_duration_days || ' days')::interval
    AND NOT EXISTS (SELECT 1 FROM clearance_claims cc WHERE cc.linked_advance_id = ar.id AND cc.status != 'REJECTED')
  ) AS is_overdue`;

advancesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    if (mine) {
      const rows = await query(
        `SELECT ar.*, u.full_name AS requester_name, u.department AS department, ${OVERDUE_SELECT}
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           CROSS JOIN advance_recovery_settings ars
          WHERE ar.requester_id=$1 OR ar.created_by_id=$1
          ORDER BY ar.created_at DESC`,
        [req.user!.userId]
      );
      return res.json(rows);
    }

    if (req.user?.role !== "ADMIN") throw forbidden("Only admin can list all advances");
    const rows = await query(
      `SELECT ar.*, u.full_name AS requester_name, u.department AS department, ${OVERDUE_SELECT}
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         CROSS JOIN advance_recovery_settings ars
        ORDER BY ar.created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

advancesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const adv = (
      await query<any>(
        `SELECT ar.*,
                u.full_name AS requester_name,
                u.employee_no AS requester_employee_no,
                tt.id AS travel_type_id,
                tt.name AS travel_type_name,
                tt.location_mode AS travel_location_mode,
                tt.rate_kind AS travel_rate_kind,
                tt.currency AS travel_currency,
                tt.rate_general_staff AS travel_rate_general_staff,
                tt.rate_exco AS travel_rate_exco,
                tt.rate_ceo AS travel_rate_ceo,
                (tt.id IS NOT NULL AND tt.active = true) AS is_travel_type,
                ${OVERDUE_SELECT}
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
         CROSS JOIN advance_recovery_settings ars
         WHERE ar.id=$1`,
        [req.params.id]
      )
    )[0];
    if (!adv) throw notFound();
    // Finance dept users need to view APPROVED advances to mark them paid.
    // HOD/EXCO/MANAGER users see APPROVED advances in their inbox too — they're
    // typically in the manager chain, but fall through to canViewAdvance which covers that.
    const canViewDueToRole =
      (isFinanceDept(req.user!.department) && adv.status === "APPROVED") ||
      (["MANAGER", "HOD", "EXCO", "HR_MANAGER"].includes(req.user!.role));
    if (!canViewDueToRole) {
      const managerChainIds = await getManagerChainIds(adv.requester_id);
      if (!(await canViewAdvance({ role: req.user!.role, requesterId: adv.requester_id, createdById: adv.created_by_id, userId: req.user!.userId, approvalChain: (adv as any).approval_chain, managerChainIds }))) {
        throw forbidden();
      }
    }

    const lines = await query<any>(`SELECT * FROM advance_lines WHERE advance_request_id=$1 ORDER BY line_date`, [req.params.id]);
    const accommodation_requests = await query<any>(
      `SELECT acc.*, creator.full_name AS created_by_name
         FROM accommodation_requests acc
         JOIN users creator ON creator.id = acc.created_by_id
        WHERE acc.advance_request_id=$1
        ORDER BY acc.created_at DESC`,
      [req.params.id]
    );
    return res.json({ ...adv, lines, accommodation_requests });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.get("/:id/history", async (req: AuthedRequest, res, next) => {
  try {
    const adv = (
      await query<{ id: string; requester_id: string; created_by_id: string }>(
        `SELECT id, requester_id, created_by_id FROM advance_requests WHERE id=$1`,
        [req.params.id]
      )
    )[0];
    if (!adv) throw notFound();
    if (req.user!.role !== "ADMIN" && adv.requester_id !== req.user!.userId && adv.created_by_id !== req.user!.userId) throw forbidden();

    const rows = await query<any>(
      `SELECT al.id, al.action, al.before_json, al.after_json, al.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       WHERE al.entity_type='advance_requests' AND al.entity_id=$1
       ORDER BY al.created_at ASC`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

advancesRouter.get("/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const adv = (
      await query<any>(
        `SELECT ar.*,
                u.full_name AS requester_name,
                u.department AS department,
                creator.full_name AS created_by_name,
                tt.currency AS currency
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         JOIN users creator ON creator.id = ar.created_by_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
         WHERE ar.id=$1`,
        [req.params.id]
      )
    )[0];
    if (!adv) throw notFound();
    const managerChainIds = await getManagerChainIds(adv.requester_id);
    const isOwner = adv.requester_id === req.user!.userId || adv.created_by_id === req.user!.userId;
    if (!(await canViewAdvance({ role: req.user!.role, requesterId: adv.requester_id, createdById: adv.created_by_id, userId: req.user!.userId, approvalChain: adv.approval_chain, managerChainIds }))) {
      throw forbidden();
    }
    if (!(await canAccessPdf({ requestType: "ADVANCE_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }

    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'ADVANCE_REQUEST' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (template) {
      const data = await resolveAdvancePdfData(req.params.id);
      const catalog = await getFieldCatalogFor("ADVANCE_REQUEST");
      const letterhead = (await query<PdfLetterhead>(`SELECT * FROM pdf_letterhead_settings LIMIT 1`))[0] || {
        logo_path: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
      };
      const doc = renderPdfTemplate(template, letterhead, data, catalog);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="advance-${req.params.id}.pdf"`);
      doc.pipe(res);
      doc.end();
      return;
    }

    const lines = await query<any>(`SELECT line_date, location FROM advance_lines WHERE advance_request_id=$1 ORDER BY line_date`, [req.params.id]);
    const doc = buildAdvanceRequestPdf(adv, lines);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="advance-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateAdvanceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const type = await assertAdvanceTypeAllowed(parsed.data.type);
    const { requester } = await resolveAdvanceRequester(req.user!.userId, parsed.data.beneficiary_user_id);

    const id = await createAdvance({
      requesterId: requester.id,
      createdById: req.user!.userId,
      ...parsed.data,
      type,
      payment_account: toPaymentAccount(parsed.data),
      override_chain: parsed.data.override_chain ?? null
    });

    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: id,
      action: "ADVANCE_CREATE",
      after: { status: "DRAFT", requested_total: parsed.data.requested_total }
    });

    return res.status(201).json({ id });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (adv.created_by_id !== req.user!.userId) throw forbidden("Only the creator can edit");
    if (!["DRAFT", "SUBMITTED"].includes(adv.status)) throw badRequest("Cannot edit after manager review");

    const parsed = UpdateAdvanceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const updates: string[] = [];
    const params: unknown[] = [];

    const parsedData: Record<string, unknown> = { ...parsed.data };
    if (typeof parsedData.type === "string") {
      parsedData.type = await assertAdvanceTypeAllowed(parsedData.type);
    }
    if (parsedData.payment_method) {
      parsedData.payment_account = toPaymentAccount(parsed.data as any);
    }
    delete parsedData.ecocash_number;
    delete parsedData.bank_name;
    delete parsedData.bank_account_number;
    delete parsedData.bank_branch;
    delete parsedData.salary_month;

    const allowedEntries = Object.entries(parsedData);
    for (const [key, value] of allowedEntries) {
      if (value === undefined) continue;
      params.push(value);
      updates.push(`${key}=$${params.length}`);
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await query(`UPDATE advance_requests SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length}`, params);
      await writeAdvanceAudit({
        actorId: req.user!.userId,
        advanceId: req.params.id,
        action: "ADVANCE_UPDATE",
        after: parsed.data
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.put("/:id/lines", async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (adv.created_by_id !== req.user!.userId) throw forbidden("Only the creator can edit lines");
    if (!["DRAFT", "SUBMITTED"].includes(adv.status)) throw badRequest("Cannot edit lines after manager review");

    const parsed = LinesSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    await query(`DELETE FROM advance_lines WHERE advance_request_id=$1`, [req.params.id]);

    const travelType = await getTravelTypeByCode(adv.type);
    if (!travelType?.active) throw badRequest("Travel lines can only be added for travel advances");
    const configuredMealValue = await getTravelRateForCode(adv.type);

    for (const line of parsed.data.lines) {
      const hasMealCount = line.meals_count !== undefined;
      const mealsCount = hasMealCount ? Number(line.meals_count) : 0;
      if (hasMealCount && mealsCount > 0 && configuredMealValue <= 0) {
        throw badRequest("HR must set a rate for this travel type before requests can be submitted");
      }
      const mealValue = hasMealCount ? configuredMealValue : Number(line.meal_value || 0);
      const lunchAmount = hasMealCount ? toMoney(mealsCount * configuredMealValue) : Number(line.lunch || 0);
      const dinnerAmount = hasMealCount ? 0 : Number(line.dinner || 0);
      const total = toMoney(lunchAmount + dinnerAmount);
      await query(
        `INSERT INTO advance_lines (advance_request_id, line_date, location, travel_meta, meals_count, meal_value, lunch, dinner, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          req.params.id,
          line.line_date,
          line.location ?? null,
          JSON.stringify(line.travel_meta || {}),
          mealsCount,
          mealValue,
          lunchAmount,
          dinnerAmount,
          total
        ]
      );
    }

    const requestedTotal = parsed.data.lines.reduce((acc, line) => {
      if (line.meals_count !== undefined) {
        return acc + Number(line.meals_count) * configuredMealValue;
      }
      return acc + (line.lunch || 0) + (line.dinner || 0);
    }, 0);
    await query(`UPDATE advance_requests SET requested_total=$2, updated_at=now() WHERE id=$1`, [req.params.id, requestedTotal]);
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: req.params.id,
      action: "ADVANCE_LINES_UPDATE",
      after: { requested_total: toMoney(requestedTotal), meal_value: configuredMealValue }
    });

    return res.json({ ok: true, requested_total: toMoney(requestedTotal), meal_value: configuredMealValue });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (adv.created_by_id !== req.user!.userId) throw forbidden("Only the creator can submit");
    if (!String(adv.purpose || "").trim()) throw badRequest("purpose is required");
    if (!String(adv.payment_account || "").trim()) throw badRequest("payment_account is required");
    let needsAccommodation = false;
    if (await isTravelAdvanceType(adv.type)) {
      const row = (await query<{ count: string }>(`SELECT count(*)::text AS count FROM advance_lines WHERE advance_request_id=$1`, [adv.id]))[0];
      if (!row || Number(row.count) < 1) throw badRequest("At least one travel table entry is required");
      // More than one travel day implies an overnight stay requiring accommodation.
      needsAccommodation = Number(row.count) > 1;
      const lines = await query<{ lunch: string; dinner: string; line_total: string }>(`SELECT lunch, dinner, line_total FROM advance_lines WHERE advance_request_id=$1`, [adv.id]);
      const total = lines.reduce((sum, line) => {
        const storedTotal = Number(line.line_total || 0);
        return sum + (storedTotal > 0 ? storedTotal : Number(line.lunch || 0) + Number(line.dinner || 0));
      }, 0);
      await query(`UPDATE advance_requests SET requested_total=$2 WHERE id=$1`, [adv.id, total]);
      if (total <= 0) throw badRequest("Total must be > 0");
    } else {
      if (Number(adv.requested_total) <= 0) throw badRequest("requested_total must be > 0");
    }

    if (adv.status !== "DRAFT") {
      throw badRequest("Only draft advances can be submitted");
    }

    const requester = (await query<{ role: string; section_id: string | null; department: string | null }>(
      `SELECT role, section_id, department FROM users WHERE id=$1`,
      [adv.requester_id]
    ))[0];
    if (!requester) throw badRequest("Requester not found");

    // A requester-chosen countersigner/approver (override_chain) is only honored
    // for travel advances, and only from a role-appropriate pool — validate
    // server-side rather than trusting the frontend's pool filtering.
    let overrideChain: { label: string; user_id: string; user_name?: string }[] | undefined;
    if (adv.override_chain?.length && (await isTravelAdvanceType(adv.type))) {
      const overrideUserIds = adv.override_chain.map((o) => o.user_id);
      const overrideUsers = await query<{ id: string; role: string; section_id: string | null; department: string | null }>(
        `SELECT id, role, section_id, department FROM users WHERE id = ANY($1)`,
        [overrideUserIds]
      );

      const isEligible = (u: { role: string; section_id: string | null; department: string | null } | undefined) => {
        if (!u) return false;
        if (requester.role === "CEO" || requester.role === "EXCO") return u.role === "EXCO";
        if (requester.role === "MANAGER") {
          return (
            u.role === "EXCO" ||
            (!!requester.section_id && u.section_id === requester.section_id) ||
            (!!requester.department && u.department === requester.department)
          );
        }
        return false;
      };

      if (!["CEO", "EXCO", "MANAGER"].includes(requester.role)) {
        throw badRequest("Only CEO, Exco, or Manager requesters may choose their own countersigner/approver");
      }
      for (const o of adv.override_chain) {
        const u = overrideUsers.find((x) => x.id === o.user_id);
        if (!isEligible(u)) throw badRequest(`Selected approver for "${o.label}" is not eligible for this role`);
      }
      overrideChain = adv.override_chain;
    }

    // Resolve the workflow for this advance type and department
    const workflowResult = await resolveWorkflowChain({
      requestType: "ADVANCE_REQUEST",
      department: adv.requester_department || "",
      section: adv.requester_section || "",
      advanceSubType: adv.type,
      needsAccommodation,
      overrideChain,
      requesterRole: requester.role
    });
    if (!workflowResult || workflowResult.chain.length === 0) {
      throw badRequest(
        "No active approval workflow is configured for this request type and department. " +
        "Please contact your administrator to set up an approval workflow in the Workflow Builder."
      );
    }
    const { workflowId, chain } = workflowResult;
    const firstStatus = chainStepToStatus(chain, 0);

    await query(
      `UPDATE advance_requests SET
         status=$2, submitted_at=now(), updated_at=now(),
         workflow_id=$3, workflow_step_order=$4, approval_chain=$5
       WHERE id=$1`,
      [adv.id, firstStatus, workflowId, 0, JSON.stringify(chain)]
    );

    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_SUBMIT",
      before: { status: adv.status },
      after: { status: firstStatus, workflow_id: workflowId, workflow_step: 0, step_name: chain[0]?.position_name }
    });
    const notificationContext = await getAdvanceNotificationContext(adv.id);
    if (notificationContext) {
      await notifyAdvanceTask({
        advanceId: adv.id,
        status: firstStatus,
        advanceType: notificationContext.type,
        requesterName: notificationContext.full_name,
        requesterEmail: notificationContext.email,
        department: notificationContext.department,
        requestedTotal: Number(notificationContext.requested_total),
        nextApprover: chain[0]
          ? { id: chain[0].approver_id, name: chain[0].approver_name, email: chain[0].approver_email, title: chain[0].approver_title || chain[0].position_name }
          : null,
        stepOrder: 0
      });
    }
    return res.json({ ok: true, status: firstStatus });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/rollback", requireAdvanceActionAccess, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for rollback", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    const role = req.user!.role;
    const userId = req.user!.userId;

    if (adv.approval_chain?.length) {
      // Workflow-driven: only the current step's approver (or ADMIN) can roll back
      const chain = adv.approval_chain as ChainStep[];
      const stepIdx = adv.workflow_step_order ?? 0;
      const group = getPendingGroup(chain, stepIdx);
      if (!group.indices.length) throw badRequest("No active workflow step to roll back");
      const delegated = await getActiveManagerDelegation(userId);
      let currentStep: ChainStep | undefined = chain[group.indices[0]];
      if (role !== "ADMIN") {
        currentStep = undefined;
        for (const idx of group.indices) {
          if (await canApproveStep(chain[idx], userId, role, delegated?.manager_id, req.user!.department)) { currentStep = chain[idx]; break; }
        }
        if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
        if (currentStep.can_rollback === false) throw forbidden("This step does not allow rolling back to draft");
      }
      // Reset to DRAFT — requester can edit and re-submit, chain re-resolved on next submit
      await query(
        `UPDATE advance_requests SET
           status='DRAFT', workflow_id=NULL, workflow_step_order=NULL, approval_chain=NULL, updated_at=now()
         WHERE id=$1`,
        [adv.id]
      );
      await writeAdvanceAudit({
        actorId: userId,
        advanceId: adv.id,
        action: "ADVANCE_ROLLBACK",
        before: { status: adv.status, workflow_step: stepIdx, step_name: currentStep.position_name },
        after: { status: "DRAFT", comments: parsed.data.comments }
      });
    } else {
      // Legacy advance — use old role guards
      if (role === "HR_MANAGER" && adv.status !== "HR_MANAGER_REVIEW") throw forbidden("HR Manager can only roll back advances pending HR Manager review");
      if (role === "HOD" && adv.status !== "COUNTERSIGNED") throw forbidden("HOD can only roll back advances pending HOD review");
      if (role === "EXCO" && adv.status !== "COUNTERSIGNED") throw forbidden("EXCO can only roll back advances pending HOD / EXCO review");
      const status = nextStatusOrThrow(adv.status, "ROLLBACK");
      await setAdvanceStatus(adv.id, status);
      await writeAdvanceAudit({
        actorId: userId,
        advanceId: adv.id,
        action: "ADVANCE_ROLLBACK",
        before: { status: adv.status },
        after: { status, comments: parsed.data.comments }
      });
    }

    const notificationContext = await getAdvanceNotificationContext(adv.id);
    if (notificationContext) {
      await notifyAdvanceTask({
        advanceId: adv.id,
        status: "DRAFT",
        advanceType: notificationContext.type,
        requesterName: notificationContext.full_name,
        requesterEmail: notificationContext.email,
        department: notificationContext.department,
        requestedTotal: Number(notificationContext.requested_total)
      });
    }
    return res.json({ ok: true, status: "DRAFT" });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /:id/reject and the email-approval flow (email-actions.routes.ts)
// so rejecting via an email link runs through the exact same eligibility checks
// and notification side-effects as rejecting from the Inbox.
export async function performAdvanceReject(
  advanceId: string,
  actor: { userId: string; role: string; department: string | null },
  comments: string
): Promise<{ status: AdvanceStatus }> {
  const adv = await getAdvanceById(advanceId);
  if (!adv) throw notFound();

  const { role, userId, department } = actor;

  if (adv.approval_chain?.length) {
    // Workflow-driven: only the current step's approver (or ADMIN) can reject
    const chain = adv.approval_chain as ChainStep[];
    const stepIdx = adv.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    if (!group.indices.length) throw badRequest("No active workflow step to reject");
    const delegated = await getActiveManagerDelegation(userId);
    let currentStep: ChainStep | undefined = chain[group.indices[0]];
    if (role !== "ADMIN") {
      currentStep = undefined;
      for (const idx of group.indices) {
        if (await canApproveStep(chain[idx], userId, role, delegated?.manager_id, department)) { currentStep = chain[idx]; break; }
      }
      if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
      if (currentStep.can_reject === false) throw forbidden("This step does not allow rejection");
    }
  } else {
    // Legacy guards
    if (role === "HR_MANAGER" && adv.status !== "HR_MANAGER_REVIEW") throw forbidden("HR Manager can only reject advances pending HR Manager review");
    if (role === "HOD" && adv.status !== "COUNTERSIGNED") throw forbidden("HOD can only reject advances pending HOD review");
    if (role === "EXCO" && adv.status !== "COUNTERSIGNED") throw forbidden("EXCO can only reject advances pending HOD / EXCO review");
    if (isFinanceDept(department) && !["HR_OFFICER", "APPROVED"].includes(adv.status)) throw forbidden("Finance can only reject HR-approved advances pending payment");
  }

  const status: AdvanceStatus = "REJECTED";
  await query(
    `UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`,
    [adv.id, status]
  );
  await writeAdvanceAudit({
    actorId: userId,
    advanceId: adv.id,
    action: "ADVANCE_REJECT",
    before: { status: adv.status, workflow_step: adv.workflow_step_order },
    after: { status, comments }
  });
  const notificationContext = await getAdvanceNotificationContext(adv.id);
  if (notificationContext) {
    await notifyAdvanceTask({
      advanceId: adv.id,
      status,
      advanceType: notificationContext.type,
      requesterName: notificationContext.full_name,
      department: notificationContext.department,
      requestedTotal: Number(notificationContext.requested_total)
    });
  }
  return { status };
}

advancesRouter.post("/:id/reject", requireAdvanceActionAccess, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());
    const result = await performAdvanceReject(
      req.params.id,
      { userId: req.user!.userId, role: req.user!.role, department: req.user!.department ?? null },
      parsed.data.comments
    );
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/approve", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const result = await performAdvanceApprove(
      req.params.id,
      { userId: req.user!.userId, role: req.user!.role, department: req.user!.department ?? null },
      parsed.data.approved_total
    );
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /:id/approve and the email-approval flow (email-actions.routes.ts).
export async function performAdvanceApprove(
  advanceId: string,
  actor: { userId: string; role: string; department: string | null },
  approvedTotal: number
): Promise<{ status: AdvanceStatus }> {
  const adv = await getAdvanceById(advanceId);
  if (!adv) throw notFound();

  if (["APPROVED", "PAID", "REJECTED", "CANCELLED"].includes(adv.status)) {
    throw badRequest("This advance cannot be approved in its current state");
  }

  const { role, userId, department } = actor;
  const delegated = await getActiveManagerDelegation(userId);

  let nextStatus: AdvanceStatus;
  let auditAfter: Record<string, unknown>;
  let nextApprover: { id?: string | null; name: string | null; email: string | null; title: string | null } | null = null;
  let extraApprovers: Array<{ id?: string | null; name: string | null; email: string | null; title: string | null }> = [];
  let newStepOrder: number | undefined;

  if (adv.approval_chain?.length) {
    // ── Workflow-driven path ──────────────────────────────────────────────
    const result = await advanceWorkflowStep({
      adv,
      userId,
      role,
      delegatedManagerId: delegated?.manager_id,
      userDepartment: department,
      approvedTotal
    });
    nextStatus = result.nextStatus;
    nextApprover = result.nextApprover;
    extraApprovers = result.nextApprovers.slice(1);
    newStepOrder = result.newStepOrder;
    auditAfter = {
      status: nextStatus,
      approved_total: approvedTotal,
      workflow_step: result.newStepOrder,
      step_name: result.stillPending
        ? result.currentStep.position_name
        : result.hasMore ? (adv.approval_chain as ChainStep[])[result.newStepOrder].position_name : "Complete"
    };
  } else if (role === "ADMIN") {
    // ── Legacy admin override (no workflow chain) ─────────────────────────
    const leadership = await getDepartmentLeadership(adv.requester_department || "");
    const adminNext: Record<string, AdvanceStatus> = {
      SUBMITTED:          leadership.hod_user_id ? "COUNTERSIGNED" : "HR_MANAGER_REVIEW",
      COUNTERSIGNED:      "HR_MANAGER_REVIEW",
      HR_MANAGER_REVIEW:  "HR_REVIEW",
      HR_REVIEW:          "HR_OFFICER",
      HR_OFFICER:         "APPROVED"
    };
    nextStatus = adminNext[adv.status] ?? nextStatusOrThrow(adv.status, "APPROVE");
    await setAdvanceStatus(adv.id, nextStatus, { approvedTotal });
    if (nextStatus === "COUNTERSIGNED" || (adv.status === "SUBMITTED" && nextStatus === "HR_MANAGER_REVIEW")) {
      await query(`UPDATE advance_requests SET countersigned_at=now() WHERE id=$1 AND countersigned_at IS NULL`, [adv.id]);
    }
    auditAfter = { status: nextStatus, approved_total: approvedTotal };
  } else {
    throw forbidden("This advance does not have an active approval workflow. Please contact the administrator.");
  }

  await writeAdvanceAudit({
    actorId: userId,
    advanceId: adv.id,
    action: "ADVANCE_APPROVE",
    before: { status: adv.status, approved_total: Number(adv.approved_total || 0) },
    after: auditAfter
  });
  const notificationContext = await getAdvanceNotificationContext(adv.id);
  if (notificationContext) {
    await notifyAdvanceTask({
      advanceId: adv.id,
      status: nextStatus,
      advanceType: notificationContext.type,
      requesterName: notificationContext.full_name,
      requesterEmail: notificationContext.email,
      department: notificationContext.department,
      requestedTotal: Number(notificationContext.requested_total),
      nextApprover,
      stepOrder: newStepOrder
    });
    for (const extra of extraApprovers) {
      if (extra.email) {
        await notifyAdvanceTask({
          advanceId: adv.id,
          status: nextStatus,
          advanceType: notificationContext.type,
          requesterName: notificationContext.full_name,
          requesterEmail: notificationContext.email,
          department: notificationContext.department,
          stepOrder: newStepOrder,
          requestedTotal: Number(notificationContext.requested_total),
          nextApprover: extra
        });
      }
    }
    // Finance completing the final approval also marks the advance as paid
    // in the same action — send the "paid" notification too.
    if (nextStatus === "PAID") {
      await notifyAdvancePaid({
        advanceId: adv.id,
        requesterName: notificationContext.full_name,
        requesterEmail: notificationContext.email,
        department: notificationContext.department,
        advanceType: notificationContext.type,
        approvedTotal,
        paidReference: notificationContext.paid_reference
      });
    }
  }
  return { status: nextStatus };
}

const MarkPaidSchema = z.object({ paid_reference: z.string().trim().optional() });

advancesRouter.post("/:id/mark-paid", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = MarkPaidSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const paidReference = parsed.data.paid_reference || null;

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    // Normally only the Finance department/ADMIN can mark an advance as paid.
    // Workflow-driven advances may instead name a specific person/team as the
    // MARK_PAID step — that person also needs to be able to mark the advance
    // paid once their step has completed, even if they're not in Finance.
    const role = req.user!.role;
    const chain = (adv.approval_chain as ChainStep[] | null) || [];
    // The MARK_PAID step isn't necessarily exactly at workflow_step_order — it
    // may be one member of a "both must approve" parallel stage alongside
    // other (non-payment) steps, so look for it within the current pending
    // group rather than indexing workflow_step_order directly.
    const group = chain.length ? getPendingGroup(chain, adv.workflow_step_order ?? 0) : { indices: [], steps: [] };
    const markPaidIdx = group.indices.find((idx) => chain[idx]?.action_type === "MARK_PAID" && !chain[idx]?.approved);
    const markPaidStep = markPaidIdx != null ? chain[markPaidIdx] : null;

    let status: AdvanceStatus;
    let newChain: ChainStep[] | undefined;
    let newWorkflowStepOrder: number | undefined;

    if (markPaidStep) {
      const isAuthorized = role === "ADMIN" || (await canApproveStep(markPaidStep, req.user!.userId, role, undefined, req.user!.department));
      if (!isAuthorized) throw forbidden("You are not the assigned payer for this step");

      newChain = chain.map((s, i) => (i === markPaidIdx ? { ...s, approved: true } : s));
      const stillPending = group.indices.some((idx) => !newChain![idx].approved);
      if (stillPending) {
        // Other (non-payment) members of this parallel stage haven't finished yet —
        // record this step's completion but the advance isn't fully PAID until they do.
        status = adv.status;
        newWorkflowStepOrder = adv.workflow_step_order ?? 0;
      } else {
        const nextIdx = group.indices[group.indices.length - 1] + 1;
        const hasMore = nextIdx < newChain.length;
        status = hasMore ? chainStepToStatus(newChain, nextIdx) : "PAID";
        newWorkflowStepOrder = hasMore ? nextIdx : newChain.length;
      }
    } else {
      // No pending MARK_PAID step right now — either this is a legacy/no-workflow
      // advance, or the chain never had an explicit MARK_PAID step and instead
      // relies on the named final-step approver once status reaches APPROVED.
      let isFinalStepAuthorized = false;
      if (chain.length && !chain.some((s) => s.action_type === "MARK_PAID")) {
        const finalStep = chain[chain.length - 1];
        if (finalStep?.approver_id === req.user!.userId) isFinalStepAuthorized = true;
      }
      if (role !== "ADMIN" && !isFinanceDept(req.user!.department) && !isFinalStepAuthorized) {
        throw forbidden("Only Finance can mark an advance as paid");
      }
      status = nextStatusOrThrow(adv.status, "MARK_PAID");
    }

    const isNowPaid = status === "PAID";
    if (newChain) {
      await query(
        `UPDATE advance_requests SET status=$2, workflow_step_order=$3, approval_chain=$4, paid_reference=$5,
                paid_at = CASE WHEN $6 THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1`,
        [adv.id, status, newWorkflowStepOrder, JSON.stringify(newChain), paidReference, isNowPaid]
      );
    } else {
      await query(
        `UPDATE advance_requests SET status=$2, paid_reference=$3,
                paid_at = CASE WHEN $4 THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1`,
        [adv.id, status, paidReference, isNowPaid]
      );
    }
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_MARK_PAID",
      before: { status: adv.status },
      after: { status, paid_reference: paidReference }
    });
    if (status === "PAID") {
      const paidCtx = await getAdvanceNotificationContext(adv.id);
      if (paidCtx) {
        await notifyAdvancePaid({
          advanceId: adv.id,
          requesterName: paidCtx.full_name,
          requesterEmail: paidCtx.email,
          department: paidCtx.department,
          advanceType: paidCtx.type,
          approvedTotal: Number(paidCtx.approved_total || paidCtx.requested_total),
          paidReference: paidCtx.paid_reference
        });
      }
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/revoke", async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (adv.created_by_id !== req.user!.userId) throw forbidden("Only the creator can revoke");

    const status = nextStatusOrThrow(adv.status, "CANCEL");
    await setAdvanceStatus(adv.id, status);
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_REVOKE",
      before: { status: adv.status },
      after: { status }
    });
    const cancelCtx = await getAdvanceNotificationContext(adv.id);
    if (cancelCtx) {
      await notifyAdvanceCancelled({
        advanceId: adv.id,
        requesterName: cancelCtx.full_name,
        requesterEmail: cancelCtx.email,
        department: cancelCtx.department,
        advanceType: cancelCtx.type,
        requestedTotal: Number(cancelCtx.requested_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

// POST /advances/:id/remind — requester nudges the current pending approver
advancesRouter.post("/:id/remind", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    // Only the requester, creator, or ADMIN can send a reminder
    const userId = req.user!.userId;
    if (req.user!.role !== "ADMIN" && adv.requester_id !== userId && adv.created_by_id !== userId) {
      throw forbidden("Only the requester can send a reminder");
    }

    // Advance must be in a pending-approval state
    const pendingStatuses = ["SUBMITTED", "COUNTERSIGNED", "HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER", "APPROVED"];
    if (!pendingStatuses.includes(adv.status)) {
      throw badRequest("No pending approver to remind for this request");
    }

    // Determine the current approver from the workflow chain or legacy role
    let approverName: string | null = null;
    let approverEmail: string | null = null;
    let approverTitle: string | null = null;

    if (adv.approval_chain?.length) {
      const chain = adv.approval_chain as ChainStep[];
      const stepIdx = adv.workflow_step_order ?? 0;
      const group = getPendingGroup(chain, stepIdx);
      const step = chain[group.indices[0]];
      if (step) {
        approverName  = step.approver_name ?? null;
        approverEmail = step.approver_email ?? null;
        approverTitle = (step as any).approver_title ?? step.position_name ?? null;
      }
    } else {
      // Legacy: look up by role
      let role: string | null = null;
      if (adv.status === "SUBMITTED")         role = "MANAGER";
      if (adv.status === "COUNTERSIGNED")     role = "HOD";
      if (adv.status === "HR_MANAGER_REVIEW") role = "HR_MANAGER";
      if (adv.status === "HR_REVIEW")         role = "HR_MANAGER";
      if (adv.status === "HR_OFFICER")        role = "FINANCE";
      if (adv.status === "APPROVED")          role = "FINANCE";
      if (role) {
        const approverRows = await query<{ full_name: string | null; email: string }>(
          `SELECT full_name, email FROM users WHERE role=$1 AND is_active=true AND lower(trim(department))=lower(trim($2)) LIMIT 1`,
          [role, adv.requester_department ?? ""]
        );
        if (approverRows[0]) {
          approverName  = approverRows[0].full_name;
          approverEmail = approverRows[0].email;
          approverTitle = role.replace(/_/g, " ");
        }
      }
    }

    if (!approverEmail) throw badRequest("Could not determine the current approver's email");

    // Fetch requester + sender details
    const [requesterRows, senderRows] = await Promise.all([
      query<{ full_name: string | null; email: string }>(
        `SELECT full_name, email FROM users WHERE id=$1`,
        [adv.requester_id]
      ),
      query<{ full_name: string | null; email: string }>(
        `SELECT full_name, email FROM users WHERE id=$1`,
        [userId]
      )
    ]);
    const requester = requesterRows[0];
    const sender    = senderRows[0];

    void notifyAdvanceReminder({
      advanceId:      adv.id,
      advanceType:    adv.type,
      requesterName:  requester?.full_name ?? null,
      department:     adv.requester_department ?? null,
      requestedTotal: Number(adv.requested_total),
      status:         adv.status,
      approverName,
      approverEmail,
      approverTitle,
      senderName:     sender?.full_name ?? null,
      senderEmail:    sender?.email ?? null
    });

    return res.json({ ok: true, approverName });
  } catch (err) {
    return next(err);
  }
});
