import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { getNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { notifyOvertimeClaimClosed, notifyStandbyClaimClosed, notifyStandbyCalloutClosed } from "../../lib/notifications.js";

// Overtime, Standby, and Standby Call-Out claims all follow the same
// post-approval lifecycle: the last approver's sign-off lands the claim in
// AWAITING_TREASURY (not a final state — see overtime.routes.ts/
// standby.routes.ts's performOvertimeClaimApprove/performStandbyClaimApprove/
// the callout approve route), and this module is where a Treasury user
// reviews it and performs the one and only terminal action: Close Claim.
// FlowDesk does not do payroll — Treasury takes the approved hours for
// processing outside FlowDesk and closes the claim; nothing past that is
// tracked here.
export const compensationClaimsRouter = Router();
compensationClaimsRouter.use(requireAuth);

type ClaimType = "OVERTIME" | "STANDBY" | "CALL_OUT";

const TABLE_BY_TYPE: Record<ClaimType, string> = {
  OVERTIME: "overtime_claims",
  STANDBY: "standby_claims",
  CALL_OUT: "standby_callout_claims"
};

const APPROVAL_TABLE_BY_TYPE: Record<ClaimType, string> = {
  OVERTIME: "overtime_claim_approval_steps",
  STANDBY: "standby_approval_steps",
  CALL_OUT: "standby_callout_approval_steps"
};

function parseType(raw: string): ClaimType {
  const type = String(raw).toUpperCase() as ClaimType;
  if (!TABLE_BY_TYPE[type]) throw badRequest("Unknown claim type");
  return type;
}

const LIST_SQL = `
  SELECT 'OVERTIME' AS claim_type, c.id, c.claim_no, u.full_name AS employee_name, u.employee_no,
         dv.name AS division_name, u.department, t.name AS section_name, c.converted_hours AS hours, c.equivalent_days,
         NULL::text AS detail, c.status, c.submitted_at, c.closed_at, c.processed_at, pb.full_name AS processed_by_name
    FROM overtime_claims c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN users pb ON pb.id = c.processed_by_id
   WHERE c.status IN ('AWAITING_TREASURY','CLOSED')
  UNION ALL
  SELECT 'STANDBY' AS claim_type, c.id, c.claim_no, u.full_name AS employee_name, u.employee_no,
         dv.name AS division_name, u.department, t.name AS section_name, c.compensable_hours AS hours, NULL::numeric AS equivalent_days,
         to_char(c.claim_month, 'Mon YYYY') AS detail, c.status, c.submitted_at, c.closed_at, c.processed_at, pb.full_name AS processed_by_name
    FROM standby_claims c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN users pb ON pb.id = c.processed_by_id
   WHERE c.status IN ('AWAITING_TREASURY','CLOSED')
  UNION ALL
  SELECT 'CALL_OUT' AS claim_type, c.id, c.claim_no, u.full_name AS employee_name, u.employee_no,
         dv.name AS division_name, u.department, t.name AS section_name, c.converted_hours AS hours, NULL::numeric AS equivalent_days,
         c.call_date::text || ' ' || c.start_time::text || '–' || c.end_time::text AS detail,
         c.status, c.submitted_at, c.closed_at, c.processed_at, pb.full_name AS processed_by_name
    FROM standby_callout_claims c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN users pb ON pb.id = c.processed_by_id
   WHERE c.status IN ('AWAITING_TREASURY','CLOSED')
`;

// Lightweight, always-200 check the frontend uses to decide whether to show
// the nav item (and its pending-count badge) at all — mirrors Deductions'/
// Refundable's own /access route exactly.
compensationClaimsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await isCompensationFinanceUser(req);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM overtime_claims WHERE status='AWAITING_TREASURY') +
         (SELECT count(*) FROM standby_claims WHERE status='AWAITING_TREASURY') +
         (SELECT count(*) FROM standby_callout_claims WHERE status='AWAITING_TREASURY')
       )::text AS count`
    );
    return res.json({ allowed, pendingCount: Number(pending[0]?.count || 0) });
  } catch (err) {
    return next(err);
  }
});

// Every route below requires Finance/Treasury authority.
compensationClaimsRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden("You do not have access to Compensation Claims");
    next();
  } catch (err) {
    next(err);
  }
});

compensationClaimsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`${LIST_SQL} ORDER BY submitted_at DESC NULLS LAST`);
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

async function loadApprovalHistory(type: ClaimType, claimId: string, currentRouteVersion: number) {
  const table = APPROVAL_TABLE_BY_TYPE[type];
  const approval_steps = await query<any>(
    `SELECT s.*, u.full_name AS approver_name FROM ${table} s JOIN users u ON u.id = s.approver_user_id
      WHERE s.claim_id=$1 AND s.route_version=$2 ORDER BY s.step_order`,
    [claimId, currentRouteVersion]
  );
  const route_history = currentRouteVersion > 1
    ? await query<any>(
        `SELECT s.*, u.full_name AS approver_name FROM ${table} s JOIN users u ON u.id = s.approver_user_id
          WHERE s.claim_id=$1 AND s.route_version < $2 ORDER BY s.route_version, s.step_order`,
        [claimId, currentRouteVersion]
      )
    : [];
  return { approval_steps, route_history };
}

const EMPLOYEE_JOIN_SQL = `
  JOIN users u ON u.id = c.employee_id
  LEFT JOIN divisions dv ON dv.id = u.division_id
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN users pb ON pb.id = c.processed_by_id
`;
const EMPLOYEE_FIELDS_SQL = `
  u.full_name AS employee_name, u.employee_no, u.title AS position, u.department,
  dv.name AS division_name, t.name AS section_name, pb.full_name AS processed_by_name
