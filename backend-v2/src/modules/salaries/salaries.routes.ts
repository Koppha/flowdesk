import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessSalaries } from "../../lib/salariesPermissions.js";
import { getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";

export const salariesRouter = Router();
salariesRouter.use(requireAuth);

// A "Salary Register" isn't a new capture mechanism - it's simply an
// already-submitted Attendance Register custom request, grouped by
// division/department/period. Look the type id up by code rather than
// hardcoding it, since it's just a seeded row like any other.
async function getAttendanceRegisterTypeId(): Promise<string | null> {
  const row = (await query<{ id: string }>(`SELECT id FROM custom_request_types WHERE code = 'ATTENDANCE_REGISTER'`))[0];
  return row?.id ?? null;
}

// Real submissions don't reliably carry a "department" key - older ones
// (from before Section/Team were replaced by Department, see
// seedAttendanceRegisterType) used "section"/"team" instead. Fall back
// through all three so grouping/display works across old and new data.
const DEPARTMENT_EXPR = `COALESCE(NULLIF(s.data->>'department',''), NULLIF(s.data->>'section',''), NULLIF(s.data->>'team',''))`;

// Regular / Time-compensation / Official-trip days count as a standard 8h
// working day; every leave-type code (Sick/Annual/Emergency/Study/Other/
// Holiday) counts as 0 toward Converted Hours - this is a payroll-hours
// figure, not an attendance count, so leave days contribute nothing to it.
const HOUR_CODES = new Set(["R", "C", "O"]);
const HOURS_PER_DAY = 8;

function convertedHoursFor(cells: Record<string, string> | undefined): number {
  if (!cells) return 0;
  let days = 0;
  for (const v of Object.values(cells)) if (HOUR_CODES.has(v)) days++;
  return days * HOURS_PER_DAY;
}

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Salaries nav group at all - the real enforcement is the gate below,
// applied to every other route on this router.
salariesRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessSalaries(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const typeId = await getAttendanceRegisterTypeId();
    const pendingRegisters = typeId
      ? (await query<{ count: string }>(
          `SELECT count(DISTINCT s.id)::text AS count
             FROM custom_request_submissions s
             LEFT JOIN salary_payments sp ON sp.submission_id = s.id
            WHERE s.request_type_id = $1 AND s.status = 'APPROVED' AND sp.id IS NULL`,
          [typeId]
        ))[0]
      : { count: "0" };
    // Salary advances are paid from Payments now (see POST /advances/:id/pay).
    return res.json({ allowed, pendingCount: Number(pendingRegisters.count) });
  } catch (err) {
    return next(err);
  }
});

// Every route below requires module access (ADMIN or an assigned group).
salariesRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessSalaries(req.user!.userId, req.user!.role);
    if (!allowed) throw forbidden("You do not have access to Salaries");
    next();
  } catch (err) {
    next(err);
  }
});

type RegisterRow = {
  division: string | null;
  department: string | null;
  period: string;
  employee_count: number;
  submitted_count: number;
  paid_count: number;
};

