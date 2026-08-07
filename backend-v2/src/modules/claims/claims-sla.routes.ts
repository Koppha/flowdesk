import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { hoursBetween, type ChainStep } from "../../lib/workflowEngine.js";
import { normalizeWorkflowRouteCode } from "../../lib/workflowRouting.js";

export const claimsSlaRouter = Router();
claimsSlaRouter.use(requireAuth);

const FEATURE_KEY = "claims_sla_report";
const FALLBACK_ROLES = ["ADMIN", "FINANCE"] as const;
const DEFAULT_CODE = "*";

// ── SLA matrix (admin-configurable day-thresholds per workflow step type) ───

claimsSlaRouter.get("/sla-thresholds", requireFeatureAccess(FEATURE_KEY, [...FALLBACK_ROLES]), async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<{ id: string; position_type_code: string; sla_days: number }>(
      `SELECT id, position_type_code, sla_days FROM clearance_sla_thresholds ORDER BY (position_type_code = '*'), position_type_code`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const ThresholdsSchema = z.object({
  thresholds: z.array(z.object({
    position_type_code: z.string().trim().min(1),
    sla_days: z.coerce.number().int().min(0)
  })).min(1)
});

claimsSlaRouter.put("/sla-thresholds", requireFeatureAccess(FEATURE_KEY, [...FALLBACK_ROLES]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ThresholdsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid thresholds payload", parsed.error.flatten());

    const hasDefault = parsed.data.thresholds.some((t) => normalizeCode(t.position_type_code) === DEFAULT_CODE);
    if (!hasDefault) throw badRequest(`A default ("${DEFAULT_CODE}") threshold row is required`);

    const codes = parsed.data.thresholds.map((t) => normalizeCode(t.position_type_code));
    await query(`DELETE FROM clearance_sla_thresholds WHERE position_type_code != ALL($1)`, [codes]);
    for (const t of parsed.data.thresholds) {
      await query(
        `INSERT INTO clearance_sla_thresholds (position_type_code, sla_days, updated_by_id, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (position_type_code) DO UPDATE SET sla_days = $2, updated_by_id = $3, updated_at = now()`,
        [normalizeCode(t.position_type_code), t.sla_days, req.user!.userId]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

function normalizeCode(code: string) {
  const trimmed = code.trim();
  return trimmed === DEFAULT_CODE ? DEFAULT_CODE : normalizeWorkflowRouteCode(trimmed);
}

// ── Per-approver SLA report ─────────────────────────────────────────────────

type SlaStatus = "on_time" | "late" | "at_risk" | "pending" | "no_data";

claimsSlaRouter.get("/sla-report", requireFeatureAccess(FEATURE_KEY, [...FALLBACK_ROLES]), async (req: AuthedRequest, res, next) => {
  try {
    const periodDays = Number(req.query.period_days || 90);

    const matrixRows = await query<{ position_type_code: string; sla_days: number }>(
      `SELECT position_type_code, sla_days FROM clearance_sla_thresholds`
    );
    const matrix = new Map(matrixRows.map((r) => [r.position_type_code, r.sla_days]));
    const defaultDays = matrix.get(DEFAULT_CODE) ?? 3;
    const thresholdFor = (code: string) => matrix.get(normalizeWorkflowRouteCode(code)) ?? defaultDays;

    const rows = await query<any>(
      `SELECT c.id, c.status, c.claim_total, c.submitted_at, c.created_at, c.approval_chain,
              u.full_name AS claimant_name, u.department
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
        WHERE c.created_at >= now() - ($1 || ' days')::interval
          AND c.approval_chain IS NOT NULL
        ORDER BY c.created_at DESC`,
      [periodDays]
    );

    const byApprover: Record<string, {
      approver_id: string; approver_name: string;
      on_time: number; late: number; at_risk: number; pending: number; no_data: number;
      turnaround_hours: number[];
    }> = {};
    const lateApprovals: any[] = [];
    let totalOnTime = 0, totalLate = 0, totalAtRisk = 0, totalPending = 0, totalNoData = 0;

    for (const claim of rows) {
      const chain: ChainStep[] = Array.isArray(claim.approval_chain) ? claim.approval_chain : [];
      let previousTimestamp: string | null = claim.submitted_at || claim.created_at;

      for (const step of chain) {
        if (!step.approver_id) { previousTimestamp = step.approved_at || previousTimestamp; continue; }

        const key = step.approver_id;
        if (!byApprover[key]) {
          byApprover[key] = {
            approver_id: step.approver_id, approver_name: step.approver_name || "Unknown",
            on_time: 0, late: 0, at_risk: 0, pending: 0, no_data: 0, turnaround_hours: []
          };
        }
        const bucket = byApprover[key];
        const thresholdHours = thresholdFor(step.position_type_code) * 24;

        let status: SlaStatus;
        let hours: number | null = null;

        if (step.approved && step.approved_at) {
          hours = hoursBetween(previousTimestamp, step.approved_at);
          status = hours != null && hours <= thresholdHours ? "on_time" : "late";
        } else if (step.approved && !step.approved_at) {
          status = "no_data";
        } else {
          const pendingHours = hoursBetween(previousTimestamp, new Date().toISOString()) ?? 0;
          status = pendingHours > thresholdHours ? "late" : pendingHours > thresholdHours * 0.75 ? "at_risk" : "pending";
        }

        if (status === "on_time") { bucket.on_time++; totalOnTime++; }
        else if (status === "late") {
          bucket.late++; totalLate++;
          lateApprovals.push({
            claim_id: claim.id, claimant_name: claim.claimant_name, department: claim.department,
            approver_name: step.approver_name, position_name: step.position_name,
            hours_late: hours != null ? Math.round((hours - thresholdHours) * 10) / 10 : null,
            still_pending: !step.approved
          });
        } else if (status === "at_risk") { bucket.at_risk++; totalAtRisk++; }
        else if (status === "pending") { bucket.pending++; totalPending++; }
        else { bucket.no_data++; totalNoData++; }

        if (hours != null) bucket.turnaround_hours.push(hours);
        if (step.approved_at) previousTimestamp = step.approved_at;
        if (!step.approved) break; // steps after the first pending one haven't started yet
      }
    }

    const avgHrs = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
    const byApproverOut = Object.values(byApprover)
      .map((b) => ({
        approver_id: b.approver_id, approver_name: b.approver_name,
        on_time: b.on_time, late: b.late, at_risk: b.at_risk, pending: b.pending, no_data: b.no_data,
        avg_turnaround_hours: avgHrs(b.turnaround_hours)
      }))
      .sort((a, b) => b.late - a.late);

    return res.json({
      thresholds: matrixRows,
      summary: { on_time: totalOnTime, late: totalLate, at_risk: totalAtRisk, pending: totalPending, no_data: totalNoData },
      by_approver: byApproverOut,
      late_approvals: lateApprovals
    });
  } catch (err) {
    return next(err);
  }
});
