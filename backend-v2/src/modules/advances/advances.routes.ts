import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { AuthedRequest, hasFeatureAccess, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { isCompensationFinanceSection, isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { advanceWorkflowStep, createAdvance, getAdvanceById, nextStatusOrThrow, setAdvanceStatus } from "./advances.service.js";
import { canCreateAdvanceOnBehalf, getUserAccountState, isPermanentEmployee, isProfileComplete } from "../../lib/userProfile.js";
import type { AdvanceStatus } from "./advances.types.js";
import { notifyAdvanceCancelled, notifyAdvancePaid, notifyAdvanceReminder, notifyAdvanceTask } from "../../lib/notifications.js";
import { getDelegatedManagerIds } from "../../lib/delegations.js";
import { assertAdvanceTypeAllowed, assertPaybackMonthsAllowed, getTravelRateForCode, getTravelTypeByCode, isReservedAdvanceType, isTravelAdvanceType } from "../../lib/travel.js";
import { getDepartmentLeadership } from "../../lib/departments.js";
import { canApproveStep, chainStepToStatus, getPendingGroup, hoursBetween, resolveWorkflowChain, type ChainStep } from "../../lib/workflowEngine.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";
import { buildAdvanceRequestPdf } from "../../lib/pdf/advanceFormPdf.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveAdvancePdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import { buildAdvancePdfFilename, formatPaymentReference } from "../../lib/pdf/pdfHelpers.js";

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
  payback_months: z.coerce.number().int().positive().optional(),
  extra_cost_amount: z.coerce.number().nonnegative().optional(),
  extra_cost_description: z.string().trim().optional(),
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
  payback_months: z.coerce.number().int().positive().optional(),
  extra_cost_amount: z.coerce.number().nonnegative().optional(),
  extra_cost_description: z.string().trim().optional(),
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
        breakfast: z.coerce.number().nonnegative().default(0),
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

// Every requester (permanent, intern, or temporary) may have at most one
// travel advance outstanding (not yet cleared) at a time - clear it before
// requesting another. SALARY/LOAN advances are administrative, not travel,
// so they neither count against this limit nor are restricted by it.
async function countOutstandingTravelAdvances(requesterId: string, client?: PoolClient): Promise<number> {
  const sql = `SELECT count(*)::text AS count
       FROM advance_requests ar
      WHERE ar.requester_id = $1
        AND ar.type NOT IN ('SALARY','LOAN')
        AND ar.status NOT IN ('REJECTED','CANCELLED')
        AND NOT EXISTS (
          SELECT 1 FROM clearance_claims cc
           WHERE cc.linked_advance_id = ar.id AND cc.status = 'CLOSED'
        )`;
  const rows = client
    ? (await client.query<{ count: string }>(sql, [requesterId])).rows
    : await query<{ count: string }>(sql, [requesterId]);
  return Number(rows[0]?.count || 0);
}

// Takes an optional locked transaction client so the count-check and the
// subsequent INSERT (in the POST / handler) can be serialized per-requester
// via pg_advisory_xact_lock — otherwise two concurrent requests from the
// same requester near the cap could both read a count under the limit and
// both insert, exceeding it.
async function assertSingleOutstandingTravelAdvance(requester: { id: string }, type: string, client?: PoolClient) {
  if (isReservedAdvanceType(type)) return;
  const outstanding = await countOutstandingTravelAdvances(requester.id, client);
  if (outstanding >= 1) {
    throw badRequest("You already have a travel advance outstanding - clear it before requesting another");
  }
}

async function resolveAdvanceRequester(actorId: string, beneficiaryUserId: string | undefined, type: string, client?: PoolClient) {
  const actor = await getUserAccountState(actorId);
  if (!isProfileComplete(actor)) {
    throw badRequest("Complete your profile before requesting an advance");
  }

  const beneficiaryId = String(beneficiaryUserId || "").trim();
  if (!beneficiaryId || beneficiaryId === actor.id) {
    if (!isPermanentEmployee(actor) && !["INTERN", "TEMPORARY"].includes(String(actor.employment_type || "").trim().toUpperCase())) {
      throw forbidden("Only permanent employees, interns, and temporary employees can request advances for themselves");
    }
    await assertSingleOutstandingTravelAdvance(actor, type, client);
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
    throw forbidden("On-behalf advances must stay within the same division");
  }

  await assertSingleOutstandingTravelAdvance(requester, type, client);
  return { actor, requester };
}

export async function getAdvanceNotificationContext(advanceId: string) {
  return (
    await query<{ full_name: string | null; email: string | null; department: string | null; requested_total: string; approved_total: string; type: string; status: string; paid_reference: string | null; currency: string | null }>(
      `SELECT u.full_name, u.email, u.department, ar.requested_total, ar.approved_total, ar.type, ar.status, ar.paid_reference, tt.currency
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
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

    // Each user gets one row per currency they actually transacted in
    // (rather than blending e.g. LSL and USD amounts into a single number
    // under one arbitrary currency label) — advances and claims are
    // aggregated separately by (user, currency) and then combined with a
    // FULL OUTER JOIN so a currency present in only one side isn't dropped.
    const rows = await query<any>(
      `WITH adv AS (
         SELECT ar.requester_id AS user_id,
                COALESCE(tt.currency, 'LSL') AS currency,
                SUM(CASE WHEN status = 'PAID' AND paid_at < $1 THEN approved_total ELSE 0 END) AS paid_before,
                SUM(CASE WHEN status = 'PAID' AND paid_at >= $1 AND paid_at <= $2 THEN approved_total ELSE 0 END) AS paid_in_period,
                SUM(CASE WHEN ar.created_at >= $1 AND ar.created_at <= $2 THEN requested_total ELSE 0 END) AS requested_in_period
           FROM advance_requests ar
           LEFT JOIN travel_types tt ON tt.code = ar.type
          GROUP BY ar.requester_id, COALESCE(tt.currency, 'LSL')
       ),
       clm AS (
         SELECT claimant_id AS user_id,
                COALESCE(currency, 'LSL') AS currency,
                SUM(CASE WHEN status = 'SETTLED' AND settled_at < $1 THEN claim_total ELSE 0 END) AS settled_before,
                SUM(CASE WHEN status = 'SETTLED' AND settled_at >= $1 AND settled_at <= $2 THEN claim_total ELSE 0 END) AS settled_in_period
           FROM clearance_claims
          GROUP BY claimant_id, COALESCE(currency, 'LSL')
       ),
       combined AS (
         SELECT COALESCE(adv.user_id, clm.user_id) AS user_id,
                COALESCE(adv.currency, clm.currency) AS currency,
                adv.paid_before, adv.paid_in_period, adv.requested_in_period,
                clm.settled_before, clm.settled_in_period
           FROM adv
           FULL OUTER JOIN clm ON clm.user_id = adv.user_id AND clm.currency = adv.currency
       )
       SELECT u.id AS requester_id, u.full_name AS requester_name, u.department,
              c.currency,
              COALESCE(c.paid_before, 0) - COALESCE(c.settled_before, 0) AS opening_balance,
              COALESCE(c.requested_in_period, 0) AS total_requested,
              COALESCE(c.paid_in_period, 0) AS total_paid,
              COALESCE(c.settled_in_period, 0) AS total_settled,
              (COALESCE(c.paid_before, 0) - COALESCE(c.settled_before, 0))
                + COALESCE(c.paid_in_period, 0) - COALESCE(c.settled_in_period, 0) AS closing_balance
         FROM combined c
         JOIN users u ON u.id = c.user_id
        WHERE COALESCE(c.paid_before, 0) <> 0 OR COALESCE(c.settled_before, 0) <> 0
           OR COALESCE(c.requested_in_period, 0) <> 0 OR COALESCE(c.paid_in_period, 0) <> 0
           OR COALESCE(c.settled_in_period, 0) <> 0
        ORDER BY u.full_name, c.currency`,
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

// ── Clearance Status Report (Human Resource / Financial Accounts) ─────────
// Every paid travel advance, classified into exactly one of:
//  - COMPLETE:      the linked clearance claim reached SETTLED or CLOSED
//  - NOT_CLEARED:   no non-rejected claim exists and the advance is overdue
//                    (past the admin-configured clearance window) or has
//                    already been manually confirmed as not-cleared
//  - NOT_COMPLETE:  everything else - a claim is still in progress, or one
//                    hasn't been submitted yet but the window hasn't lapsed
// Mirrors the same "overdue" definition already used for the recovery
// workflow (OVERDUE_SELECT) so the two stay consistent.
const CLEARANCE_STATUS_REPORT_DEFAULT_ROLES = [
  "ADMIN", "Department: Finance", "Section: Treasury & Financial Accounting",
  "Department: Human Resource", "Department: Human Resources", "Section: Human Resources Operations"
];
advancesRouter.get("/clearance-status-report", requireAuth, requireFeatureAccess("clearance_status_report", CLEARANCE_STATUS_REPORT_DEFAULT_ROLES), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `WITH latest_claim AS (
         SELECT DISTINCT ON (linked_advance_id)
                linked_advance_id, id, status, claim_total, submitted_at, closed_at, settled_at
           FROM clearance_claims
          WHERE linked_advance_id IS NOT NULL
          ORDER BY linked_advance_id, created_at DESC
       )
       SELECT ar.id AS advance_id, ar.type, ar.approved_total, ar.requested_total, ar.paid_at,
              COALESCE(tt.currency, 'LSL') AS currency,
              u.id AS requester_id, u.full_name AS requester_name, u.department,
              lc.id AS claim_id, lc.status AS claim_status, lc.claim_total,
              lc.submitted_at, lc.closed_at, lc.settled_at,
              ${OVERDUE_SELECT},
              ar.not_cleared_confirmed_at
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         JOIN travel_types tt ON tt.code = ar.type
         CROSS JOIN advance_recovery_settings ars
         LEFT JOIN latest_claim lc ON lc.linked_advance_id = ar.id
        WHERE ar.status = 'PAID'
        ORDER BY ar.paid_at DESC`
    );

    const items = rows.map((r) => {
      let status: "COMPLETE" | "NOT_COMPLETE" | "NOT_CLEARED";
      const claimDone = r.claim_status && ["SETTLED", "CLOSED"].includes(r.claim_status);
      const claimInProgress = r.claim_status && !["SETTLED", "CLOSED", "REJECTED"].includes(r.claim_status);
      if (claimDone) status = "COMPLETE";
      else if (claimInProgress) status = "NOT_COMPLETE";
      else if (r.is_overdue || r.not_cleared_confirmed_at) status = "NOT_CLEARED";
      else status = "NOT_COMPLETE";

      return {
        advance_id: r.advance_id,
        type: r.type,
        requester_id: r.requester_id,
        requester_name: r.requester_name,
        department: r.department,
        approved_total: Number(r.approved_total ?? r.requested_total ?? 0),
        currency: r.currency,
        paid_at: r.paid_at,
        claim_id: r.claim_id,
        claim_status: r.claim_status,
        claim_total: r.claim_total != null ? Number(r.claim_total) : null,
        submitted_at: r.submitted_at,
        closed_at: r.closed_at,
        settled_at: r.settled_at,
        not_cleared_confirmed_at: r.not_cleared_confirmed_at,
        status
      };
    });

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

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

    const allowed = await hasFeatureAccess(req.user!.userId, req.user!.role, "report_advances", ["ADMIN"]);
    if (!allowed) throw forbidden("Not authorized to list all advances");
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

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Payments nav item at all - mirrors Deductions' /access endpoint.
advancesRouter.get("/payments/access", async (req: AuthedRequest, res, next) => {
  try {
    // Admin-configured group grant (e.g. for HR view-only access) OR anyone
    // with real Finance authority (is_compensation_finance), regardless of
    // which company's naming their finance unit uses.
    const allowed = (await hasFeatureAccess(req.user!.userId, req.user!.role, "payments", ["ADMIN", "Department: Finance"]))
      || (await isCompensationFinanceUser(req));
    return res.json({ allowed });
  } catch (err) {
    return next(err);
  }
});

// Must be registered before GET /:id, otherwise Express matches "/payments" as id="payments".
advancesRouter.get("/payments", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    const allowed = (await hasFeatureAccess(req.user!.userId, role, "payments", ["ADMIN", "Department: Finance"]))
      || (await isCompensationFinanceUser(req));
    if (!allowed) throw forbidden();

    const statusParam = String(req.query.status || "all") as "pending" | "paid" | "all";
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const rows = await query<any>(
      `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
              ar.workflow_step_order, ar.approval_chain, ar.paid_at, ar.paid_reference,
              ar.created_at, ar.sequence_no, COALESCE(tt.currency, 'LSL') AS currency,
              u.full_name AS requester_name, u.employee_no AS requester_employee_no, u.department
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
        WHERE ar.status NOT IN ('DRAFT','REJECTED','CANCELLED')
        ORDER BY ar.created_at DESC`
    );

    const classified: any[] = [];
    for (const a of rows) {
      let paymentStatus: "PENDING" | "PAID" | null = null;
      if (a.status === "PAID") {
        paymentStatus = "PAID";
      } else {
        const chain = (a.approval_chain as ChainStep[] | null) || [];
        if (chain.length) {
          const group = getPendingGroup(chain, a.workflow_step_order ?? 0);
          const hasPendingMarkPaid = group.steps.some((s) => !s.approved && s.action_type === "MARK_PAID");
          const hasMarkPaidStep = chain.some((s) => s.action_type === "MARK_PAID");
          if (hasPendingMarkPaid || (!hasMarkPaidStep && ["HR_OFFICER", "APPROVED"].includes(a.status))) {
            paymentStatus = "PENDING";
          }
        } else if (["HR_OFFICER", "APPROVED"].includes(a.status)) {
          paymentStatus = "PENDING";
        }
      }
      if (!paymentStatus) continue;

      let approvedByName: string | null = null;
      const chain = (a.approval_chain as ChainStep[] | null) || [];
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i]?.approved) { approvedByName = chain[i].position_name || null; break; }
      }

      classified.push({
        id: a.id,
        status: a.status,
        payment_status: paymentStatus,
        type: a.type,
        currency: a.currency,
        requested_total: Number(a.requested_total),
        approved_total: Number(a.approved_total),
        purpose: a.purpose,
        requester_name: a.requester_name,
        department: a.department,
        created_at: a.created_at,
        paid_at: a.paid_at,
        paid_reference: a.paid_reference,
        approved_by_name: approvedByName,
        pdf_filename: buildAdvancePdfFilename(a.requester_name, a.requester_employee_no, a.sequence_no)
      });
    }

    const filtered = statusParam === "all" ? classified : classified.filter((r) => r.payment_status === statusParam.toUpperCase());
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);
    return res.json({ items, total, limit, offset });
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
                u.department AS department,
                creator.full_name AS created_by_name,
                et.name AS traveller_type,
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
         JOIN users creator ON creator.id = ar.created_by_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
         LEFT JOIN employment_types et ON et.code = u.employment_type
         CROSS JOIN advance_recovery_settings ars
         WHERE ar.id=$1`,
        [req.params.id]
      )
    )[0];
    if (!adv) throw notFound();
    // Finance dept users need to view APPROVED advances to mark them paid.
    // MANAGER/HOD/EXCO users who are actually in this request's approval
    // chain or the requester's management chain are covered by
    // canViewAdvance below — a bare role match here would let any
    // manager/HOD/EXCO view every advance company-wide, so it isn't used.
    const canViewDueToRole = (await isCompensationFinanceSection(req.user!.sectionId)) && adv.status === "APPROVED";
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
                u.employee_no AS requester_employee_no,
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
    const pdfFilename = buildAdvancePdfFilename(adv.requester_name, adv.requester_employee_no, adv.sequence_no);
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
      const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
        logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
      };
      const doc = renderPdfTemplate(template, letterhead, data, catalog);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${pdfFilename}"`);
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
    await assertPaybackMonthsAllowed(type, parsed.data.payback_months);

    // The cap check (assertSingleOutstandingTravelAdvance, inside
    // resolveAdvanceRequester) and this INSERT run in one transaction,
    // serialized per-requester via an advisory lock keyed on their id — two
    // concurrent requests from the same requester near the cap previously
    // could both read a count under the limit and both insert.
    const targetUserId = String(parsed.data.beneficiary_user_id || "").trim() || req.user!.userId;
    const id = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [targetUserId]);
      const { requester } = await resolveAdvanceRequester(req.user!.userId, parsed.data.beneficiary_user_id, type, client);

      return createAdvance(
        {
          requesterId: requester.id,
          createdById: req.user!.userId,
          ...parsed.data,
          type,
          payment_account: toPaymentAccount(parsed.data),
          override_chain: parsed.data.override_chain ?? null
        },
        client
      );
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
    if (parsedData.payback_months !== undefined) {
      await assertPaybackMonthsAllowed((parsedData.type as string | undefined) ?? adv.type, parsedData.payback_months as number);
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

    const travelType = await getTravelTypeByCode(adv.type);
    if (!travelType?.active) throw badRequest("Travel lines can only be added for travel advances");
    const configuredMealValue = await getTravelRateForCode(adv.type, adv.requester_role);

    // Delete + per-line insert + total recompute all run in one transaction —
    // previously a mid-loop validation error (e.g. missing rate on a later
    // line) could leave the old lines already deleted and only some of the
    // replacement lines inserted, with requested_total never recomputed.
    const requestedTotal = await withTransaction(async (client) => {
      await client.query(`DELETE FROM advance_lines WHERE advance_request_id=$1`, [req.params.id]);

      let runningTotal = 0;
      for (const line of parsed.data.lines) {
        const hasMealCount = line.meals_count !== undefined;
        const mealsCount = hasMealCount ? Number(line.meals_count) : 0;
        if (hasMealCount && mealsCount > 0 && configuredMealValue <= 0) {
          throw badRequest("HR must set a rate for this travel type before requests can be submitted");
        }
        const mealValue = hasMealCount ? configuredMealValue : Number(line.meal_value || 0);
        // 1 meal/day = lunch only, 2 = lunch+dinner, 3 = breakfast+lunch+dinner.
        // Each applicable slot costs the full configured rate, so the sum still
        // equals mealsCount * configuredMealValue exactly as before. Only
        // applies to MEAL-rate-kind types (capped at 3/day by the frontend) —
        // for DAILY-rate-kind types, meals_count is actually a day count (can
        // exceed 3) multiplying a flat per-diem rate, not a meal tally, so keep
        // dumping the whole amount into "lunch" as before.
        const isMealBased = hasMealCount && travelType.rate_kind === "MEAL";
        const breakfastAmount = isMealBased
          ? (mealsCount >= 3 ? toMoney(configuredMealValue) : 0)
          : hasMealCount ? 0 : Number(line.breakfast || 0);
        const lunchAmount = isMealBased
          ? (mealsCount >= 1 ? toMoney(configuredMealValue) : 0)
          : hasMealCount ? toMoney(mealsCount * configuredMealValue) : Number(line.lunch || 0);
        const dinnerAmount = isMealBased
          ? (mealsCount >= 2 ? toMoney(configuredMealValue) : 0)
          : hasMealCount ? 0 : Number(line.dinner || 0);
        const total = toMoney(breakfastAmount + lunchAmount + dinnerAmount);
        await client.query(
          `INSERT INTO advance_lines (advance_request_id, line_date, location, travel_meta, meals_count, meal_value, breakfast, lunch, dinner, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            req.params.id,
            line.line_date,
            line.location ?? null,
            JSON.stringify(line.travel_meta || {}),
            mealsCount,
            mealValue,
            breakfastAmount,
            lunchAmount,
            dinnerAmount,
            total
          ]
        );
        // Sum the same capped per-line total that was just inserted, rather
        // than recomputing mealsCount * configuredMealValue uncapped — a
        // MEAL-kind line only ever bills up to 3 slots (breakfast/lunch/
        // dinner), so an uncapped recompute could leave requested_total
        // overstating the sum of the advance's own line items.
        runningTotal += total;
      }

      await client.query(`UPDATE advance_requests SET requested_total=$2, updated_at=now() WHERE id=$1`, [req.params.id, runningTotal]);
      return runningTotal;
    });

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
      const lines = await query<{ breakfast: string; lunch: string; dinner: string; line_total: string }>(`SELECT breakfast, lunch, dinner, line_total FROM advance_lines WHERE advance_request_id=$1`, [adv.id]);
      const total = lines.reduce((sum, line) => {
        const storedTotal = Number(line.line_total || 0);
        return sum + (storedTotal > 0 ? storedTotal : Number(line.breakfast || 0) + Number(line.lunch || 0) + Number(line.dinner || 0));
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

      const isEligible = (u: { id: string; role: string; section_id: string | null; department: string | null } | undefined) => {
        if (!u) return false;
        // A requester can never name themself as their own countersigner/approver.
        if (u.id === adv.requester_id) return false;
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
      requesterRole: requester.role,
      requesterId: adv.requester_id
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
      // A step can have more than one assigned person — notify every one of
      // them, not just the first, so whoever's free can act first.
      const firstStepApprovers = chain[0]?.approvers?.length
        ? chain[0].approvers.map((a) => ({ id: a.id, name: a.name, email: a.email, title: a.title || chain[0].position_name }))
        : chain[0]
        ? [{ id: chain[0].approver_id, name: chain[0].approver_name, email: chain[0].approver_email, title: chain[0].approver_title || chain[0].position_name }]
        : [];
      await notifyAdvanceTask({
        advanceId: adv.id,
        status: firstStatus,
        advanceType: notificationContext.type,
        requesterName: notificationContext.full_name,
        requesterEmail: notificationContext.email,
        department: notificationContext.department,
        requestedTotal: Number(notificationContext.requested_total),
        currency: notificationContext.currency,
        nextApprover: firstStepApprovers[0] ?? null,
        stepOrder: 0
      });
      for (const extra of firstStepApprovers.slice(1)) {
        if (!extra.email) continue;
        await notifyAdvanceTask({
          advanceId: adv.id,
          status: firstStatus,
          advanceType: notificationContext.type,
          requesterName: notificationContext.full_name,
          requesterEmail: notificationContext.email,
          department: notificationContext.department,
          requestedTotal: Number(notificationContext.requested_total),
          currency: notificationContext.currency,
          nextApprover: extra,
          stepOrder: 0
        });
      }
    }
    return res.json({ ok: true, status: firstStatus });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/rollback", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for rollback", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    const role = req.user!.role;
    const userId = req.user!.userId;

    if (!adv.approval_chain?.length) {
      throw badRequest("This advance does not have an active approval workflow to roll back.");
    }
    // Workflow-driven: only the current step's approver (or ADMIN) can roll back
    const chain = adv.approval_chain as ChainStep[];
    const stepIdx = adv.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    if (!group.indices.length) throw badRequest("No active workflow step to roll back");
    const delegatedManagerIds = await getDelegatedManagerIds(userId, "ADVANCE_REQUEST");
    let currentStep: ChainStep | undefined = chain[group.indices[0]];
    if (role !== "ADMIN") {
      currentStep = undefined;
      for (const idx of group.indices) {
        if (await canApproveStep(chain[idx], userId, role, delegatedManagerIds, req.user!.sectionId)) { currentStep = chain[idx]; break; }
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

    const notificationContext = await getAdvanceNotificationContext(adv.id);
    if (notificationContext) {
      await notifyAdvanceTask({
        advanceId: adv.id,
        status: "DRAFT",
        advanceType: notificationContext.type,
        requesterName: notificationContext.full_name,
        requesterEmail: notificationContext.email,
        department: notificationContext.department,
        requestedTotal: Number(notificationContext.requested_total),
        currency: notificationContext.currency,
        comments: parsed.data.comments
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
  actor: { userId: string; role: string; sectionId: string | null },
  comments: string
): Promise<{ status: AdvanceStatus }> {
  const adv = await getAdvanceById(advanceId);
  if (!adv) throw notFound();

  const { role, userId, sectionId } = actor;

  if (!adv.approval_chain?.length) {
    throw badRequest("This advance does not have an active approval workflow to reject.");
  }
  // Workflow-driven: only the current step's approver (or ADMIN) can reject
  const chain = adv.approval_chain as ChainStep[];
  const stepIdx = adv.workflow_step_order ?? 0;
  const group = getPendingGroup(chain, stepIdx);
  if (!group.indices.length) throw badRequest("No active workflow step to reject");
  const delegatedManagerIds = await getDelegatedManagerIds(userId, "ADVANCE_REQUEST");
  let currentStep: ChainStep | undefined = chain[group.indices[0]];
  if (role !== "ADMIN") {
    currentStep = undefined;
    for (const idx of group.indices) {
      if (await canApproveStep(chain[idx], userId, role, delegatedManagerIds, sectionId)) { currentStep = chain[idx]; break; }
    }
    if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
    if (currentStep.can_reject === false) throw forbidden("This step does not allow rejection");
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
      requesterEmail: notificationContext.email,
      department: notificationContext.department,
      requestedTotal: Number(notificationContext.requested_total),
      currency: notificationContext.currency,
      comments
    });
  }
  return { status };
}

advancesRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());
    const result = await performAdvanceReject(
      req.params.id,
      { userId: req.user!.userId, role: req.user!.role, sectionId: req.user!.sectionId ?? null },
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
      { userId: req.user!.userId, role: req.user!.role, sectionId: req.user!.sectionId ?? null },
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
  actor: { userId: string; role: string; sectionId: string | null },
  approvedTotal: number
): Promise<{ status: AdvanceStatus }> {
  const adv = await getAdvanceById(advanceId);
  if (!adv) throw notFound();

  if (["APPROVED", "PAID", "REJECTED", "CANCELLED"].includes(adv.status)) {
    throw badRequest("This advance cannot be approved in its current state");
  }

  const { role, userId, sectionId } = actor;
  const delegatedManagerIds = await getDelegatedManagerIds(userId, "ADVANCE_REQUEST");

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
      delegatedManagerIds,
      userSectionId: sectionId,
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
  } else {
    throw forbidden("This advance does not have an active approval workflow. Please configure a workflow in the Workflow Builder.");
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
      currency: notificationContext.currency,
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
          currency: notificationContext.currency,
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
        currency: notificationContext.currency,
        paidReference: notificationContext.paid_reference
      });
    }
  }
  return { status: nextStatus };
}

const MarkPaidSchema = z.object({});

advancesRouter.post("/:id/mark-paid", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = MarkPaidSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    // Normally only the Finance department/ADMIN can mark an advance as paid.
    // Workflow-driven advances may instead name a specific person/team as the
    // MARK_PAID step — that person also needs to be able to mark the advance
    // paid once their step has completed, even if they're not in Finance.
    const role = req.user!.role;

    // Locks the row (SELECT ... FOR UPDATE) inside a transaction so two
    // concurrent "Mark as Paid" clicks on the same advance can't both pass
    // the status check and each generate their own payment_ref_seq value —
    // the second waits for the first's transaction to commit, then sees the
    // already-PAID status and is rejected by nextStatusOrThrow/precondition
    // checks below instead of silently overwriting the first reference.
    const { status, paidReference, priorStatus } = await withTransaction(async (client) => {
      const lockedRows = await client.query<{ status: AdvanceStatus; workflow_step_order: number | null; approval_chain: ChainStep[] | null }>(
        `SELECT status, workflow_step_order, approval_chain FROM advance_requests WHERE id=$1 FOR UPDATE`,
        [adv.id]
      );
      const locked = lockedRows.rows[0];
      if (!locked) throw notFound();
      const chain = (locked.approval_chain as ChainStep[] | null) || [];
      // The MARK_PAID step isn't necessarily exactly at workflow_step_order — it
      // may be one member of a "both must approve" parallel stage alongside
      // other (non-payment) steps, so look for it within the current pending
      // group rather than indexing workflow_step_order directly.
      const group = chain.length ? getPendingGroup(chain, locked.workflow_step_order ?? 0) : { indices: [], steps: [] };
      const markPaidIdx = group.indices.find((idx) => chain[idx]?.action_type === "MARK_PAID" && !chain[idx]?.approved);
      const markPaidStep = markPaidIdx != null ? chain[markPaidIdx] : null;

      let status: AdvanceStatus;
      let newChain: ChainStep[] | undefined;
      let newWorkflowStepOrder: number | undefined;

      if (markPaidStep) {
        // ADMIN is intentionally excluded here — Admin can view payments but must not
        // be able to mark them paid, only the workflow's actual assigned payer can.
        const isAuthorized = await canApproveStep(markPaidStep, req.user!.userId, role, undefined, req.user!.sectionId);
        if (!isAuthorized) throw forbidden("You are not the assigned payer for this step");

        newChain = chain.map((s, i) => (i === markPaidIdx ? { ...s, approved: true } : s));
        const stillPending = group.indices.some((idx) => !newChain![idx].approved);
        if (stillPending) {
          // Other (non-payment) members of this parallel stage haven't finished yet —
          // record this step's completion but the advance isn't fully PAID until they do.
          status = locked.status;
          newWorkflowStepOrder = locked.workflow_step_order ?? 0;
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
        // ADMIN is intentionally excluded here too — view-only for Admin.
        if (!(await isCompensationFinanceSection(req.user!.sectionId)) && !isFinalStepAuthorized) {
          throw forbidden("Only Finance can mark an advance as paid");
        }
        status = nextStatusOrThrow(locked.status, "MARK_PAID");
      }

      const isNowPaid = status === "PAID";
      let paidReference: string | null = null;
      if (isNowPaid) {
        const seqRows = await client.query<{ seq: string }>(`SELECT nextval('payment_ref_seq') AS seq`);
        paidReference = formatPaymentReference(Number(seqRows.rows[0].seq));
      }
      if (newChain) {
        await client.query(
          `UPDATE advance_requests SET status=$2, workflow_step_order=$3, approval_chain=$4, paid_reference=$5,
                  paid_at = CASE WHEN $6 THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1`,
          [adv.id, status, newWorkflowStepOrder, JSON.stringify(newChain), paidReference, isNowPaid]
        );
      } else {
        await client.query(
          `UPDATE advance_requests SET status=$2, paid_reference=$3,
                  paid_at = CASE WHEN $4 THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1`,
          [adv.id, status, paidReference, isNowPaid]
        );
      }
      if (isNowPaid) {
        // Any accommodation booking HR sent to Finance for this advance follows
        // the advance's own capture/payment flow rather than needing its own
        // separate "mark paid" action - paying the advance pays it too, with
        // the same reference. Updated in the same transaction so a crash
        // between the two can't leave the advance PAID with its
        // accommodation booking stuck SUBMITTED forever.
        await client.query(
          `UPDATE accommodation_requests SET status='PAID', paid_reference=$2, paid_at=now(), updated_at=now()
            WHERE advance_request_id=$1 AND status='SUBMITTED'`,
          [adv.id, paidReference]
        );
      }
      return { status, paidReference, priorStatus: locked.status };
    });

    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_MARK_PAID",
      before: { status: priorStatus },
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
          currency: paidCtx.currency,
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
        requestedTotal: Number(cancelCtx.requested_total),
        currency: cancelCtx.currency
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
    const pendingStatuses = ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER", "APPROVED"];
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
      currency:       adv.currency,
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
