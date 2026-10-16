import { Router } from "express";
import { type AuthedRequest, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { sendCsv } from "../../lib/csvExport.js";
import { getViewerDivisionScope } from "../../lib/divisionScope.js";
import { withTripDetails } from "../../lib/clearanceTrip.js";

// Same company-scoping rule as the Capture Inbox (see inbox.routes.ts's
// getViewerDivisionScope usage) - a non-admin Treasury/Finance viewer only
// ever sees their own company's clearances, not every division's, even
// though treasury_processing can be granted to more than one company's
// team at once (e.g. MNO's Treasury team and SEFS's Finance Operations).
// null means "no restriction" (ADMIN, or a division with no scope mapping).
async function getReportDivisionScope(req: AuthedRequest): Promise<string[] | null> {
  return getViewerDivisionScope(req.user!.userId, req.user!.role === "ADMIN");
}

// "Trip Clearance Reports" - all 8 reports from the Finance Treasury spec.
// Every report is filtered server-side (date range, division, department,
// employee, financial_outcome, workflow/treasury status) so large datasets
// are never shipped whole to the browser just to filter client-side (unlike
// the older Report*.tsx pages' pattern) - the same query result backs both
// the on-screen table and the CSV export, so they always agree.
export const treasuryReportsRouter = Router();
treasuryReportsRouter.use(requireAuth);
treasuryReportsRouter.use(requireFeatureAccess("treasury_processing", ["ADMIN", "Section: Treasury & Financial Accounting"]));

// The traveller's place in Org Structure: company (MNO/SEFS/HigherLife =
// divisions table), real Division (users.department) and Department (the
// section they sit in, directly or through their team).
const ORG_COLUMNS = `
  dv.name AS company,
  nullif(trim(u.department), '') AS division_name,
  (SELECT s.name FROM sections s WHERE s.id = coalesce(u.section_id, (SELECT t.section_id FROM teams t WHERE t.id = u.team_id))) AS department,
`;
// Every clearance row also gets duty station (where they're based), VR date
// (advance approved), when the clearance was submitted, and the amount to
// be expensed (zero balance -> the advance; otherwise what was cleared).
// Destination/departure/return - where and when they actually travelled -
// come from the linked advance via withTripDetails after the query.
const ORG_TRIP_COLUMNS = `${ORG_COLUMNS}
  c.duty_station, c.linked_advance_id, c.submitted_at AS clearance_submitted_at,
  (SELECT ar.approved_at FROM advance_requests ar WHERE ar.id = c.linked_advance_id) AS vr_date,
  CASE WHEN coalesce(c.balance_amount, 0) = 0 THEN c.advance_amount ELSE c.claim_total END AS amount_to_be_expensed,
`;

type Filters = {
  date_from?: string; date_to?: string; employee_id?: string; company?: string; division?: string; department?: string;
  financial_outcome?: string; workflow_status?: string; treasury_status?: string;
};

function buildWhere(f: Filters, alias = "c", allowedDivisions?: string[] | null) {
  const where: string[] = [`${alias}.financial_outcome IS NOT NULL`];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.date_from) where.push(`${alias}.submitted_at >= ${p(f.date_from)}`);
  if (f.date_to) where.push(`${alias}.submitted_at <= ${p(f.date_to)}`);
  if (f.employee_id) where.push(`${alias}.claimant_id = ${p(f.employee_id)}`);
  if (f.company) where.push(`dv.name = ${p(f.company)}`);
  if (f.division) where.push(`lower(trim(u.department)) = lower(trim(${p(f.division)}))`);
  if (f.department) where.push(`EXISTS (SELECT 1 FROM sections s WHERE lower(s.name) = lower(${p(f.department)}) AND s.id = coalesce(u.section_id, (SELECT t.section_id FROM teams t WHERE t.id = u.team_id)))`);
  if (f.financial_outcome) where.push(`${alias}.financial_outcome = ${p(f.financial_outcome)}`);
  if (f.workflow_status) where.push(`${alias}.status = ${p(f.workflow_status)}`);
  if (f.treasury_status) where.push(`${alias}.treasury_settlement_status = ${p(f.treasury_status)}`);
  if (allowedDivisions) where.push(`dv.name = ANY(${p(allowedDivisions)}::text[])`);
  return { whereSql: where.join(" AND "), params };
}

