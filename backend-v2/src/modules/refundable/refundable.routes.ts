import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { isCompensationFinanceSection } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessRefundable } from "../../lib/refundablePermissions.js";
import { getViewerDivisionScope } from "../../lib/divisionScope.js";

// Refundable is the opposite of Deductions (deductions.routes.ts): a closed
// clearance claim's balance_amount can go either way - positive means the
// claimant owes the company money (a salary deduction), negative means the
// claimant spent more of their own money on the trip than they were
// advanced, so the company owes them a refund. Deductions only ever tracked
// and actioned the positive side; this module mirrors that same
// list/act/audit flow for the negative side.
export const refundableRouter = Router();
refundableRouter.use(requireAuth);

const RefundedSchema = z.object({
  refunded: z.boolean()
});

type RefundableRow = {
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
  refundable_amount: string;
  refunded_at: string | null;
  refunded_by_name: string | null;
  closed_at: string | null;
  currency: string | null;
};

const LIST_QUERY = `
  SELECT c.id,
         c.claimant_id AS employee_id,
         u.full_name AS employee_name,
         u.employee_no,
         dv.name AS division_name,
         c.duty_station AS destination,
         c.month,
         ar.approved_at AS vr_date,
         EXISTS (SELECT 1 FROM receipts r WHERE r.clearance_claim_id = c.id) AS has_receipts,
         COALESCE(c.currency, 'LSL') AS currency,
         c.advance_amount,
         c.claim_total AS cleared_amount,
         abs(c.balance_amount) AS amount_to_be_expensed,
         -c.balance_amount AS refundable_amount,
         c.refunded_at,
         rb.full_name AS refunded_by_name,
         c.closed_at
    FROM clearance_claims c
    JOIN users u ON u.id = c.claimant_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN users rb ON rb.id = c.refunded_by_id
    LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
   WHERE c.status = 'CLOSED' AND c.balance_amount < 0
`;

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Refundable nav item (and its pending-count badge) at all - the real
// enforcement is the gate below, applied to every other route on this router.
refundableRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessRefundable(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM clearance_claims
        WHERE status='CLOSED' AND balance_amount < 0 AND refunded_at IS NULL`
    );
    return res.json({ allowed, pendingCount: Number(pending[0]?.count || 0) });
  } catch (err) {
    return next(err);
  }
});

// Every route below requires module access (ADMIN or an assigned group).
refundableRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessRefundable(req.user!.userId, req.user!.role);
    if (!allowed) throw forbidden("You do not have access to Refundable");
    next();
  } catch (err) {
    next(err);
  }
});

refundableRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const allowedDivisions = await getViewerDivisionScope(req.user!.userId, req.user!.role === "ADMIN");
    const rows = await query<RefundableRow>(`${LIST_QUERY} ORDER BY c.closed_at DESC NULLS LAST, c.created_at DESC`);
    const items = allowedDivisions ? rows.filter((r) => r.division_name && allowedDivisions.includes(r.division_name)) : rows;
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

// Viewing the Refundable list can be granted to any group (e.g. HR
// Operations, for visibility only), but actually recording a refund is
// restricted to Finance dept / ADMIN regardless of that grant - mirrors the
// same view-vs-act split used for Deductions, Payments and Capture Inbox.
refundableRouter.patch("/:id/refunded", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN" && !(await isCompensationFinanceSection(req.user!.sectionId))) {
      throw forbidden("Only Finance can record a refund");
    }
    const existing = (await query<{ id: string }>(
      `SELECT id FROM clearance_claims WHERE id=$1 AND status='CLOSED' AND balance_amount < 0`,
      [req.params.id]
    ))[0];
    if (!existing) throw notFound("Refundable clearance claim not found");

    const parsed = RefundedSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid refunded payload", parsed.error.flatten());

    if (parsed.data.refunded) {
      await query(`UPDATE clearance_claims SET refunded_at=now(), refunded_by_id=$2 WHERE id=$1`, [req.params.id, req.user!.userId]);
    } else {
      await query(`UPDATE clearance_claims SET refunded_at=NULL, refunded_by_id=NULL WHERE id=$1`, [req.params.id]);
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
