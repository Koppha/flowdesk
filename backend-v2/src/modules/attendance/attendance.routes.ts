import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessSalaries } from "../../lib/salariesPermissions.js";

// Lets an employee build up their Attendance Register day-by-day instead of
// only ever reaching the database on one atomic final Submit - see the
// idx_crs_attendance_draft_unique index and custom_request_period_locks
// table (backend-v2/src/bootstrap/system.ts, ensureAttendanceDraftSchema).
// A draft is stored as a normal custom_request_submissions row with
// status='DRAFT', shaped exactly like a real submission's data, so
// custom-requests.routes.ts's POST / can promote it in place at final
// submit rather than reshaping anything.
export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

async function getAttendanceRegisterTypeId(): Promise<string> {
  const row = (await query<{ id: string }>(`SELECT id FROM custom_request_types WHERE code = 'ATTENDANCE_REGISTER'`))[0];
  if (!row) throw notFound("Attendance Register is not configured");
  return row.id;
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

// No lock row for a period means it's open - this is the only place that
// distinction is made, so both the draft save/clear below and
// custom-requests.routes.ts's final-submit guard share it.
export async function isPeriodLocked(requestTypeId: string, period: string): Promise<boolean> {
  const row = (await query<{ id: string }>(
    `SELECT id FROM custom_request_period_locks WHERE request_type_id = $1 AND period = $2`,
    [requestTypeId, period]
  ))[0];
  return Boolean(row);
}

attendanceRouter.get("/draft", async (req: AuthedRequest, res, next) => {
  try {
    const period = String(req.query.period || currentPeriod()).slice(0, 7);
    const typeId = await getAttendanceRegisterTypeId();
    const row = (await query<{ id: string; data: any }>(
      `SELECT id, data FROM custom_request_submissions
        WHERE requester_id = $1 AND request_type_id = $2 AND status = 'DRAFT' AND data->>'month' LIKE $3
        LIMIT 1`,
      [req.user!.userId, typeId, `${period}%`]
    ))[0];
    const row0 = row?.data?.attendance_grid?.rows?.[0];
    return res.json({
      period,
      division: row?.data?.division ?? null,
      department: row?.data?.department ?? null,
      cells: row0?.cells ?? {},
      locked: await isPeriodLocked(typeId, period)
    });
  } catch (err) {
    return next(err);
  }
});

const SaveDraftSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  division: z.string().trim().optional(),
  department: z.string().trim().optional(),
  cells: z.record(z.string())
});

attendanceRouter.put("/draft", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SaveDraftSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid attendance draft payload", parsed.error.flatten());
    const { period, cells } = parsed.data;

    const typeId = await getAttendanceRegisterTypeId();
    if (await isPeriodLocked(typeId, period)) {
      throw badRequest("This attendance period has been closed for edits - contact HR/Admin.");
    }

    const requester = (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [req.user!.userId]))[0];
    const data = {
      division: parsed.data.division ?? "",
      department: parsed.data.department ?? "",
      month: `${period}-01`,
      attendance_grid: { rows: [{ employee: requester?.full_name ?? "", cells }] }
    };

    // ON CONFLICT relies on idx_crs_attendance_draft_unique - at most one
    // DRAFT row per (requester, request type, month).
    const row = (await query<{ id: string }>(
      `INSERT INTO custom_request_submissions (request_type_id, requester_id, data, approval_chain, current_step_order, status)
       VALUES ($1, $2, $3, '[]', 0, 'DRAFT')
       ON CONFLICT (requester_id, request_type_id, (data->>'month')) WHERE status = 'DRAFT'
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING id`,
      [typeId, req.user!.userId, JSON.stringify(data)]
    ))[0];

    return res.json({ ok: true, id: row.id });
  } catch (err) {
    return next(err);
  }
});

attendanceRouter.delete("/draft", async (req: AuthedRequest, res, next) => {
  try {
    const period = String(req.query.period || currentPeriod()).slice(0, 7);
    const typeId = await getAttendanceRegisterTypeId();
    await query(
      `DELETE FROM custom_request_submissions
        WHERE requester_id = $1 AND request_type_id = $2 AND status = 'DRAFT' AND data->>'month' LIKE $3`,
      [req.user!.userId, typeId, `${period}%`]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Everything below manages which months are locked - available to Salaries
// access holders (ADMIN or an assigned group), same authority as the rest
// of the Salaries module's admin actions.
attendanceRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    if (!(await canAccessSalaries(req.user!.userId, req.user!.role))) throw forbidden("You do not have access to Salaries");
    next();
  } catch (err) {
    next(err);
  }
});

function recentPeriods(): string[] {
  const periods: string[] = [];
  const now = new Date();
  // Last 6 months + current + next 1 - a manageable, relevant window rather
  // than every period that ever existed.
  for (let i = 6; i >= -1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return periods;
}

attendanceRouter.get("/periods", async (_req: AuthedRequest, res, next) => {
  try {
    const typeId = await getAttendanceRegisterTypeId();
    const locks = await query<{ period: string; closed_at: string; closed_by_name: string | null }>(
      `SELECT l.period, l.closed_at, u.full_name AS closed_by_name
         FROM custom_request_period_locks l
         LEFT JOIN users u ON u.id = l.closed_by_id
        WHERE l.request_type_id = $1`,
      [typeId]
    );
    const lockByPeriod = new Map(locks.map((l) => [l.period, l]));
    const items = recentPeriods().map((period) => {
      const lock = lockByPeriod.get(period);
      return { period, locked: Boolean(lock), closed_at: lock?.closed_at ?? null, closed_by_name: lock?.closed_by_name ?? null };
    });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

const PeriodParam = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });

attendanceRouter.post("/periods/:period/close", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PeriodParam.safeParse(req.params);
    if (!parsed.success) throw badRequest("Invalid period");
    const typeId = await getAttendanceRegisterTypeId();
    await query(
      `INSERT INTO custom_request_period_locks (request_type_id, period, closed_by_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (request_type_id, period) DO NOTHING`,
      [typeId, parsed.data.period, req.user!.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

attendanceRouter.post("/periods/:period/reopen", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PeriodParam.safeParse(req.params);
    if (!parsed.success) throw badRequest("Invalid period");
    const typeId = await getAttendanceRegisterTypeId();
    await query(`DELETE FROM custom_request_period_locks WHERE request_type_id = $1 AND period = $2`, [typeId, parsed.data.period]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
