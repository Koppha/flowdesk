import { Router } from "express";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { sendCsv } from "../../lib/csvExport.js";
import { renderTabularReportPdf } from "../../lib/pdf/tabularReportPdf.js";
import { isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { getStringSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";

// Finance-facing Standby report — same shape/gate/export mechanism as
// overtime-reports.routes.ts (server-side filtered, CSV/PDF exported from
// the exact same query result backing the on-screen table). One report
// (not a per-tab set like Overtime's allowance/paid-history) since every
// non-draft claim, at any stage, belongs on it — the "status" filter
// narrows within it rather than switching endpoints.
export const standbyReportsRouter = Router();
standbyReportsRouter.use(requireAuth);
standbyReportsRouter.use(async (req: AuthedRequest, res, next) => {
  if (req.user!.role === "ADMIN" || (await isCompensationFinanceUser(req))) return next();
  return next(forbidden());
});

type Filters = { month?: string; division?: string; department?: string; section?: string; employee?: string; status?: string };

function buildWhere(f: Filters) {
  const where: string[] = [`sc.status <> 'DRAFT'`];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // claim_month is stored as the 1st of the month it covers.
  if (f.month) where.push(`to_char(sc.claim_month, 'YYYY-MM') = ${p(f.month)}`);
  if (f.division) where.push(`u.department = ${p(f.division)}`);
  if (f.department) where.push(`sec.name = ${p(f.department)}`);
  if (f.section) where.push(`tm.name = ${p(f.section)}`);
  if (f.employee) where.push(`(u.full_name ILIKE ${p(`%${f.employee}%`)} OR u.employee_no ILIKE ${p(`%${f.employee}%`)})`);
  if (f.status === "PENDING") where.push(`sc.status <> 'CLOSED'`);
  else if (f.status === "PROCESSED") where.push(`sc.status = 'CLOSED'`);
  return { whereSql: where.join(" AND "), params };
}

standbyReportsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere(req.query as Filters);
    const defaultRate = Number((await getStringSystemSetting(SYSTEM_SETTING_KEYS.standbyDefaultHourlyRate, "0")) || 0);
    const rows = await query<any>(
      `SELECT sc.id, sc.claim_no, u.full_name AS employee_name, u.employee_no,
              u.department AS division_name, sec.name AS department_name, tm.name AS section_name,
              to_char(sc.claim_month, 'YYYY-MM') AS period,
              lines.date_from, lines.date_to, lines.total_days,
              sc.compensable_hours, sc.hourly_rate, sc.calculated_amount, sc.status,
              sc.submitted_at, sc.closed_at
         FROM standby_claims sc
         JOIN users u ON u.id = sc.employee_id
         LEFT JOIN sections sec ON sec.id = u.section_id
         LEFT JOIN teams tm ON tm.id = u.team_id
         LEFT JOIN LATERAL (
           SELECT min(standby_date) AS date_from, max(standby_date) AS date_to,
                  count(DISTINCT standby_date)::int AS total_days
             FROM standby_claim_lines scl WHERE scl.claim_id = sc.id
         ) lines ON true
        WHERE ${whereSql}
        ORDER BY sc.submitted_at DESC`,
      params
    );

    // A claim only gets a real hourly_rate/calculated_amount once Finance
    // has processed it (see standby.routes.ts POST /claims/:id/finance) —
    // before that, this report estimates from the company default rate so
    // records still awaiting Finance aren't blank on a report meant to help
    // plan for processing them.
    const items = rows.map((r) => {
      const rate = r.hourly_rate != null ? Number(r.hourly_rate) : defaultRate;
      const amount = r.calculated_amount != null ? Number(r.calculated_amount) : Number(r.compensable_hours || 0) * rate;
      return { ...r, rate, amount, is_estimated: r.calculated_amount == null };
    });

    const format = String(req.query.format || "").toLowerCase();
    const columns = [
      { key: "claim_no", label: "Claim No." },
      { key: "employee_name", label: "Employee" },
      { key: "employee_no", label: "Employee No." },
      { key: "division_name", label: "Division" },
      { key: "department_name", label: "Department" },
      { key: "date_from", label: "From" },
      { key: "date_to", label: "To" },
      { key: "total_days", label: "Total Days" },
      { key: "compensable_hours", label: "Compensable Hours" },
      { key: "rate", label: "Rate (M/hr)" },
      { key: "amount", label: "Amount (M)" },
      { key: "status", label: "Status" }
    ];
    if (format === "csv") {
      return sendCsv(res, "standby-report.csv", columns.map((c) => c.label), items.map((r) => columns.map((c) => r[c.key] ?? null)));
    }
    if (format === "pdf") {
      return renderTabularReportPdf(res, {
        title: "Standby Reports",
        subtitle: "Standby compensation records, any status.",
        filename: "standby-report.pdf",
        columns,
        rows: items.map((r) => columns.map((c) => r[c.key] ?? null))
      });
    }
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});
