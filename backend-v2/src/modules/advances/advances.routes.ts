import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { createAdvance, getAdvanceById, nextStatusOrThrow, setAdvanceStatus } from "./advances.service.js";
import { assertUserCanRequest, canCreateAdvanceOnBehalf, getUserAccountState, isPermanentEmployee, isProfileComplete } from "../../lib/userProfile.js";
import type { AdvanceStatus } from "./advances.types.js";
import { notifyAdvanceCancelled, notifyAdvancePaid, notifyAdvanceTask } from "../../lib/notifications.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";
import { assertAdvanceTypeAllowed, getTravelRateForCode, getTravelTypeByCode, isTravelAdvanceType } from "../../lib/travel.js";
import { getDepartmentLeadership } from "../../lib/departments.js";

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

async function writeAdvanceAudit(args: {
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

async function getAdvanceNotificationContext(advanceId: string) {
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

export function canViewAdvance(args: { role: string; requesterId: string; createdById: string; userId: string; status: string; type: string }) {
  if (args.role === "ADMIN") return true;
  if (args.requesterId === args.userId) return true;
  if (args.createdById === args.userId) return true;

  const roleAllowedStatuses: Record<string, string[]> = {
    MANAGER: ["SUBMITTED", "HR_MANAGER_REVIEW", "HR_REVIEW", "CHIEF_OFFICER_REVIEW", "HR_OFFICER", "APPROVED", "PAID"],
    HR_MANAGER: ["HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER", "APPROVED", "PAID"],
    AUTH_OFFICER: ["HR_REVIEW", "HR_OFFICER", "APPROVED", "PAID"],
    CHIEF_OFFICER: ["CHIEF_OFFICER_REVIEW", "HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER", "APPROVED", "PAID"],
    FINANCE: ["HR_OFFICER", "APPROVED", "PAID"]
  };

  if (roleAllowedStatuses[args.role]?.includes(args.status)) return true;
  return false;
}

// ── SLA Report ──────────────────────────────────────────────────────────────
const SLA_TARGETS = { submission_hours: 48, approval_hours: 72, payment_hours: 48 };

function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(diff / 3_600_000 * 10) / 10;
}

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
      const totalHrs      = hoursBetween(r.created_at, r.paid_at ?? (["DRAFT","SUBMITTED","APPROVED"].includes(r.status) ? null : undefined));

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

advancesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    if (mine) {
      const rows = await query(
        `SELECT * FROM advance_requests
         WHERE requester_id=$1 OR created_by_id=$1
         ORDER BY created_at DESC`,
        [req.user!.userId]
      );
      return res.json(rows);
    }

    if (req.user?.role !== "ADMIN") throw forbidden("Only admin can list all advances");
    const rows = await query(`SELECT * FROM advance_requests ORDER BY created_at DESC`);
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
                tt.rate_general_staff AS travel_rate_general_staff,
                tt.rate_exco AS travel_rate_exco,
                tt.rate_ceo AS travel_rate_ceo,
                (tt.id IS NOT NULL AND tt.active = true) AS is_travel_type
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
         WHERE ar.id=$1`,
        [req.params.id]
      )
    )[0];
    if (!adv) throw notFound();
    if (!canViewAdvance({ role: req.user!.role, requesterId: adv.requester_id, createdById: adv.created_by_id, userId: req.user!.userId, status: adv.status, type: adv.type })) {
      throw forbidden();
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
    if (await isTravelAdvanceType(adv.type)) {
      const row = (await query<{ count: string }>(`SELECT count(*)::text AS count FROM advance_lines WHERE advance_request_id=$1`, [adv.id]))[0];
      if (!row || Number(row.count) < 1) throw badRequest("At least one travel table entry is required");
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

    if (adv.status !== "DRAFT" && adv.status !== "SUBMITTED") {
      throw badRequest("Only draft advances can be submitted");
    }

    const leadership = await getDepartmentLeadership(adv.requester_department || "");
    const hasOverrideChain = Array.isArray(adv.override_chain) && adv.override_chain.length > 0;
    if (!leadership.manager_user_id && !hasOverrideChain) {
      throw badRequest("No manager assigned to this department. Please define a custom approval chain for this request.");
    }
    const validationWarning = leadership.exco_user_id ? null
      : hasOverrideChain ? null
      : "No EXCO owner assigned to this department.";

    const nextStatus = "SUBMITTED";
    if (adv.status === "SUBMITTED") {
      await setAdvanceStatus(adv.id, nextStatus);
    } else {
      await query(`UPDATE advance_requests SET status=$2, submitted_at=now(), updated_at=now() WHERE id=$1`, [adv.id, nextStatus]);
    }

    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_SUBMIT",
      before: { status: adv.status },
      after: { status: nextStatus }
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
        requestedTotal: Number(notificationContext.requested_total)
      });
    }
    return res.json({ ok: true, status: nextStatus, warning: validationWarning });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/rollback", requireRole(["MANAGER", "HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for rollback", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (req.user!.role === "AUTH_OFFICER" && adv.status !== "HR_REVIEW") {
      throw forbidden("HR can only roll back advances pending HR review");
    }
    if (req.user!.role === "HR_MANAGER" && adv.status !== "HR_MANAGER_REVIEW") {
      throw forbidden("HR Manager can only roll back advances pending HR Manager review");
    }
    if (req.user!.role === "CHIEF_OFFICER" && adv.status !== "CHIEF_OFFICER_REVIEW") {
      throw forbidden("Chief Officer can only roll back advances pending Chief Officer review");
    }

    const status = nextStatusOrThrow(adv.status, "ROLLBACK");
    await setAdvanceStatus(adv.id, status);
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_ROLLBACK",
      before: { status: adv.status },
      after: { status, comments: parsed.data.comments }
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
        requestedTotal: Number(notificationContext.requested_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/reject", requireRole(["MANAGER", "HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "FINANCE", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();
    if (req.user!.role === "AUTH_OFFICER" && adv.status !== "HR_REVIEW") {
      throw forbidden("HR can only reject advances pending HR review");
    }
    if (req.user!.role === "HR_MANAGER" && adv.status !== "HR_MANAGER_REVIEW") {
      throw forbidden("HR Manager can only reject advances pending HR Manager review");
    }
    if (req.user!.role === "CHIEF_OFFICER" && adv.status !== "CHIEF_OFFICER_REVIEW") {
      throw forbidden("Chief Officer can only reject advances pending Chief Officer review");
    }
    if (
      req.user!.role === "FINANCE" &&
      !["HR_OFFICER", "APPROVED"].includes(adv.status)
    ) {
      throw forbidden("Finance can only reject HR-approved advances pending payment");
    }

    const status = nextStatusOrThrow(adv.status, "REJECT");
    await setAdvanceStatus(adv.id, status);
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_REJECT",
      before: { status: adv.status },
      after: { status, comments: parsed.data.comments }
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
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/approve", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    const delegated = await getActiveManagerDelegation(req.user!.userId);
    const hasManagerPrivilege = req.user!.role === "MANAGER" || Boolean(delegated);
    if (!hasManagerPrivilege && !["HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "ADMIN"].includes(req.user!.role)) {
      throw forbidden("Not authorized to approve this advance");
    }
    const leadership = await getDepartmentLeadership(adv.requester_department || "");

    if (hasManagerPrivilege && adv.status === "SUBMITTED") {
      const requesterDepartment = String(adv.requester_department || "").trim();
      const managerDepartment = delegated
        ? String(delegated.department || "").trim()
        : String(req.user!.department || "").trim();
      if (!managerDepartment || managerDepartment !== requesterDepartment) {
        throw forbidden("Only the requester’s department manager or delegated manager can approve this advance");
      }
      if (!leadership.manager_user_id) {
        throw badRequest("No manager assigned to this department.");
      }
      const effectiveManagerId = delegated ? delegated.manager_id : req.user!.userId;
      if (leadership.manager_user_id !== effectiveManagerId) {
        throw forbidden("Only the assigned department manager or delegated manager can approve this advance");
      }
    }

    let status: AdvanceStatus;
    if (req.user!.role === "AUTH_OFFICER") {
      if (adv.status !== "HR_REVIEW") {
        throw forbidden("HR can only approve advances pending HR review");
      }
      status = nextStatusOrThrow(adv.status, "APPROVE");
    } else if (req.user!.role === "HR_MANAGER") {
      if (adv.status !== "HR_MANAGER_REVIEW") {
        throw forbidden("HR Manager can only approve advances pending HR Manager review");
      }
      status = nextStatusOrThrow(adv.status, "APPROVE");
    } else if (req.user!.role === "CHIEF_OFFICER") {
      if (adv.status !== "CHIEF_OFFICER_REVIEW") {
        throw forbidden("Chief Officer can only approve advances pending Chief Officer review");
      }
      if (!leadership.exco_user_id) {
        throw badRequest("No EXCO owner assigned to this department.");
      }
      if (leadership.exco_user_id !== req.user!.userId) {
        throw forbidden("Only the assigned EXCO owner can approve this advance");
      }
      status = nextStatusOrThrow(adv.status, "APPROVE");
    } else if (req.user!.role === "ADMIN") {
      status = adv.status === "SUBMITTED" && !leadership.exco_user_id
        ? "HR_OFFICER"
        : nextStatusOrThrow(adv.status, "APPROVE");
    } else {
      if (adv.status !== "SUBMITTED") {
        throw forbidden("Managers can only approve submitted advances");
      }
      status = leadership.exco_user_id ? nextStatusOrThrow(adv.status, "APPROVE") : "HR_OFFICER";
    }
    let actingFor: { id: string; name: string | null } | undefined;
    if (delegated && hasManagerPrivilege && req.user!.role !== "MANAGER") {
      const onBehalfOf = await getUserAccountState(delegated.manager_id);
      actingFor = { id: onBehalfOf.id, name: onBehalfOf.full_name };
    }

    await setAdvanceStatus(adv.id, status, { approvedTotal: parsed.data.approved_total });
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_APPROVE",
      before: { status: adv.status, approved_total: Number(adv.approved_total || 0) },
      after: { status, approved_total: parsed.data.approved_total, ...(actingFor ? { acting_for: actingFor } : {}) }
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
        requestedTotal: Number(notificationContext.requested_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

advancesRouter.post("/:id/mark-paid", requireRole(["FINANCE", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const adv = await getAdvanceById(req.params.id);
    if (!adv) throw notFound();

    const status = nextStatusOrThrow(adv.status, "MARK_PAID");
    await setAdvanceStatus(adv.id, status);
    await writeAdvanceAudit({
      actorId: req.user!.userId,
      advanceId: adv.id,
      action: "ADVANCE_MARK_PAID",
      before: { status: adv.status },
      after: { status }
    });
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
