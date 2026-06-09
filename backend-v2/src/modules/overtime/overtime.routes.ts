import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getUserAccountState, isProfileComplete } from "../../lib/userProfile.js";
import { getUserOrgPath } from "../../lib/departments.js";
import { notifyOvertimeSubmitted } from "../../lib/notifications.js";

const OvertimeRequestLineSchema = z.object({
  date: z.string(),
  day: z.string().optional(),
  estimated_start: z.string().optional(),
  estimated_end: z.string().optional(),
  actual_start: z.string().optional(),
  actual_end: z.string().optional(),
  reason: z.string().optional(),
  noc: z.string().optional(),
  car_reg: z.string().optional()
});

const OvertimeRequestSchema = z.object({
  employee_id: z.string().uuid().optional(),
  employee_name: z.string().optional(),
  employee_no: z.string().optional(),
  job_title: z.string().optional(),
  section_name: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  remarks: z.string().optional(),
  recommended_by_supervisor: z.string().optional(),
  supervisor_date: z.string().optional(),
  approved_by_hod: z.string().optional(),
  approved_by_cto: z.string().optional(),
  lines: z.array(OvertimeRequestLineSchema),
  status: z.enum(["DRAFT", "SUBMITTED"]).default("DRAFT")
});

const OvertimeClaimLineSchema = z.object({
  date: z.string().optional(),
  day: z.string().optional(),
  from_time: z.string().optional(),
  to_time: z.string().optional(),
  ordered_by: z.string().optional(),
  hours_125: z.coerce.number().nonnegative().default(0),
  hours_150: z.coerce.number().nonnegative().default(0),
  hours_200: z.coerce.number().nonnegative().default(0),
  converted_hours: z.coerce.number().nonnegative().default(0),
  account_or_project: z.string().optional(),
  activity_name: z.string().optional()
});

const OvertimeClaimSchema = z.object({
  overtime_request_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional(),
  employee_name: z.string().optional(),
  employee_no: z.string().optional(),
  job_title: z.string().optional(),
  division: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  lines: z.array(OvertimeClaimLineSchema),
  total_overtime: z.coerce.number().nonnegative().default(0),
  compensated_hours: z.coerce.number().nonnegative().default(0),
  pay_days: z.coerce.number().nonnegative().default(0),
  authorised_by: z.string().optional(),
  checked_by_supervisor: z.string().optional(),
  approved_by_manager: z.string().optional(),
  approved_by_cto: z.string().optional(),
  notation_hr: z.string().optional(),
  hourly_rate: z.coerce.number().nonnegative().default(0),
  total_amount: z.coerce.number().nonnegative().default(0),
  status: z.enum(["DRAFT", "SUBMITTED"]).default("DRAFT")
});

async function resolveEmployee(actorId: string, requestedEmployeeId?: string) {
  const actor = await getUserAccountState(actorId);
  if (!isProfileComplete(actor)) throw badRequest("Complete your profile first");
  const employeeId = requestedEmployeeId || actorId;
  const employee = await getUserAccountState(employeeId);
  if (employee.id !== actor.id && String(employee.department || "").trim() !== String(actor.department || "").trim()) {
    throw forbidden("Overtime records can only be created within your department");
  }
  return employee;
}

export const overtimeRouter = Router();
overtimeRouter.use(requireAuth);

