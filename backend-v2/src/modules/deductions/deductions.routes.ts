import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessDeductions } from "../../lib/deductionsPermissions.js";
import { listPermissionGroups } from "../../lib/permissionGroups.js";

export const deductionsRouter = Router();
deductionsRouter.use(requireAuth);

export const DEDUCTION_TYPES = ["Late Clearance", "No Clearance"] as const;

const DeductionSchema = z.object({
  employee_id: z.string().uuid(),
  deduction_type: z.enum(DEDUCTION_TYPES),
  amount: z.number().positive(),
  deduction_date: z.string().min(1),
  reason: z.string().trim().optional()
});

const StatusSchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "PROCESSED"])
});

const AccessGroupsSchema = z.object({
  groups: z.array(z.string().trim().min(1))
});

type DeductionRow = {
  id: string;
  deduction_type: string;
  employee_id: string;
  employee_name: string | null;
  department: string | null;
  amount: string;
  deduction_date: string;
  reason: string | null;
  status: string;
  requested_by_id: string;
  requested_by_name: string | null;
  created_at: string;
  updated_at: string;
};

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Deductions nav item (and its pending-count badge) at all - the real
// enforcement is the gate below, applied to every other route on this router.
deductionsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessDeductions(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(`SELECT count(*)::text AS count FROM deductions WHERE status='PENDING'`);
    return res.json({ allowed, pendingCount: Number(pending[0]?.count || 0) });
  } catch (err) {
    return next(err);
  }
});

// Admin-only management of which groups (roles/divisions/departments/
// sections/teams - see permissionGroups.ts) have module-wide access.
deductionsRouter.get("/access-groups", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    const [granted, available] = await Promise.all([
      query<{ group_name: string }>(`SELECT group_name FROM deduction_access_groups ORDER BY group_name`),
      listPermissionGroups()
    ]);
    return res.json({ granted: granted.map((g) => g.group_name), available });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.put("/access-groups", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AccessGroupsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid access groups payload", parsed.error.flatten());
    const groups = Array.from(new Set(parsed.data.groups.filter(Boolean)));
    await query(`DELETE FROM deduction_access_groups`);
    for (const name of groups) {
      await query(
        `INSERT INTO deduction_access_groups (group_name, granted_by_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [name, req.user!.userId]
      );
    }
    return res.json({ granted: groups });
  } catch (err) {
    return next(err);
  }
});

// Every route below requires module access (ADMIN or an assigned group).
deductionsRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessDeductions(req.user!.userId, req.user!.role);
    if (!allowed) throw forbidden("You do not have access to Deductions");
    next();
  } catch (err) {
    next(err);
  }
});

deductionsRouter.get("/", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<DeductionRow>(
      `SELECT d.id, d.deduction_type, d.employee_id, e.full_name AS employee_name, e.department,
              d.amount, d.deduction_date, d.reason, d.status,
              d.requested_by_id, r.full_name AS requested_by_name,
              d.created_at, d.updated_at
         FROM deductions d
         JOIN users e ON e.id = d.employee_id
         JOIN users r ON r.id = d.requested_by_id
        ORDER BY d.created_at DESC`
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = DeductionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid deduction payload", parsed.error.flatten());
    const { employee_id, deduction_type, amount, deduction_date, reason } = parsed.data;

    const employee = (await query<{ id: string }>(`SELECT id FROM users WHERE id=$1 AND is_active=true`, [employee_id]))[0];
    if (!employee) throw notFound("Employee not found");

    const row = (await query<{ id: string }>(
      `INSERT INTO deductions (deduction_type, employee_id, amount, deduction_date, reason, requested_by_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [deduction_type, employee_id, amount, deduction_date, reason ?? null, req.user!.userId]
    ))[0];

    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const existing = (await query<{ status: string }>(`SELECT status FROM deductions WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound("Deduction not found");
    if (existing.status !== "PENDING") throw badRequest("Only pending deductions can be edited");

    const parsed = DeductionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid deduction payload", parsed.error.flatten());
    const { employee_id, deduction_type, amount, deduction_date, reason } = parsed.data;

    const employee = (await query<{ id: string }>(`SELECT id FROM users WHERE id=$1 AND is_active=true`, [employee_id]))[0];
    if (!employee) throw notFound("Employee not found");

    await query(
      `UPDATE deductions
          SET deduction_type=$2, employee_id=$3, amount=$4, deduction_date=$5, reason=$6, updated_at=now()
        WHERE id=$1`,
      [req.params.id, deduction_type, employee_id, amount, deduction_date, reason ?? null]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.patch("/:id/status", async (req: AuthedRequest, res, next) => {
  try {
    const existing = (await query<{ status: string }>(`SELECT status FROM deductions WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound("Deduction not found");

    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid status payload", parsed.error.flatten());

    await query(`UPDATE deductions SET status=$2, updated_at=now() WHERE id=$1`, [req.params.id, parsed.data.status]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const existing = (await query<{ status: string }>(`SELECT status FROM deductions WHERE id=$1`, [req.params.id]))[0];
    if (!existing) throw notFound("Deduction not found");
    if (existing.status !== "PENDING") throw badRequest("Only pending deductions can be deleted");

    await query(`DELETE FROM deductions WHERE id=$1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