async function respond(req: AuthedRequest, res: any, filename: string, headers: string[], rowsToCsv: (r: any) => (string | number | null)[], rowsIn: any[]) {
  // Row reports get where/when they travelled; aggregated reports pass through.
  const rows = rowsIn.length && "linked_advance_id" in rowsIn[0] ? await withTripDetails(rowsIn) : rowsIn;
  if (req.query.format === "csv") {
    return sendCsv(res, filename, headers, rows.map(rowsToCsv));
  }
  return res.json({ items: rows });
}

// 8.1 Clearance Summary Report
treasuryReportsRouter.get("/clearance-summary", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere(req.query as Filters, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, c.financial_outcome, c.status, c.employee_clearance_status, ${ORG_TRIP_COLUMNS}
              c.advance_amount, c.claim_total AS verified_expenses, c.balance_amount, COALESCE(c.currency, 'LSL') AS currency,
              to_char(date_trunc('month', c.submitted_at), 'YYYY-MM') AS month,
              u.full_name AS employee_name, u.employee_no
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}`,
      params
    );
    const totals = {
      total_trips: rows.length,
      total_advances: rows.reduce((s, r) => s + Number(r.advance_amount || 0), 0),
      total_verified_expenses: rows.reduce((s, r) => s + Number(r.verified_expenses || 0), 0),
      balanced_count: rows.filter((r) => r.financial_outcome === "BALANCED").length,
      refund_count: rows.filter((r) => r.financial_outcome === "REFUND_DUE").length,
      refund_value: rows.filter((r) => r.financial_outcome === "REFUND_DUE").reduce((s, r) => s + Math.abs(Number(r.balance_amount || 0)), 0),
      payback_count: rows.filter((r) => r.financial_outcome === "PAYBACK_DUE").length,
      payback_value: rows.filter((r) => r.financial_outcome === "PAYBACK_DUE").reduce((s, r) => s + Math.abs(Number(r.balance_amount || 0)), 0),
      total_outstanding_refunds: rows.filter((r) => r.financial_outcome === "REFUND_DUE" && r.status !== "COMPLETED").reduce((s, r) => s + Math.abs(Number(r.balance_amount || 0)), 0),
      total_unreconciled_paybacks: rows.filter((r) => r.financial_outcome === "PAYBACK_DUE" && r.status !== "COMPLETED").reduce((s, r) => s + Math.abs(Number(r.balance_amount || 0)), 0),
      completed_count: rows.filter((r) => r.status === "COMPLETED").length,
      in_progress_count: rows.filter((r) => r.status !== "COMPLETED").length
    };
    if (req.query.format === "csv") {
      return sendCsv(res, "clearance-summary.csv",
        ["Month", "Division", "Department", "Employee", "Outcome", "Advance", "Verified Expenses", "Status"],
        rows.map((r) => [r.month, r.division_name, r.department, r.employee_name, r.financial_outcome, r.advance_amount, r.verified_expenses, r.status]));
    }
    return res.json({ items: await withTripDetails(rows), totals });
  } catch (err) { return next(err); }
});

// 8.2 Refunds Due Report
treasuryReportsRouter.get("/refunds-due", async (req: AuthedRequest, res, next) => {
  try {
    const f = { ...(req.query as Filters), financial_outcome: "REFUND_DUE" };
    const { whereSql, params } = buildWhere(f, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, u.full_name AS employee_name, u.employee_no, ${ORG_TRIP_COLUMNS}
              c.submitted_at, c.closed_at,
              c.advance_amount, c.claim_total AS verified_expenses,
              -c.balance_amount AS refund_amount,
              c.status, c.treasury_settlement_status, c.treasury_officer_id, off.full_name AS treasury_officer_name,
              c.settled_at AS payment_date, c.settled_reference AS payment_reference, c.treasury_completed_at AS completion_date,
              EXTRACT(DAY FROM now() - c.submitted_at)::int AS days_outstanding,
              COALESCE(c.currency, 'LSL') AS currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN users off ON off.id = c.treasury_officer_id
        WHERE ${whereSql}
        ORDER BY c.submitted_at DESC`,
      params
    );
    return respond(req, res, "refunds-due.csv",
      ["Employee", "Employee No", "Division", "Department", "Destination", "Refund Amount", "Treasury Status", "Days Outstanding", "Payment Date", "Payment Reference"],
      (r) => [r.employee_name, r.employee_no, r.division_name, r.department, r.destination, r.refund_amount, r.treasury_settlement_status, r.days_outstanding, r.payment_date, r.payment_reference],
      rows);
  } catch (err) { return next(err); }
});