`;

// Full detail for the Treasury claim screen — one endpoint, branching by
// type for the parts that genuinely differ (rate breakdown / line items /
// period label), sharing everything else (employee info, approval history
// shape, treasury fields).
compensationClaimsRouter.get("/:type/:id", async (req: AuthedRequest, res, next) => {
  try {
    const type = parseType(req.params.type);
    const id = req.params.id;

    if (type === "OVERTIME") {
      const claim = (await query<any>(
        `SELECT c.*, ${EMPLOYEE_FIELDS_SQL} FROM overtime_claims c ${EMPLOYEE_JOIN_SQL} WHERE c.id=$1 AND c.status IN ('AWAITING_TREASURY','CLOSED')`,
        [id]
      ))[0];
      if (!claim) throw notFound("Claim not found");
      const lines = Array.isArray(claim.lines) ? claim.lines : [];
      const bucket = (pct: 125 | 150 | 200) => {
        const hours = lines.reduce((s: number, l: any) => s + Number(l[`hours_${pct}`] || 0), 0);
        return { rate: `${pct}%`, hours: Math.round(hours * 100) / 100, converted_hours: Math.round(hours * (pct / 100) * 100) / 100 };
      };
      const rate_breakdown = [bucket(125), bucket(150), bucket(200)];
      const { approval_steps, route_history } = await loadApprovalHistory(type, id, claim.current_route_version);
      return res.json({
        claim_type: type, ...claim,
        period_label: `${new Date(claim.year, claim.month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`,
        rate_breakdown, lines, approval_steps, route_history
      });
    }

    if (type === "STANDBY") {
      const claim = (await query<any>(
        `SELECT c.*, ${EMPLOYEE_FIELDS_SQL} FROM standby_claims c ${EMPLOYEE_JOIN_SQL} WHERE c.id=$1 AND c.status IN ('AWAITING_TREASURY','CLOSED')`,
        [id]
      ))[0];
      if (!claim) throw notFound("Claim not found");
      const rawLines = await query<any>(
        `SELECT sl.*, sr.id AS roster_id, sr.roster_month, t.name AS roster_team_name FROM standby_claim_lines sl
           LEFT JOIN standby_assignments sa ON sa.id = sl.assignment_id
           LEFT JOIN standby_rosters sr ON sr.id = sa.roster_id
           LEFT JOIN teams t ON t.id = sr.team_id
          WHERE sl.claim_id=$1 ORDER BY sl.standby_date`,
        [id]
      );
      const totalHours = Number(claim.total_standby_hours || 0);
      const compensableHours = Number(claim.compensable_hours || 0);
      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const lines = rawLines.map((l: any) => {
        // Distributed proportionally from the claim's real (stored)
        // compensable_hours, so the displayed rows always sum to exactly
        // that figure regardless of any later change to the compensable
        // rate setting — this is a display breakdown, not a recomputation.
        const share = totalHours > 0 ? Number(l.hours) / totalHours : 0;
        return {
          standby_date: l.standby_date, day: DAY_NAMES[new Date(`${l.standby_date}T00:00:00`).getDay()],
          start_time: l.start_time, end_time: l.end_time, standby_hours: Number(l.hours),
          compensable_hours: Math.round(compensableHours * share * 100) / 100
        };
      });
      const workingHoursPerDay = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.workingHoursPerDay, 8);
      const equivalent_days = workingHoursPerDay > 0 ? Math.round((compensableHours / workingHoursPerDay) * 1000) / 1000 : 0;
      const { approval_steps, route_history } = await loadApprovalHistory(type, id, claim.current_route_version);
      return res.json({
        claim_type: type, ...claim,
        period_label: new Date(claim.claim_month).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
        equivalent_days, lines,
        roster_id: rawLines[0]?.roster_id || null,
        roster_label: rawLines[0]?.roster_team_name
          ? `${rawLines[0].roster_team_name} — ${new Date(rawLines[0].roster_month).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`
          : null,
        approval_steps, route_history
      });
    }

    // CALL_OUT
    const claim = (await query<any>(
      `SELECT c.*, ${EMPLOYEE_FIELDS_SQL} FROM standby_callout_claims c ${EMPLOYEE_JOIN_SQL} WHERE c.id=$1 AND c.status IN ('AWAITING_TREASURY','CLOSED')`,
      [id]
    ))[0];
    if (!claim) throw notFound("Claim not found");
    const rate_breakdown = [{ rate: `${claim.rate_pct}%`, hours: Number(claim.hours), converted_hours: Number(claim.converted_hours) }];
    const { approval_steps, route_history } = await loadApprovalHistory(type, id, claim.current_route_version);
    return res.json({
      claim_type: type, ...claim,
      period_label: new Date(`${claim.call_date}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" }),
      rate_breakdown, approval_steps, route_history
    });
  } catch (err) {
    return next(err);
  }
});

