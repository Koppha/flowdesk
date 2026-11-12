import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { isCompensationFinanceSection } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { withTripDetails } from "../../lib/clearanceTrip.js";
import { canAccessRefundable } from "../../lib/refundablePermissions.js";
import { getViewerDivisionScope } from "../../lib/divisionScope.js";
import type { ChainStep } from "../../lib/workflowEngine.js";
import { paybackReviewStep } from "../claims/claims.routes.js";
import { startRefundReviewReminders } from "../../lib/refundReviewReminders.js";

// Remind HR Operations about refunds waiting for them (lib/refundReviewReminders.ts).
startRefundReviewReminders();

// Refundable is the opposite of Deductions (deductions.routes.ts): a closed
// clearance claim's balance_amount can go either way - positive means the
// claimant owes the company money (a salary deduction), negative means the
// claimant spent more of their own money on the trip than they were
// advanced, so the company owes them a refund. Deductions only ever tracked
// and actioned the positive side; this module mirrors that same
// list/act/audit flow for the negative side.
//
// Two kinds of refund are listed:
//  - Legacy: status='CLOSED' with a negative balance (the old pre-outcome
//    path). Finance marks these refunded here (PATCH /:id/refunded).
//  - New-style: financial_outcome='REFUND_DUE' (claims.service.ts's
//    computeFinancialOutcome). HR Operations sends it to Treasury, and
//    Finance Treasury processes it (POST /treasury/:id/process-refund, with
//    method/reference/voucher). They're listed here too - with where they
//    are and how long they've waited - so no refund goes unseen, but they
//    can't be marked refunded here (the PATCH stays legacy-only), so a
//    refund is never recorded in two places.
//    (Before Nov 2026 they weren't listed at all, and a M31.50 refund sat
//    with HR Operations unnoticed for four weeks.)
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
  org_division: string | null;
  department_name: string | null;
  duty_station: string | null;
  linked_advance_id: string | null;
  origin: string | null;
  destination: string | null;
  departure_date: string | null;
  return_date: string | null;
  month: string | null;
  vr_date: string | null;
  clearance_submitted_at: string | null;
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
         -- division_name above is the company (the page's tabs). The
         -- traveller's actual Division and Department in Org Structure
         -- (UI Division = users.department, UI Department = sections).
         nullif(trim(u.department), '') AS org_division,
         (SELECT s.name FROM sections s WHERE s.id = coalesce(u.section_id, (SELECT t.section_id FROM teams t WHERE t.id = u.team_id))) AS department_name,
         c.duty_station,
         c.linked_advance_id,
         c.month,
         ar.approved_at AS vr_date, -- VR Date: when the advance this clears was approved
         c.submitted_at AS clearance_submitted_at,
         EXISTS (SELECT 1 FROM receipts r WHERE r.clearance_claim_id = c.id) AS has_receipts,
         COALESCE(c.currency, 'LSL') AS currency,
         c.advance_amount,
         c.claim_total AS cleared_amount,
         -- Zero balance: the whole advance was spent. Otherwise what was
         -- actually cleared (spent) is what gets expensed.
         CASE WHEN coalesce(c.balance_amount, 0) = 0 THEN c.advance_amount ELSE c.claim_total END AS amount_to_be_expensed,
         -c.balance_amount AS refundable_amount,
         -- Refunded: the legacy toggle below, or Treasury processing a
         -- new-style refund (POST /treasury/:id/process-refund).
         CASE WHEN c.status = 'CLOSED' THEN c.refunded_at
              WHEN c.status = 'COMPLETED' THEN coalesce(c.treasury_completed_at, c.settled_at, c.updated_at) END AS refunded_at,
         CASE WHEN c.status = 'CLOSED' THEN rb.full_name ELSE tc.full_name END AS refunded_by_name,
         c.closed_at,
         c.status::text AS workflow_status,
         -- Where the refund is: PENDING (legacy - Finance marks it here),
         -- WITH_HR_OPERATIONS (REFUND_DUE - HR Operations must send it to
         -- Treasury), WITH_TREASURY (Treasury processes it), REFUNDED.
         CASE WHEN c.status = 'CLOSED' THEN CASE WHEN c.refunded_at IS NULL THEN 'PENDING' ELSE 'REFUNDED' END
              WHEN c.status = 'REFUND_DUE' THEN 'WITH_HR_OPERATIONS'
              WHEN c.status = 'FINANCE_TREASURY_REVIEW' THEN 'WITH_TREASURY'
              WHEN c.status = 'COMPLETED' THEN 'REFUNDED'
              ELSE 'IN_PROGRESS' END AS stage,
         (c.status = 'CLOSED') AS legacy,
         CASE WHEN c.status = 'FINANCE_TREASURY_REVIEW' THEN coalesce(c.sent_to_treasury_at, c.updated_at)
              ELSE coalesce(c.closed_at, c.updated_at) END AS waiting_since,
         c.settled_reference AS refund_reference,
         c.approval_chain,
         tof.full_name AS treasury_officer_name
    FROM clearance_claims c
    JOIN users u ON u.id = c.claimant_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN users rb ON rb.id = c.refunded_by_id
    LEFT JOIN users tof ON tof.id = c.treasury_officer_id
    LEFT JOIN LATERAL (
      SELECT x.full_name FROM audit_log a JOIN users x ON x.id = a.actor_id
       WHERE a.entity_type = 'clearance_claims' AND a.entity_id = c.id AND a.after_json->>'treasury_settlement_status' = 'PROCESSED'
       ORDER BY a.created_at DESC LIMIT 1
    ) tc ON c.status = 'COMPLETED'
    LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
   WHERE c.balance_amount < 0
     AND (c.status = 'CLOSED'
          -- New-style refunds, from the moment the outcome is determined.
          OR (c.financial_outcome = 'REFUND_DUE' AND c.status IN ('REFUND_DUE', 'FINANCE_TREASURY_REVIEW', 'COMPLETED')))
`;

// Refunds not paid yet (the menu badge).
const PENDING_COUNT_SQL = `
  SELECT count(*)::text AS count FROM clearance_claims
   WHERE balance_amount < 0
     AND ((status = 'CLOSED' AND refunded_at IS NULL)
          OR (financial_outcome = 'REFUND_DUE' AND status IN ('REFUND_DUE', 'FINANCE_TREASURY_REVIEW')))`;

// Who the refund is waiting with: HR Operations' reviewer (the clearance's
// close step, as for payback proofs) or the Treasury officer.
function waitingWith(row: any, names: Map<string, string>) {
  if (row.stage === "WITH_TREASURY") return row.treasury_officer_name || "Finance Treasury";
  if (row.stage !== "WITH_HR_OPERATIONS") return null;
  const chain = Array.isArray(row.approval_chain) ? (row.approval_chain as ChainStep[]) : [];
  if (!chain.length) return "HR Operations";
  const step = paybackReviewStep(chain);
  const id = step.assigned_user_id || null;
  return (id && names.get(id)) || step.position_name || "HR Operations";
}

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Refundable nav item (and its pending-count badge) at all - the real
// enforcement is the gate below, applied to every other route on this router.
refundableRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessRefundable(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(PENDING_COUNT_SQL);
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
    // Refunds are recorded centrally by MNO's own Finance/Treasury team for
    // every company (unlike Advance capture, which each company's own
    // finance team handles for itself) - see the matching comment in
    // deductions.routes.ts.
    const isFinanceAuthority = req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId));
    const allowedDivisions = isFinanceAuthority ? null : await getViewerDivisionScope(req.user!.userId, false);
    const rows = await query<RefundableRow & Record<string, any>>(`${LIST_QUERY} ORDER BY c.closed_at DESC NULLS LAST, c.created_at DESC`);
    const scoped = allowedDivisions ? rows.filter((r) => r.division_name && allowedDivisions.includes(r.division_name)) : rows;
    // Names of the HR Operations reviewers the waiting refunds are assigned to.
    const reviewerIds = Array.from(new Set(scoped
      .filter((r) => r.stage === "WITH_HR_OPERATIONS" && Array.isArray(r.approval_chain) && r.approval_chain.length)
      .map((r) => paybackReviewStep(r.approval_chain as ChainStep[]).assigned_user_id)
      .filter((id): id is string => !!id)));
    const names = new Map((reviewerIds.length
      ? await query<{ id: string; full_name: string }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [reviewerIds])
      : []).map((u) => [u.id, u.full_name]));
    const today = Date.now();
    const shaped = scoped.map(({ approval_chain, treasury_officer_name, ...r }) => ({
      ...r,
      waiting_with: waitingWith({ ...r, approval_chain, treasury_officer_name }, names),
      days_waiting: r.stage === "REFUNDED" || !r.waiting_since ? null : Math.floor((today - new Date(r.waiting_since).getTime()) / 86_400_000)
    }));
    const items = await withTripDetails(shaped);
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