// 8.3 Employee Paybacks Report
treasuryReportsRouter.get("/employee-paybacks", async (req: AuthedRequest, res, next) => {
  try {
    const f = { ...(req.query as Filters), financial_outcome: "PAYBACK_DUE" };
    const { whereSql, params } = buildWhere(f, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, u.full_name AS employee_name, u.employee_no, ${ORG_TRIP_COLUMNS}
              c.advance_amount, c.claim_total AS verified_expenses, c.balance_amount AS payback_amount,
              c.payback_verified_at, c.payback_verified_by_id, verifier.full_name AS verified_by_name,
              c.treasury_settlement_status, c.treasury_reconciliation_date,
              c.settled_reference AS transaction_reference, c.treasury_posting_reference,
              (SELECT count(*) FROM clearance_payback_proofs p WHERE p.clearance_claim_id = c.id) AS submission_count,
              (SELECT min(submitted_at) FROM clearance_payback_proofs p WHERE p.clearance_claim_id = c.id) AS first_submission_date,
              CASE WHEN c.treasury_settlement_status = 'RECONCILED' THEN 0 ELSE c.balance_amount END AS outstanding_amount,
              COALESCE(c.currency, 'LSL') AS currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN users verifier ON verifier.id = c.payback_verified_by_id
        WHERE ${whereSql}
        ORDER BY c.submitted_at DESC`,
      params
    );
    return respond(req, res, "employee-paybacks.csv",
      ["Employee", "Employee No", "Division", "Department", "Payback Amount", "Submissions", "Verified By", "Verified At", "Treasury Status", "Reconciliation Date", "Outstanding"],
      (r) => [r.employee_name, r.employee_no, r.division_name, r.department, r.payback_amount, r.submission_count, r.verified_by_name, r.payback_verified_at, r.treasury_settlement_status, r.treasury_reconciliation_date, r.outstanding_amount],
      rows);
  } catch (err) { return next(err); }
});

// 8.4 Fully Cleared Trips Report - retains the ORIGINAL financial_outcome
// even after COMPLETED, per spec (this is exactly what financial_outcome
// being permanent/never-recomputed already guarantees).
treasuryReportsRouter.get("/fully-cleared", async (req: AuthedRequest, res, next) => {
  try {
    const f = { ...(req.query as Filters), workflow_status: "COMPLETED" };
    const { whereSql, params } = buildWhere(f, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, u.full_name AS employee_name, u.employee_no, ${ORG_TRIP_COLUMNS}
              c.submitted_at, c.closed_at,
              c.financial_outcome, c.advance_amount, c.claim_total AS verified_expenses, c.balance_amount,
              c.payback_verified_at AS hr_completion_date, c.treasury_completed_at AS treasury_completion_date,
              COALESCE(c.treasury_completed_at, c.closed_at) AS final_completion_date,
              EXTRACT(DAY FROM COALESCE(c.treasury_completed_at, now()) - c.submitted_at)::int AS processing_days,
              COALESCE(c.currency, 'LSL') AS currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}
        ORDER BY c.treasury_completed_at DESC`,
      params
    );
    return respond(req, res, "fully-cleared-trips.csv",
      ["Employee", "Division", "Department", "Destination", "Outcome", "Advance", "Verified Expenses", "Balance", "Treasury Completion", "Processing Days"],
      (r) => [r.employee_name, r.division_name, r.department, r.destination, r.financial_outcome, r.advance_amount, r.verified_expenses, r.balance_amount, r.treasury_completion_date, r.processing_days],
      rows);
  } catch (err) { return next(err); }
});