const CloseSchema = z.object({ confirmed: z.literal(true), comment: z.string().trim().max(2000).optional() });

const CLOSED_NOTIFIER: Record<ClaimType, (claim: any) => Promise<void>> = {
  OVERTIME: async (claim) => {
    void notifyOvertimeClaimClosed({
      claimId: claim.id, claimNo: claim.claim_no, employeeName: claim.employee_name || null, employeeEmail: claim.employee_email || null,
      convertedHours: Number(claim.converted_hours || 0), equivalentDays: Number(claim.equivalent_days || 0)
    });
  },
  STANDBY: async (claim) => {
    void notifyStandbyClaimClosed({
      claimId: claim.id, claimNo: claim.claim_no, employeeName: claim.employee_name || null, employeeEmail: claim.employee_email || null,
      compensableHours: Number(claim.compensable_hours || 0)
    });
  },
  CALL_OUT: async (claim) => {
    void notifyStandbyCalloutClosed({
      claimId: claim.id, claimNo: claim.claim_no, employeeName: claim.employee_name || null, employeeEmail: claim.employee_email || null,
      convertedHours: Number(claim.converted_hours || 0)
    });
  }
};

// The one and only terminal action in this whole module — Treasury
// confirming the approved hours have been taken for processing outside
// FlowDesk. No payroll status is tracked past this point.
compensationClaimsRouter.post("/:type/:id/close", async (req: AuthedRequest, res, next) => {
  try {
    const type = parseType(req.params.type);
    const table = TABLE_BY_TYPE[type];
    const body = CloseSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Tick the Treasury Confirmation checkbox before closing this claim", body.error.flatten());

    const claim = (await query<any>(
      `SELECT c.*, u.full_name AS employee_name, u.email AS employee_email FROM ${table} c JOIN users u ON u.id = c.employee_id WHERE c.id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound("Claim not found");
    if (claim.status !== "AWAITING_TREASURY") throw badRequest("This claim is not awaiting Treasury");

    await query(
      `UPDATE ${table} SET status='CLOSED', closed_at=now(), processed_at=now(), processed_by_id=$2, treasury_comment=$3, updated_at=now() WHERE id=$1`,
      [req.params.id, req.user!.userId, body.data.comment || null]
    );
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user!.userId, "COMPENSATION_CLAIM_CLOSED", table, req.params.id, JSON.stringify({ status: claim.status }), JSON.stringify({ status: "CLOSED", comment: body.data.comment || null })]
    );

    void CLOSED_NOTIFIER[type](claim);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