// Groups Attendance Register submissions into registers - one per
// division/department/calendar-month - and derives each register's status:
// IN_PROGRESS while any expected employee hasn't submitted+been approved
// yet, READY_FOR_PAYMENT once every submitted employee is APPROVED and
// none are paid yet, PAID once every submitted employee has been paid.
// "Expected employees" is approximated as the distinct employees who have
// ever submitted for that division/department, not a live headcount query -
// there's no reliable division/department membership list to join against
// (Attendance Register submissions self-report free-text division/
// department strings rather than referencing divisions/departments rows).
salariesRouter.get("/registers", async (req: AuthedRequest, res, next) => {
  try {
    const typeId = await getAttendanceRegisterTypeId();
    if (!typeId) return res.json({ items: [] });
    const rows = await query<RegisterRow>(
      `SELECT s.data->>'division' AS division,
              ${DEPARTMENT_EXPR} AS department,
              to_char(date_trunc('month', (s.data->>'month')::date), 'YYYY-MM') AS period,
              count(DISTINCT s.requester_id)::int AS employee_count,
              count(DISTINCT s.requester_id) FILTER (WHERE s.status = 'APPROVED')::int AS submitted_count,
              count(DISTINCT s.requester_id) FILTER (WHERE sp.id IS NOT NULL)::int AS paid_count
         FROM custom_request_submissions s
         LEFT JOIN salary_payments sp ON sp.submission_id = s.id
        WHERE s.request_type_id = $1 AND s.status IN ('APPROVED','IN_PROGRESS')
        GROUP BY 1, 2, 3
        ORDER BY 3 DESC, 1, 2`,
      [typeId]
    );
    const items = rows.map((r) => ({
      ...r,
      attendance_complete_pct: r.employee_count ? Math.round((r.submitted_count / r.employee_count) * 100) : 0,
      status: r.submitted_count > 0 && r.paid_count === r.submitted_count
        ? "PAID"
        : r.submitted_count === r.employee_count && r.employee_count > 0
        ? "READY_FOR_PAYMENT"
        : "IN_PROGRESS"
    }));
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

// The register's employee-level rows, for drilling into one division/
// department/period. Query params rather than path segments since
// division/department are free-text and may contain spaces/punctuation.
const RegisterDetailQuery = z.object({ division: z.string(), department: z.string(), period: z.string().regex(/^\d{4}-\d{2}$/) });
salariesRouter.get("/registers/detail", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RegisterDetailQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest("division, department and period (YYYY-MM) are required");
    const typeId = await getAttendanceRegisterTypeId();
    if (!typeId) return res.json({ items: [] });
    // An employee can end up with more than one submission for the same
    // month (a correction, or a resubmission after rejection) - showing
    // every one of them as a separate row made the same employee appear
    // several times with no way to tell which was current (see
    // convertedHoursFor's neighboring comment for the same "one row per
    // employee/period" expectation elsewhere in this file). DISTINCT ON
    // collapses to a single, canonical submission per employee: prefer
    // whichever one is actually paid, then the most recently
    // approved, then just the most recent attempt.
    const rows = await query<any>(
      `SELECT * FROM (
         SELECT DISTINCT ON (u.id)
                s.id AS submission_id, s.status, u.full_name AS employee_name, u.employee_no,
                s.data->'attendance_grid'->'summary'->'totals' AS totals,
                sp.id AS payment_id, sp.payment_reference, sp.payment_date, sp.paid_at,
                s.created_at AS submitted_at
           FROM custom_request_submissions s
           JOIN users u ON u.id = s.requester_id
           LEFT JOIN salary_payments sp ON sp.submission_id = s.id
          WHERE s.request_type_id = $1
            AND s.data->>'division' = $2
            AND ${DEPARTMENT_EXPR} = $3
            AND to_char(date_trunc('month', (s.data->>'month')::date), 'YYYY-MM') = $4
          ORDER BY u.id, (sp.id IS NOT NULL) DESC, (s.status = 'APPROVED') DESC, s.created_at DESC
       ) canonical
       ORDER BY employee_name`,
      [typeId, parsed.data.division, parsed.data.department, parsed.data.period]
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

// One employee's "Salary Record" - the full attendance grid plus Converted
// Hours, ready for the Payment Details form.
salariesRouter.get("/records/:submissionId", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(
      `SELECT s.id, s.status, s.data, s.requester_id, u.full_name AS employee_name, u.employee_no
         FROM custom_request_submissions s
         JOIN users u ON u.id = s.requester_id
        WHERE s.id = $1`,
      [req.params.submissionId]
    ))[0];
    if (!submission) throw notFound("Salary record not found");
    const payment = (await query<any>(`SELECT * FROM salary_payments WHERE submission_id = $1`, [req.params.submissionId]))[0] ?? null;
    const row = submission.data?.attendance_grid?.rows?.[0] ?? null;
    const convertedHours = convertedHoursFor(row?.cells);
    return res.json({
      submission_id: submission.id,
      status: submission.status,
      employee_id: submission.requester_id,
      employee_name: submission.employee_name,
      employee_no: submission.employee_no,
      division: submission.data?.division ?? null,
      department: submission.data?.department || submission.data?.section || submission.data?.team || null,
      period: submission.data?.month ?? null,
      cells: row?.cells ?? {},
      summary: row?.summary ?? submission.data?.attendance_grid?.summary?.totals ?? null,
      converted_hours: convertedHours,
      payment
    });
  } catch (err) {
    return next(err);
  }
});

const PaySchema = z.object({
  payment_reference: z.string().trim().min(1, "Payment reference is required"),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Payment date is required"),
  comment: z.string().trim().max(2000).optional()
});

salariesRouter.post("/records/:submissionId/pay", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1`, [req.params.submissionId]))[0];
    if (!submission) throw notFound("Salary record not found");
    if (submission.status !== "APPROVED") throw badRequest("Only an approved Attendance Register can be marked paid");
    const existing = (await query<{ id: string }>(`SELECT id FROM salary_payments WHERE submission_id = $1`, [req.params.submissionId]))[0];
    if (existing) throw badRequest("This salary record has already been paid");

    const parsed = PaySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payment payload", parsed.error.flatten());

    const row = submission.data?.attendance_grid?.rows?.[0] ?? null;
    const convertedHours = convertedHoursFor(row?.cells);
    const department = submission.data?.department || submission.data?.section || submission.data?.team || null;

    await query(
      `INSERT INTO salary_payments
         (submission_id, employee_id, division, department, period, converted_hours, payment_reference, payment_date, comment, paid_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        submission.id, submission.requester_id, submission.data?.division ?? null, department,
        submission.data?.month ?? null, convertedHours,
        parsed.data.payment_reference, parsed.data.payment_date, parsed.data.comment ?? null, req.user!.userId
      ]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Salary advances used to be paid here. Since Nov 2026 they go through
// Finance like travel advances - the workflow's Capture step (Capture Inbox),
// then Payments (GET /advances/payments includes them) - so there is one
// place to pay them. Past payments made here stay in History (salary_payments).
salariesRouter.post("/advances/:id/pay", async (req: AuthedRequest, res, next) => {
  try {
    throw badRequest("Salary advances are now captured and paid by Finance, like travel advances: Capture Inbox, then Payments.");
  } catch (err) {
    return next(err);
  }
});

// Ready for Payment / History: a single unified list mixing Salary Register
// rows (one per employee/period) and Salary Advance rows, since both end
// up being marked paid from the same place in Salaries.
salariesRouter.get("/ready-for-payment", async (req: AuthedRequest, res, next) => {
  try {
    const typeId = await getAttendanceRegisterTypeId();
    // Same "one row per employee/period" collapse as GET /registers/detail -
    // without it, an employee with more than one submission for the same
    // month (a correction, a resubmission after rejection) could show up
    // here more than once, and worse, an already-paid month could still
    // surface an approved-but-unpaid duplicate as if it were still owed.
    const registerRows = typeId
      ? await query<any>(
          `SELECT * FROM (
             SELECT DISTINCT ON (s.requester_id, date_trunc('month', (s.data->>'month')::date))
                    s.id AS submission_id, NULL::uuid AS advance_request_id, 'REGISTER' AS item_type,
                    u.full_name AS employee_name, u.employee_no,
                    s.data->>'division' AS division, ${DEPARTMENT_EXPR} AS department, s.data->>'month' AS period,
                    s.status, sp.id AS payment_id, s.data AS data
               FROM custom_request_submissions s
               JOIN users u ON u.id = s.requester_id
               LEFT JOIN salary_payments sp ON sp.submission_id = s.id
              WHERE s.request_type_id = $1
              ORDER BY s.requester_id, date_trunc('month', (s.data->>'month')::date),
                       (sp.id IS NOT NULL) DESC, (s.status = 'APPROVED') DESC, s.created_at DESC
           ) canonical
           WHERE status = 'APPROVED' AND payment_id IS NULL
           ORDER BY period DESC`,
          [typeId]
        )
      : [];
    // Salary Registers have no computed money amount (see convertedHoursFor
    // above) - Converted Hours is what "is being paid" for these, the same
    // figure the History list and the per-employee Salary Record already show.
    const registers = registerRows.map(({ data, ...rest }) => ({
      ...rest,
      converted_hours: convertedHoursFor(data?.attendance_grid?.rows?.[0]?.cells)
    }));
    return res.json({ items: registers });
  } catch (err) {
    return next(err);
  }
});

salariesRouter.get("/history", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT sp.id, sp.submission_id, sp.advance_request_id,
              CASE WHEN sp.submission_id IS NOT NULL THEN 'REGISTER' ELSE 'ADVANCE' END AS item_type,
              u.full_name AS employee_name, u.employee_no,
              sp.division, sp.department, sp.period, sp.converted_hours,
              sp.payment_reference, sp.payment_date, sp.comment, sp.paid_at, pb.full_name AS paid_by_name
         FROM salary_payments sp
         JOIN users u ON u.id = sp.employee_id
         LEFT JOIN users pb ON pb.id = sp.paid_by_id
        ORDER BY sp.paid_at DESC`
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

// Controls when a Salary Advance for the CURRENT calendar month opens for
// applications (e.g. 5 - "you can apply for September after the 5th of
// September") - enforced in advances.routes.ts / assertSalaryMonthWindowAllowed.
// Requesting a past or future month is never gated by this.
salariesRouter.get("/settings", async (_req: AuthedRequest, res, next) => {
  try {
    const openDay = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceApplicationOpenDay, 1);
    return res.json({ application_open_day: openDay });
  } catch (err) {
    return next(err);
  }
});

const SalarySettingsSchema = z.object({ application_open_day: z.coerce.number().int().min(1).max(28) });

salariesRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SalarySettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid settings payload", parsed.error.flatten());
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceApplicationOpenDay, parsed.data.application_open_day);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