// 8.5 Outstanding Clearances Report - grouped by current responsible team.
treasuryReportsRouter.get("/outstanding", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere({ ...(req.query as Filters) }, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, u.full_name AS employee_name, u.employee_no, ${ORG_TRIP_COLUMNS}
              c.financial_outcome, c.status, c.balance_amount, c.advance_amount, c.claim_total AS verified_expenses,
              CASE
                WHEN c.status IN ('PAYBACK_DUE','REFUND_DUE') THEN 'Employee'
                WHEN c.status IN ('PAYBACK_PROOF_SUBMITTED','PAYBACK_PROOF_REJECTED') THEN 'HR Operations'
                WHEN c.status = 'FINANCE_TREASURY_REVIEW' THEN 'Finance Treasury'
                ELSE 'Employee'
              END AS responsible_team,
              off.full_name AS assigned_officer,
              c.submitted_at, c.updated_at AS last_action_date,
              EXTRACT(DAY FROM now() - c.submitted_at)::int AS days_outstanding,
              COALESCE(c.currency, 'LSL') AS currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN users off ON off.id = c.treasury_officer_id
        WHERE ${whereSql} AND c.status != 'COMPLETED'
        ORDER BY days_outstanding DESC`,
      params
    );
    return respond(req, res, "outstanding-clearances.csv",
      ["Employee", "Division", "Department", "Responsible Team", "Status", "Outstanding Amount", "Days Outstanding", "Assigned Officer"],
      (r) => [r.employee_name, r.division_name, r.department, r.responsible_team, r.status, r.balance_amount, r.days_outstanding, r.assigned_officer],
      rows);
  } catch (err) { return next(err); }
});

// 8.6 Ageing Report - bands computed from the date the record entered its
// current actionable stage (submitted_at for employee-owed stages,
// payback_verified_at once with Treasury), not the original trip date.
treasuryReportsRouter.get("/ageing", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere({ ...(req.query as Filters) }, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, c.financial_outcome, c.status,
              COALESCE(c.payback_verified_at, c.sent_to_treasury_at, c.submitted_at) AS stage_entered_at,
              EXTRACT(DAY FROM now() - COALESCE(c.payback_verified_at, c.sent_to_treasury_at, c.submitted_at))::int AS age_days
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql} AND c.status != 'COMPLETED'`,
      params
    );
    const bands = [
      { label: "0-7 days", min: 0, max: 7 },
      { label: "8-14 days", min: 8, max: 14 },
      { label: "15-30 days", min: 15, max: 30 },
      { label: "31-60 days", min: 31, max: 60 },
      { label: "More than 60 days", min: 61, max: Infinity }
    ];
    const categories = [
      { key: "REFUND_DUE", label: "Refunds awaiting payment" },
      { key: "PAYBACK_DUE", label: "Payback proofs awaiting submission" },
      { key: "PAYBACK_PROOF_SUBMITTED", label: "Proofs awaiting HR Operations verification" },
      { key: "FINANCE_TREASURY_REVIEW", label: "Verified paybacks awaiting Treasury reconciliation" }
    ];
    const grid = categories.map((cat) => ({
      category: cat.label,
      bands: bands.map((b) => ({
        band: b.label,
        count: rows.filter((r) => r.status === cat.key && r.age_days >= b.min && r.age_days <= b.max).length
      }))
    }));
    return res.json({ bands: bands.map((b) => b.label), grid, items: rows });
  } catch (err) { return next(err); }
});

