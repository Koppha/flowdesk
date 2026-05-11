import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canCreateAdvanceOnBehalf, getUserAccountState, isProfileComplete } from "../../lib/userProfile.js";

const DayCodeSchema = z.object({
  day: z.coerce.number().int().min(1).max(31),
  code: z.enum(["R", "C", "S", "A", "O", "H", "E", "T", "X", ""])
});

const AttendanceSchema = z.object({
  employee_id: z.string().uuid(),
  division: z.string().optional(),
  section_name: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  account_project_no: z.string().optional(),
  day_codes: z.array(DayCodeSchema).max(31),
  checked_by: z.string().optional(),
  checked_date: z.string().optional(),
  approved_by: z.string().optional(),
  approved_date: z.string().optional(),
  status: z.enum(["DRAFT", "SUBMITTED"]).default("DRAFT")
});

function summarizeDayCodes(dayCodes: Array<{ day: number; code: string }>) {
  return dayCodes.reduce(
    (acc, item) => {
      const code = item.code || "";
      if (code === "R") acc.regular_days += 1;
      if (code === "H") acc.holidays += 1;
      if (code === "A") acc.annual_leave += 1;
      if (code === "O") acc.official_trips += 1;
      if (code === "S") acc.sick_leave += 1;
      return acc;
    },
    { regular_days: 0, holidays: 0, annual_leave: 0, official_trips: 0, sick_leave: 0 }
  );
}

async function ensureAttendancePermissions(actorId: string, employeeId: string) {
  const actor = await getUserAccountState(actorId);
  if (!isProfileComplete(actor)) throw badRequest("Complete your profile first");
  const employee = await getUserAccountState(employeeId);
  const employeeType = String(employee.employment_type || "").toUpperCase();
  if (!["INTERN", "TEMPORARY"].includes(employeeType)) {
    throw badRequest("Attendance records in this module are only for interns and temporary staff");
  }
  if (actor.id === employee.id) return employee;
  if (!canCreateAdvanceOnBehalf(actor)) {
    throw forbidden("You are not allowed to prepare attendance for other employees");
  }
  if (String(actor.department || "").trim() !== String(employee.department || "").trim()) {
    throw forbidden("Attendance can only be prepared within the same department");
  }
  return employee;
}

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

attendanceRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine !== "false";
    const rows = mine
      ? await query(
          `SELECT ar.*, u.full_name AS employee_name, u.employee_no
           FROM attendance_records ar
           JOIN users u ON u.id = ar.employee_id
           WHERE ar.employee_id=$1 OR ar.compiled_by_id=$1
           ORDER BY ar.year DESC, ar.month DESC, ar.created_at DESC`,
          [req.user!.userId]
        )
      : await query(
          `SELECT ar.*, u.full_name AS employee_name, u.employee_no
           FROM attendance_records ar
           JOIN users u ON u.id = ar.employee_id
           ORDER BY ar.year DESC, ar.month DESC, ar.created_at DESC`
        );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

attendanceRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const row = (
      await query<any>(
        `SELECT ar.*, u.full_name AS employee_name, u.employee_no, u.department, u.employment_type
         FROM attendance_records ar
         JOIN users u ON u.id = ar.employee_id
         WHERE ar.id=$1`,
        [req.params.id]
      )
    )[0];
    if (!row) throw notFound();
    if (row.employee_id !== req.user!.userId && row.compiled_by_id !== req.user!.userId && req.user!.role !== "ADMIN") {
      throw forbidden();
    }
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

attendanceRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AttendanceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid attendance payload", parsed.error.flatten());
    await ensureAttendancePermissions(req.user!.userId, parsed.data.employee_id);
    const totals = summarizeDayCodes(parsed.data.day_codes);
    const rows = await query<{ id: string }>(
      `INSERT INTO attendance_records
       (id, employee_id, compiled_by_id, division, section_name, month, year, account_project_no, day_codes,
        regular_days, holidays, annual_leave, official_trips, sick_leave, checked_by, checked_date, approved_by, approved_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (employee_id, month, year)
       DO UPDATE SET
         compiled_by_id = EXCLUDED.compiled_by_id,
         division = EXCLUDED.division,
         section_name = EXCLUDED.section_name,
         account_project_no = EXCLUDED.account_project_no,
         day_codes = EXCLUDED.day_codes,
         regular_days = EXCLUDED.regular_days,
         holidays = EXCLUDED.holidays,
         annual_leave = EXCLUDED.annual_leave,
         official_trips = EXCLUDED.official_trips,
         sick_leave = EXCLUDED.sick_leave,
         checked_by = EXCLUDED.checked_by,
         checked_date = EXCLUDED.checked_date,
         approved_by = EXCLUDED.approved_by,
         approved_date = EXCLUDED.approved_date,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        parsed.data.employee_id,
        req.user!.userId,
        parsed.data.division ?? null,
        parsed.data.section_name ?? null,
        parsed.data.month,
        parsed.data.year,
        parsed.data.account_project_no ?? null,
        JSON.stringify(parsed.data.day_codes),
        totals.regular_days,
        totals.holidays,
        totals.annual_leave,
        totals.official_trips,
        totals.sick_leave,
        parsed.data.checked_by ?? null,
        parsed.data.checked_date ?? null,
        parsed.data.approved_by ?? null,
        parsed.data.approved_date ?? null,
        parsed.data.status
      ]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

attendanceRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AttendanceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid attendance payload", parsed.error.flatten());
    const existing = (await query<{ compiled_by_id: string; employee_id: string }>(`SELECT compiled_by_id, employee_id FROM attendance_records WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound();
    if (existing.compiled_by_id !== req.user!.userId && req.user!.role !== "ADMIN") throw forbidden();
    await ensureAttendancePermissions(req.user!.userId, parsed.data.employee_id);
    const totals = summarizeDayCodes(parsed.data.day_codes);
    await query(
      `UPDATE attendance_records
       SET employee_id=$2,
           compiled_by_id=$3,
           division=$4,
           section_name=$5,
           month=$6,
           year=$7,
           account_project_no=$8,
           day_codes=$9,
           regular_days=$10,
           holidays=$11,
           annual_leave=$12,
           official_trips=$13,
           sick_leave=$14,
           checked_by=$15,
           checked_date=$16,
           approved_by=$17,
           approved_date=$18,
           status=$19,
           updated_at=now()
       WHERE id=$1`,
      [
        req.params.id,
        parsed.data.employee_id,
        req.user!.userId,
        parsed.data.division ?? null,
        parsed.data.section_name ?? null,
        parsed.data.month,
        parsed.data.year,
        parsed.data.account_project_no ?? null,
        JSON.stringify(parsed.data.day_codes),
        totals.regular_days,
        totals.holidays,
        totals.annual_leave,
        totals.official_trips,
        totals.sick_leave,
        parsed.data.checked_by ?? null,
        parsed.data.checked_date ?? null,
        parsed.data.approved_by ?? null,
        parsed.data.approved_date ?? null,
        parsed.data.status
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
