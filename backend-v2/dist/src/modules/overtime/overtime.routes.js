import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getUserAccountState, isProfileComplete } from "../../lib/userProfile.js";
const OvertimeRequestLineSchema = z.object({
    date: z.string(),
    day: z.string().optional(),
    estimated_hours: z.string().optional(),
    actual_hours: z.string().optional(),
    reason: z.string().optional(),
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
    car_reg: z.string().optional(),
    remarks: z.string().optional(),
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
async function resolveEmployee(actorId, requestedEmployeeId) {
    const actor = await getUserAccountState(actorId);
    if (!isProfileComplete(actor))
        throw badRequest("Complete your profile first");
    const employeeId = requestedEmployeeId || actorId;
    const employee = await getUserAccountState(employeeId);
    if (employee.id !== actor.id && String(employee.department || "").trim() !== String(actor.department || "").trim()) {
        throw forbidden("Overtime records can only be created within your department");
    }
    return employee;
}
export const overtimeRouter = Router();
overtimeRouter.use(requireAuth);
overtimeRouter.get("/requests", async (req, res, next) => {
    try {
        const rows = req.user.role === "ADMIN"
            ? await query(`SELECT * FROM overtime_requests ORDER BY created_at DESC`)
            : await query(`SELECT * FROM overtime_requests
             WHERE employee_id=$1 OR created_by_id=$1
             ORDER BY created_at DESC`, [req.user.userId]);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.get("/requests/:id", async (req, res, next) => {
    try {
        const row = (await query(`SELECT * FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
        if (!row)
            throw notFound();
        if (row.employee_id !== req.user.userId && row.created_by_id !== req.user.userId && req.user.role !== "ADMIN")
            throw forbidden();
        return res.json(row);
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.post("/requests", async (req, res, next) => {
    try {
        const parsed = OvertimeRequestSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid overtime request payload", parsed.error.flatten());
        const employee = await resolveEmployee(req.user.userId, parsed.data.employee_id);
        const rows = await query(`INSERT INTO overtime_requests
       (id, employee_id, created_by_id, employee_name, employee_no, job_title, section_name, year, month, car_reg, remarks, lines, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`, [
            randomUUID(),
            employee.id,
            req.user.userId,
            parsed.data.employee_name || employee.full_name || null,
            parsed.data.employee_no || employee.employee_no || null,
            parsed.data.job_title ?? null,
            parsed.data.section_name ?? employee.department ?? null,
            parsed.data.year,
            parsed.data.month,
            parsed.data.car_reg ?? null,
            parsed.data.remarks ?? null,
            JSON.stringify(parsed.data.lines),
            parsed.data.status
        ]);
        return res.status(201).json({ id: rows[0].id });
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.put("/requests/:id", async (req, res, next) => {
    try {
        const parsed = OvertimeRequestSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid overtime request payload", parsed.error.flatten());
        const existing = (await query(`SELECT created_by_id FROM overtime_requests WHERE id=$1`, [req.params.id]))[0];
        if (!existing)
            throw notFound();
        if (existing.created_by_id !== req.user.userId && req.user.role !== "ADMIN")
            throw forbidden();
        const employee = await resolveEmployee(req.user.userId, parsed.data.employee_id);
        await query(`UPDATE overtime_requests
       SET employee_id=$2,
           employee_name=$3,
           employee_no=$4,
           job_title=$5,
           section_name=$6,
           year=$7,
           month=$8,
           car_reg=$9,
           remarks=$10,
           lines=$11,
           status=$12,
           updated_at=now()
       WHERE id=$1`, [
            req.params.id,
            employee.id,
            parsed.data.employee_name || employee.full_name || null,
            parsed.data.employee_no || employee.employee_no || null,
            parsed.data.job_title ?? null,
            parsed.data.section_name ?? employee.department ?? null,
            parsed.data.year,
            parsed.data.month,
            parsed.data.car_reg ?? null,
            parsed.data.remarks ?? null,
            JSON.stringify(parsed.data.lines),
            parsed.data.status
        ]);
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.get("/claims", async (req, res, next) => {
    try {
        const rows = req.user.role === "ADMIN"
            ? await query(`SELECT * FROM overtime_claims ORDER BY created_at DESC`)
            : await query(`SELECT * FROM overtime_claims
             WHERE employee_id=$1 OR created_by_id=$1
             ORDER BY created_at DESC`, [req.user.userId]);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.get("/claims/:id", async (req, res, next) => {
    try {
        const row = (await query(`SELECT * FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
        if (!row)
            throw notFound();
        if (row.employee_id !== req.user.userId && row.created_by_id !== req.user.userId && req.user.role !== "ADMIN")
            throw forbidden();
        return res.json(row);
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.post("/claims", async (req, res, next) => {
    try {
        const parsed = OvertimeClaimSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid overtime claim payload", parsed.error.flatten());
        const employee = await resolveEmployee(req.user.userId, parsed.data.employee_id);
        const rows = await query(`INSERT INTO overtime_claims
       (id, employee_id, created_by_id, overtime_request_id, employee_name, employee_no, job_title, division, year, month, lines,
        total_overtime, compensated_hours, pay_days, authorised_by, checked_by_supervisor, approved_by_manager, approved_by_cto,
        notation_hr, hourly_rate, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`, [
            randomUUID(),
            employee.id,
            req.user.userId,
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
        ]);
        return res.status(201).json({ id: rows[0].id });
    }
    catch (err) {
        return next(err);
    }
});
overtimeRouter.put("/claims/:id", async (req, res, next) => {
    try {
        const parsed = OvertimeClaimSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid overtime claim payload", parsed.error.flatten());
        const existing = (await query(`SELECT created_by_id FROM overtime_claims WHERE id=$1`, [req.params.id]))[0];
        if (!existing)
            throw notFound();
        if (existing.created_by_id !== req.user.userId && req.user.role !== "ADMIN")
            throw forbidden();
        const employee = await resolveEmployee(req.user.userId, parsed.data.employee_id);
        await query(`UPDATE overtime_claims
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
       WHERE id=$1`, [
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
        ]);
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