// 8.7 Audit and Reconciliation Report - flags common exceptions.
treasuryReportsRouter.get("/audit-reconciliation", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere({ ...(req.query as Filters) }, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, u.full_name AS employee_name, u.employee_no, ${ORG_TRIP_COLUMNS}
              c.advance_amount, c.claim_total AS verified_expenses, COALESCE(c.currency, 'LSL') AS currency,
              c.financial_outcome, c.status,
              c.balance_amount AS required_settlement_amount, c.settlement_amount AS actual_settlement_amount,
              c.settled_reference AS payment_reference, c.treasury_posting_reference AS posting_reference,
              verifier.full_name AS hr_verifier, off.full_name AS treasury_processor,
              c.submitted_at, c.payback_verified_at, c.treasury_completed_at,
              c.status AS final_status, c.treasury_return_reason
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN users verifier ON verifier.id = c.payback_verified_by_id
         LEFT JOIN users off ON off.id = c.treasury_officer_id
        WHERE ${whereSql}
        ORDER BY c.submitted_at DESC`,
      params
    );
    const items = (await withTripDetails(rows)).map((r) => {
      const required = Math.abs(Number(r.required_settlement_amount || 0));
      const actual = r.actual_settlement_amount != null ? Math.abs(Number(r.actual_settlement_amount)) : null;
      const exceptions: string[] = [];
      if (r.financial_outcome !== "BALANCED" && actual != null && Number(actual.toFixed(2)) !== Number(required.toFixed(2))) exceptions.push("Settlement amount differs from required amount");
      if (r.status === "COMPLETED" && r.financial_outcome !== "BALANCED" && !r.payment_reference) exceptions.push("Missing payment reference");
      if (r.status === "COMPLETED" && !r.posting_reference) exceptions.push("Missing journal reference");
      if (r.financial_outcome === "PAYBACK_DUE" && r.payback_verified_at && r.status !== "COMPLETED") exceptions.push("Verified payment not reconciled");
      if (r.financial_outcome === "REFUND_DUE" && r.status === "COMPLETED" && !r.payment_reference) exceptions.push("Refund marked paid without payment details");
      if (r.status === "COMPLETED" && Number(r.required_settlement_amount || 0) !== 0 && r.financial_outcome === "BALANCED") exceptions.push("Clearance completed with a non-zero outstanding amount");
      return { ...r, difference: actual != null ? Number((actual - required).toFixed(2)) : null, exceptions };
    });
    if (req.query.format === "csv") {
      return sendCsv(res, "audit-reconciliation.csv",
        ["Employee", "Outcome", "Required", "Actual", "Difference", "Payment Ref", "Posting Ref", "HR Verifier", "Treasury Processor", "Final Status", "Exceptions"],
        items.map((r) => [r.employee_name, r.financial_outcome, r.required_settlement_amount, r.actual_settlement_amount, r.difference, r.payment_reference, r.posting_reference, r.hr_verifier, r.treasury_processor, r.final_status, r.exceptions.join("; ")]));
    }
    return res.json({ items });
  } catch (err) { return next(err); }
});

// 8.8 Department and Division Report
treasuryReportsRouter.get("/department-division", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere({ ...(req.query as Filters) }, "c", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT ${ORG_COLUMNS}
              count(*)::int AS trips,
              sum(CASE WHEN coalesce(c.balance_amount, 0) = 0 THEN c.advance_amount ELSE c.claim_total END) AS total_to_be_expensed,
              sum(c.advance_amount) AS total_advances,
              sum(c.claim_total) AS total_verified_expenses,
              sum(CASE WHEN c.financial_outcome = 'REFUND_DUE' THEN -c.balance_amount ELSE 0 END) AS total_refunds,
              sum(CASE WHEN c.financial_outcome = 'PAYBACK_DUE' THEN c.balance_amount ELSE 0 END) AS total_paybacks,
              avg(EXTRACT(DAY FROM COALESCE(c.treasury_completed_at, now()) - c.submitted_at)) AS avg_clearance_days,
              count(*) FILTER (WHERE c.status != 'COMPLETED')::int AS outstanding,
              count(*) FILTER (WHERE c.status != 'COMPLETED' AND now() - c.submitted_at > interval '30 days')::int AS overdue,
              round(100.0 * count(*) FILTER (WHERE c.status = 'COMPLETED') / NULLIF(count(*), 0), 1) AS completion_rate
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3`,
      params
    );
    return respond(req, res, "department-division.csv",
      ["Company", "Division", "Department", "Trips", "Total Advances", "Total Verified Expenses", "Total Refunds", "Total Paybacks", "Avg Clearance Days", "Outstanding", "Overdue", "Completion Rate %"],
      (r) => [r.company, r.division_name, r.department, r.trips, r.total_advances, r.total_verified_expenses, r.total_refunds, r.total_paybacks, r.avg_clearance_days, r.outstanding, r.overdue, r.completion_rate],
      rows);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Overtime and Standby hours reports. Neither module has a Finance/money
// stage anymore (see workflowEngine/overtime.routes.ts/standby.routes.ts —
// both claim types close straight off their last approval with an hours
// figure), so Treasury's visibility into them is hours-only, same authority
// (treasury_processing) as the 8 clearance-claim reports above, but its own
// filter set since neither table has financial_outcome/claimant_id/etc.
// ---------------------------------------------------------------------------

type HoursFilters = { date_from?: string; date_to?: string; company?: string; division?: string; department?: string; status?: string };

function buildHoursWhere(f: HoursFilters, alias: string, dateColumn: string, allowedDivisions?: string[] | null) {
  const where: string[] = [`${alias}.status <> 'DRAFT'`];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.date_from) where.push(`${alias}.${dateColumn} >= ${p(f.date_from)}`);
  if (f.date_to) where.push(`${alias}.${dateColumn} <= ${p(f.date_to)}`);
  if (f.company) where.push(`dv.name = ${p(f.company)}`);
  if (f.division) where.push(`lower(trim(u.department)) = lower(trim(${p(f.division)}))`);
  if (f.department) where.push(`EXISTS (SELECT 1 FROM sections s WHERE lower(s.name) = lower(${p(f.department)}) AND s.id = coalesce(u.section_id, (SELECT t.section_id FROM teams t WHERE t.id = u.team_id)))`);
  if (f.status) where.push(`${alias}.status = ${p(f.status)}`);
  if (allowedDivisions) where.push(`dv.name = ANY(${p(allowedDivisions)}::text[])`);
  return { whereSql: where.join(" AND "), params };
}

