import { Router } from "express";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { sendCsv } from "../../lib/csvExport.js";
import { renderTabularReportPdf } from "../../lib/pdf/tabularReportPdf.js";
import { isCompensationFinanceUser } from "../../lib/financeAuthority.js";

// Finance-facing Overtime reports — supersedes the old fixed, unfilterable
// /overtime/reports/summary dump: server-side filtering (so large datasets
// are never shipped whole to the browser) and CSV/PDF export from the exact
// same query result that backs the on-screen table, same pattern as
// treasury-reports.routes.ts. Gated by the same Finance authority as the
// rest of the Overtime module (isCompensationFinanceUser), not the separate
// feature-access group Treasury uses, since Overtime's Finance stage already
// runs on that authority.
export const overtimeReportsRouter = Router();
overtimeReportsRouter.use(requireAuth);
overtimeReportsRouter.use(async (req: AuthedRequest, res, next) => {
  if (req.user!.role === "ADMIN" || (await isCompensationFinanceUser(req))) return next();
  return next(forbidden());
});

type Filters = { year?: string; month?: string; status?: string; compensation_preference?: string; division?: string; department?: string };

function buildWhere(f: Filters, alias = "c") {
  const where: string[] = [`${alias}.status <> 'DRAFT'`];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.year) where.push(`${alias}.year = ${p(Number(f.year))}`);
  if (f.month) where.push(`${alias}.month = ${p(Number(f.month))}`);
  if (f.status) where.push(`${alias}.status = ${p(f.status)}`);
  if (f.compensation_preference) where.push(`${alias}.compensation_preference = ${p(f.compensation_preference)}`);
  if (f.division) where.push(`dv.name = ${p(f.division)}`);
  if (f.department) where.push(`u.department = ${p(f.department)}`);
  return { whereSql: where.join(" AND "), params };
}

const RATE_BUCKET_SELECT = `
  COALESCE((SELECT SUM((l->>'hours_125')::numeric) FROM jsonb_array_elements(c.lines) l), 0)::numeric(10,2) AS hours_125,
  COALESCE((SELECT SUM((l->>'hours_150')::numeric) FROM jsonb_array_elements(c.lines) l), 0)::numeric(10,2) AS hours_150,
  COALESCE((SELECT SUM((l->>'hours_200')::numeric) FROM jsonb_array_elements(c.lines) l), 0)::numeric(10,2) AS hours_200
`;

function respondReport(
  req: AuthedRequest,
  res: any,
  rows: any[],
  cfg: {
    filenamePrefix: string;
    pdfTitle: string;
    pdfSubtitle: string;
    columns: { key: string; label: string; pdfWidth?: number }[];
  }
) {
  const format = String(req.query.format || "").toLowerCase();
  if (format === "csv") {
    return sendCsv(res, `${cfg.filenamePrefix}.csv`, cfg.columns.map((c) => c.label), rows.map((r) => cfg.columns.map((c) => r[c.key] ?? null)));
  }
  if (format === "pdf") {
    return renderTabularReportPdf(res, {
      title: cfg.pdfTitle,
      subtitle: cfg.pdfSubtitle,
      filename: `${cfg.filenamePrefix}.pdf`,
      columns: cfg.columns.map((c) => ({ label: c.label, width: c.pdfWidth })),
      rows: rows.map((r) => cfg.columns.map((c) => r[c.key] ?? null))
    });
  }
  return res.json({ items: rows });
}

// Every claim, any (non-draft) status — the direct replacement for the old
// fixed /overtime/reports/summary allowance dump, now filterable by
// year/month/division/department/status/compensation.
overtimeReportsRouter.get("/allowance", async (req: AuthedRequest, res, next) => {
  try {
    const { whereSql, params } = buildWhere(req.query as Filters);
    const rows = await query<any>(
      `SELECT c.id, c.claim_no, u.full_name AS employee_name, u.employee_no, u.title AS job_title, dv.name AS division_name, u.department,
              ${RATE_BUCKET_SELECT},
              c.converted_hours, c.equivalent_days, c.status, c.year, c.month
         FROM overtime_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}
        ORDER BY c.submitted_at DESC`,
      params
    );
    return respondReport(req, res, rows, {
      filenamePrefix: "overtime-hours-report",
      pdfTitle: "Overtime Hours Report",
      pdfSubtitle: "Every claim, any status.",
      columns: [
        { key: "claim_no", label: "Claim No." },
        { key: "employee_name", label: "Employee" },
        { key: "employee_no", label: "E/N" },
        { key: "job_title", label: "Job Title" },
        { key: "hours_125", label: "125%" },
        { key: "hours_150", label: "150%" },
        { key: "hours_200", label: "200%" },
        { key: "converted_hours", label: "Converted" },
        { key: "equivalent_days", label: "Equivalent Days" },
        { key: "status", label: "Status" }
      ]
    });
  } catch (err) {
    return next(err);
  }
});

// Everything CLOSED — completed-claims log for audit/reconciliation.
overtimeReportsRouter.get("/paid-history", async (req: AuthedRequest, res, next) => {
  try {
    const f = { ...(req.query as Filters), status: "CLOSED" };
    const { whereSql, params } = buildWhere(f);
    const rows = await query<any>(
      `SELECT c.id, c.claim_no, u.full_name AS employee_name, u.employee_no, dv.name AS division_name, u.department,
              c.converted_hours, c.equivalent_days, c.closed_at
         FROM overtime_claims c
         JOIN users u ON u.id = c.employee_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE ${whereSql}
        ORDER BY c.closed_at DESC`,
      params
    );
    return respondReport(req, res, rows, {
      filenamePrefix: "overtime-completed-claims",
      pdfTitle: "Overtime — Completed Claims",
      pdfSubtitle: "Every closed claim.",
      columns: [
        { key: "claim_no", label: "Claim No." },
        { key: "employee_name", label: "Employee" },
        { key: "employee_no", label: "E/N" },
        { key: "division_name", label: "Division" },
        { key: "converted_hours", label: "Converted" },
        { key: "equivalent_days", label: "Equivalent Days" },
        { key: "closed_at", label: "Closed At" }
      ]
    });
  } catch (err) {
    return next(err);
  }
});