overtimeRouter.get("/requests", async (req: AuthedRequest, res, next) => {
  try {
    const rows =
      req.user!.role === "ADMIN"
        ? await query(`SELECT * FROM overtime_requests ORDER BY created_at DESC`)
        : await query(
            `SELECT * FROM overtime_requests
             WHERE employee_id=$1 OR created_by_id=$1
             ORDER BY created_at DESC`,
            [req.user!.userId]
          );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/requests/:id", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.employee_id !== req.user!.userId && row.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") throw forbidden();
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/requests", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = OvertimeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid overtime request payload", parsed.error.flatten());
    const employee = await resolveEmployee(req.user!.userId, parsed.data.employee_id);
    // Auto-fill section_name from org profile if not supplied
    let sectionNameReq = parsed.data.section_name ?? null;
    if (!sectionNameReq) {
      const orgPath = await getUserOrgPath(employee.id);
      sectionNameReq = orgPath?.section_name ?? employee.department ?? null;
    }
    const rows = await query<{ id: string }>(
      `INSERT INTO overtime_requests
       (id, employee_id, created_by_id, employee_name, employee_no, job_title, section_name, year, month,
        remarks, recommended_by_supervisor, supervisor_date, approved_by_hod, approved_by_cto, lines, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        randomUUID(),
        employee.id,
        req.user!.userId,
        parsed.data.employee_name || employee.full_name || null,
        parsed.data.employee_no || employee.employee_no || null,
        parsed.data.job_title ?? null,
        sectionNameReq,
        parsed.data.year,
        parsed.data.month,
        parsed.data.remarks ?? null,
        parsed.data.recommended_by_supervisor ?? null,
        parsed.data.supervisor_date ?? null,
        parsed.data.approved_by_hod ?? null,
        parsed.data.approved_by_cto ?? null,
        JSON.stringify(parsed.data.lines),
        parsed.data.status
      ]
    );
    if (parsed.data.status === "SUBMITTED") {
      const empEmail = (await query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [employee.id]))[0]?.email ?? null;
      void notifyOvertimeSubmitted({
        requestId: rows[0].id,
        employeeName: parsed.data.employee_name || employee.full_name || null,
        employeeEmail: empEmail,
        department: employee.department,
        month: parsed.data.month,
        year: parsed.data.year,
        type: "request"
      });
    }
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.put("/requests/:id", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = OvertimeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid overtime request payload", parsed.error.flatten());
    const existing = (await query<{ created_by_id: string }>(`SELECT created_by_id FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound();
    if (existing.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") throw forbidden();
    const employee = await resolveEmployee(req.user!.userId, parsed.data.employee_id);
    await query(
      `UPDATE overtime_requests
       SET employee_id=$2,
           employee_name=$3,
           employee_no=$4,
           job_title=$5,
           section_name=$6,
           year=$7,
           month=$8,
           remarks=$9,
           recommended_by_supervisor=$10,
           supervisor_date=$11,
           approved_by_hod=$12,
           approved_by_cto=$13,
           lines=$14,
           status=$15,
           updated_at=now()
       WHERE id=$1`,
      [
        req.params.id,
        employee.id,
        parsed.data.employee_name || employee.full_name || null,
        parsed.data.employee_no || employee.employee_no || null,
        parsed.data.job_title ?? null,
        parsed.data.section_name ?? employee.department ?? null,
        parsed.data.year,
        parsed.data.month,
        parsed.data.remarks ?? null,
        parsed.data.recommended_by_supervisor ?? null,
        parsed.data.supervisor_date ?? null,
        parsed.data.approved_by_hod ?? null,
        parsed.data.approved_by_cto ?? null,
        JSON.stringify(parsed.data.lines),
        parsed.data.status
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/claims", async (req: AuthedRequest, res, next) => {
  try {
    const rows =
      req.user!.role === "ADMIN"
        ? await query(`SELECT * FROM overtime_claims ORDER BY created_at DESC`)
        : await query(
            `SELECT * FROM overtime_claims
             WHERE employee_id=$1 OR created_by_id=$1
             ORDER BY created_at DESC`,
            [req.user!.userId]
          );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.get("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.employee_id !== req.user!.userId && row.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") throw forbidden();
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.post("/claims", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = OvertimeClaimSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid overtime claim payload", parsed.error.flatten());
    const employee = await resolveEmployee(req.user!.userId, parsed.data.employee_id);
    // Auto-fill division from org profile if not supplied
    let divisionClaim = parsed.data.division ?? null;
    if (!divisionClaim) {
      const orgPath = await getUserOrgPath(employee.id);
      divisionClaim = orgPath?.division_name ?? employee.department ?? null;
    }
    const rows = await query<{ id: string }>(
      `INSERT INTO overtime_claims
       (id, employee_id, created_by_id, overtime_request_id, employee_name, employee_no, job_title, division, year, month, lines,
        total_overtime, compensated_hours, pay_days, authorised_by, checked_by_supervisor, approved_by_manager, approved_by_cto,
        notation_hr, hourly_rate, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [
        randomUUID(),
        employee.id,
        req.user!.userId,
        parsed.data.overtime_request_id ?? null,
        parsed.data.employee_name || employee.full_name || null,
        parsed.data.employee_no || employee.employee_no || null,
        parsed.data.job_title ?? null,
        divisionClaim,
        parsed.data.year,
        parsed.data.month,
        JSON.stringify(parsed.data.lines),
        parsed.data.total_overtime,
        parsed.data.compensated_hours,
        parsed.data.pay_days,
        parsed.data.authorised_by ?? null,
        parsed.data.checked_by_supervisor ?? null,
        parsed.data.approved_by_manager ?? null,
        parsed.data.approved_by_cto ?? null,
        parsed.data.notation_hr ?? null,
        parsed.data.hourly_rate,
        parsed.data.total_amount,
        parsed.data.status
      ]
    );
    if (parsed.data.status === "SUBMITTED") {
      const empEmail = (await query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [employee.id]))[0]?.email ?? null;
      void notifyOvertimeSubmitted({
        requestId: rows[0].id,
        employeeName: parsed.data.employee_name || employee.full_name || null,
        employeeEmail: empEmail,
        department: employee.department,
        month: parsed.data.month,
        year: parsed.data.year,
        type: "claim"
      });
    }
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

overtimeRouter.put("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = OvertimeClaimSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid overtime claim payload", parsed.error.flatten());
    const existing = (await query<{ created_by_id: string }>(`SELECT created_by_id FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound();
    if (existing.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") throw forbidden();
    const employee = await resolveEmployee(req.user!.userId, parsed.data.employee_id);
    await query(
      `UPDATE overtime_claims
       SET employee_id=$2,
           overtime_request_id=$3,
           employee_name=$4,
           employee_no=$5,
           job_title=$6,
           division=$7,
           year=$8,
           month=$9,
           lines=$10,
           total_overtime=$11,
           compensated_hours=$12,
           pay_days=$13,
           authorised_by=$14,
           checked_by_supervisor=$15,
           approved_by_manager=$16,
           approved_by_cto=$17,
           notation_hr=$18,
           hourly_rate=$19,
           total_amount=$20,
           status=$21,
           updated_at=now()
       WHERE id=$1`,
      [
        req.params.id,
        employee.id,
        parsed.data.overtime_request_id ?? null,
        parsed.data.employee_name || employee.full_name || null,
        parsed.data.employee_no || employee.employee_no || null,
        parsed.data.job_title ?? null,
        parsed.data.division ?? employee.department ?? null,
        parsed.data.year,
        parsed.data.month,
        JSON.stringify(parsed.data.lines),
        parsed.data.total_overtime,
        parsed.data.compensated_hours,
        parsed.data.pay_days,
        parsed.data.authorised_by ?? null,
        parsed.data.checked_by_supervisor ?? null,
        parsed.data.approved_by_manager ?? null,
        parsed.data.approved_by_cto ?? null,
        parsed.data.notation_hr ?? null,
        parsed.data.hourly_rate,
        parsed.data.total_amount,
        parsed.data.status
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ─── Request workflow approval endpoints ──────────────────────────────────────

overtimeRouter.post("/requests/:id/approve-supervisor", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "SUBMITTED") throw badRequest("Request must be SUBMITTED to recommend at supervisor level");
    if (!["MANAGER", "ADMIN"].includes(req.user!.role)) throw forbidden("Only managers can recommend at supervisor level");
    await query(
      `UPDATE overtime_requests
       SET status='SUPERVISOR_APPROVED',
           supervisor_approved_by_id=$2,
           supervisor_approved_at=now(),
           recommended_by_supervisor=$3,
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.user!.userId, req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "SUPERVISOR_APPROVED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/requests/:id/approve-hod", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "SUPERVISOR_APPROVED") throw badRequest("Request must be SUPERVISOR_APPROVED first");
    if (!["MANAGER", "HOD", "ADMIN"].includes(req.user!.role)) throw forbidden("Only HOD/managers can approve at HOD level");
    await query(
      `UPDATE overtime_requests
       SET status='HOD_APPROVED',
           hod_approved_by_id=$2,
           hod_approved_at=now(),
           approved_by_hod=$3,
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.user!.userId, req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "HOD_APPROVED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/requests/:id/approve-cto", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "HOD_APPROVED") throw badRequest("Request must be HOD_APPROVED first");
    if (!["ADMIN", "CHIEF_OFFICER"].includes(req.user!.role)) throw forbidden("Only CTO/Chief Officer can give final approval");
    await query(
      `UPDATE overtime_requests
       SET status='APPROVED',
           cto_approved_by_id=$2,
           cto_approved_at=now(),
           approved_by_cto=$3,
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.user!.userId, req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "APPROVED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/requests/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (!["SUBMITTED", "SUPERVISOR_APPROVED", "HOD_APPROVED"].includes(row.status)) {
      throw badRequest("Request cannot be rejected at this stage");
    }
    if (!["MANAGER", "HOD", "ADMIN", "CHIEF_OFFICER"].includes(req.user!.role)) throw forbidden();
    const reason = String((req.body as any)?.reason || "").trim() || null;
    await query(
      `UPDATE overtime_requests
       SET status='REJECTED',
           rejected_by_id=$2,
           rejected_at=now(),
           rejection_reason=$3,
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.user!.userId, reason]
    );
    return res.json({ ok: true, status: "REJECTED" });
  } catch (err) { return next(err); }
});

// ─── Claim workflow approval endpoints ───────────────────────────────────────

overtimeRouter.post("/claims/:id/authorise", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "SUBMITTED") throw badRequest("Claim must be SUBMITTED to authorise");
    if (!["MANAGER", "ADMIN"].includes(req.user!.role)) throw forbidden("Only managers can authorise claims");
    await query(
      `UPDATE overtime_claims
       SET status='MANAGER_AUTHORISED',
           authorised_by=$2,
           manager_authorised_by_id=$3,
           manager_authorised_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, req.user!.fullName ?? null, req.user!.userId]
    );
    return res.json({ ok: true, status: "MANAGER_AUTHORISED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/claims/:id/hr-note", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "MANAGER_AUTHORISED") throw badRequest("Claim must be MANAGER_AUTHORISED first");
    if (!["HR_MANAGER", "ADMIN"].includes(req.user!.role)) throw forbidden("Only HR can note this claim");
    const body = req.body as any ?? {};
    await query(
      `UPDATE overtime_claims
       SET status='HR_NOTED',
           notation_hr=$2,
           hourly_rate=$3,
           salary_class=$4,
           number_of_hours=$5,
           total_amount=COALESCE($3::numeric,0) * COALESCE($5::numeric,0),
           hr_noted_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, body.notation_hr ?? null, Number(body.hourly_rate) || 0, body.salary_class ?? null, Number(body.number_of_hours) || 0]
    );
    return res.json({ ok: true, status: "HR_NOTED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/claims/:id/finance-verify", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "HR_NOTED") throw badRequest("Claim must be HR_NOTED first");
    if (!["FINANCE", "ADMIN"].includes(req.user!.role)) throw forbidden("Only Finance can verify");
    const body = req.body as any ?? {};
    await query(
      `UPDATE overtime_claims
       SET status='FINANCE_VERIFIED',
           calculated_by=$2,
           finance_verified_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, body.calculated_by ?? req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "FINANCE_VERIFIED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/claims/:id/record-earnings", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "FINANCE_VERIFIED") throw badRequest("Claim must be FINANCE_VERIFIED first");
    if (!["HR_MANAGER", "ADMIN"].includes(req.user!.role)) throw forbidden("Only HR can record earnings");
    const body = req.body as any ?? {};
    await query(
      `UPDATE overtime_claims
       SET status='EARNINGS_RECORDED',
           checked_noted_earning_by=$2,
           earnings_recorded_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, body.checked_noted_earning_by ?? req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "EARNINGS_RECORDED" });
  } catch (err) { return next(err); }
});

overtimeRouter.post("/claims/:id/transfer-summary", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
    if (!row) throw notFound();
    if (row.status !== "EARNINGS_RECORDED") throw badRequest("Claim must be EARNINGS_RECORDED first");
    if (!["HR_MANAGER", "ADMIN"].includes(req.user!.role)) throw forbidden("Only HR can transfer to summary");
    const body = req.body as any ?? {};
    await query(
      `UPDATE overtime_claims
       SET status='SUMMARY_TRANSFERRED',
           transferred_to_summary_by=$2,
           summary_transferred_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, body.transferred_to_summary_by ?? req.user!.fullName ?? null]
    );
    return res.json({ ok: true, status: "SUMMARY_TRANSFERRED" });
  } catch (err) { return next(err); }
});