// Overtime Hours Report — every non-draft Overtime claim.
treasuryReportsRouter.get("/overtime-hours", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildHoursWhere(req.query as HoursFilters, "c", "submitted_at", await getReportDivisionScope(req));
    const rows = await query<any>(
      `SELECT c.id, c.claim_no, u.full_name AS employee_name, u.employee_no, ${ORG_COLUMNS}
              c.year, c.month, c.total_overtime, c.converted_hours, c.equivalent_days, c.status, c.submitted_at, c.closed_at
         FROM overtime_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}
        ORDER BY c.submitted_at DESC`,
      params
    );
    const totals = {
      total_claims: rows.length,
      total_converted_hours: rows.reduce((s, r) => s + Number(r.converted_hours || 0), 0),
      closed_count: rows.filter((r) => r.status === "CLOSED").length,
      in_progress_count: rows.filter((r) => r.status !== "CLOSED" && r.status !== "REJECTED" && r.status !== "WITHDRAWN").length
    };
    if (req.query.format === "csv") {
      return sendCsv(res, "overtime-hours.csv",
        ["Claim No", "Employee", "Employee No", "Division", "Department", "Converted Hours", "Equivalent Days", "Status", "Submitted", "Closed"],
        rows.map((r) => [r.claim_no, r.employee_name, r.employee_no, r.division_name, r.department, r.converted_hours, r.equivalent_days, r.status, r.submitted_at, r.closed_at]));
    }
    return res.json({ items: rows, totals });
  } catch (err) { return next(err); }
});

// Standby Hours Report — every non-draft Standby claim AND every non-draft
// Call-Out, combined into one report (tagged by `type`) since both are
// Standby-module hours with no Finance stage.
treasuryReportsRouter.get("/standby-hours", async (req: AuthedRequest, res, next) => {
  try {
    const divisionScope = await getReportDivisionScope(req);
    const claimFilters = buildHoursWhere(req.query as HoursFilters, "c", "submitted_at", divisionScope);
    const claimRows = await query<any>(
      `SELECT 'STANDBY_CLAIM' AS type, c.id, c.claim_no, u.full_name AS employee_name, u.employee_no, ${ORG_COLUMNS}
              c.total_standby_hours, c.compensable_hours AS hours, c.status, c.submitted_at, c.closed_at
         FROM standby_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${claimFilters.whereSql}`,
      claimFilters.params
    );
    const calloutFilters = buildHoursWhere(req.query as HoursFilters, "c", "submitted_at", divisionScope);
    const calloutRows = await query<any>(
      `SELECT 'CALL_OUT' AS type, c.id, c.claim_no, u.full_name AS employee_name, u.employee_no, ${ORG_COLUMNS}
              c.hours AS total_standby_hours, c.converted_hours AS hours, c.status, c.submitted_at, c.closed_at
         FROM standby_callout_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${calloutFilters.whereSql}`,
      calloutFilters.params
    );
    const rows = [...claimRows, ...calloutRows].sort((a, b) => new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime());
    const totals = {
      total_items: rows.length,
      total_hours: rows.reduce((s, r) => s + Number(r.hours || 0), 0),
      claim_count: claimRows.length,
      callout_count: calloutRows.length,
      closed_count: rows.filter((r) => r.status === "CLOSED").length
    };
    if (req.query.format === "csv") {
      return sendCsv(res, "standby-hours.csv",
        ["Type", "Claim No", "Employee", "Employee No", "Division", "Department", "Hours", "Status", "Submitted", "Closed"],
        rows.map((r) => [r.type, r.claim_no, r.employee_name, r.employee_no, r.division_name, r.department, r.hours, r.status, r.submitted_at, r.closed_at]));
    }
    return res.json({ items: rows, totals });
  } catch (err) { return next(err); }
});
