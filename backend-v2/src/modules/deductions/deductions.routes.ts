import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessDeductions } from "../../lib/deductionsPermissions.js";
import { listPermissionGroups } from "../../lib/permissionGroups.js";

export const deductionsRouter = Router();
deductionsRouter.use(requireAuth);

const VrDateSchema = z.object({
  vr_date: z.string().min(1).nullable()
});

const DeductedSchema = z.object({
  deducted: z.boolean()
});

const AccessGroupsSchema = z.object({
  groups: z.array(z.string().trim().min(1))
});

type DeductionRow = {
  id: string;
  employee_id: string;
  employee_name: string | null;
  employee_no: string | null;
  division_name: string | null;
  destination: string | null;
  month: string | null;
  vr_date: string | null;
  has_receipts: boolean;
  advance_amount: string;
  cleared_amount: string;
  amount_to_be_expensed: string;
  salary_deduction: string;
  payable: string;
  deducted_at: string | null;
  deducted_by_name: string | null;
  closed_at: string | null;
};

const LIST_QUERY = `
  SELECT c.id,
         c.claimant_id AS employee_id,
         u.full_name AS employee_name,
         u.employee_no,
         dv.name AS division_name,
         c.duty_station AS destination,
         c.month,
         c.vr_date,
         EXISTS (SELECT 1 FROM receipts r WHERE r.clearance_claim_id = c.id) AS has_receipts,
         c.advance_amount,
         c.claim_total AS cleared_amount,
         abs(c.balance_amount) AS amount_to_be_expensed,
         CASE WHEN c.balance_amount > 0 THEN c.balance_amount ELSE 0 END AS salary_deduction,
         CASE WHEN c.balance_amount < 0 THEN -c.balance_amount ELSE 0 END AS payable,
         c.deducted_at,
         db.full_name AS deducted_by_name,
         c.closed_at
    FROM clearance_claims c
    JOIN users u ON u.id = c.claimant_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN users db ON db.id = c.deducted_by_id
   WHERE c.status = 'CLOSED'
`;

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Deductions nav item (and its pending-count badge) at all - the real
// enforcement is the gate below, applied to every other route on this router.
deductionsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessDeductions(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM clearance_claims
        WHERE status='CLOSED' AND balance_amount <> 0 AND deducted_at IS NULL`
    );
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
    const rows = await query<DeductionRow>(`${LIST_QUERY} ORDER BY c.closed_at DESC NULLS LAST, c.created_at DESC`);
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.patch("/:id/vr-date", async (req: AuthedRequest, res, next) => {
  try {
    const existing = (await query<{ id: string }>(`SELECT id FROM clearance_claims WHERE id=$1 AND status='CLOSED'`, [req.params.id]))[0];
    if (!existing) throw notFound("Clearance claim not found");

    const parsed = VrDateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid VR date payload", parsed.error.flatten());

    await query(`UPDATE clearance_claims SET vr_date=$2 WHERE id=$1`, [req.params.id, parsed.data.vr_date]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.patch("/:id/deducted", async (req: AuthedRequest, res, next) => {
  try {
    const existing = (await query<{ id: string }>(`SELECT id FROM clearance_claims WHERE id=$1 AND status='CLOSED'`, [req.params.id]))[0];
    if (!existing) throw notFound("Clearance claim not found");

    const parsed = DeductedSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid deducted payload", parsed.error.flatten());

    if (parsed.data.deducted) {
      await query(`UPDATE clearance_claims SET deducted_at=now(), deducted_by_id=$2 WHERE id=$1`, [req.params.id, req.user!.userId]);
    } else {
      await query(`UPDATE clearance_claims SET deducted_at=NULL, deducted_by_id=NULL WHERE id=$1`, [req.params.id]);
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
