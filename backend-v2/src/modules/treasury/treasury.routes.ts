import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, hasFeatureAccess, requireAuth, requireFeatureAccess, requireFinance } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { pickRoundRobinAssignee } from "../../lib/workflowEngine.js";
import { notifyClaimTask } from "../../lib/notifications.js";
import { writeClaimAudit, getClaimNotificationContext } from "../claims/claims.routes.js";

// Every HR-Operations-reviewed clearance (regardless of outcome - balanced,
// refund, or a verified payback) continues here before the workflow is
// truly COMPLETED. Treasury authority reuses isCompensationFinanceSection/
// requireFinance - the same authority that already gates Capture/
// Deductions/Refundable, not a separate permission concept. The queue's own
// *visibility* (not the act-on-it authority) is additionally gated by the
// admin-configurable "treasury_processing" feature key, mirroring
// Deductions/Refundable's own view-vs-act split.
export const treasuryRouter = Router();
treasuryRouter.use(requireAuth);

const TREASURY_FEATURE_DEFAULTS = ["ADMIN", "Section: Treasury & Financial Accounting"];

treasuryRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await hasFeatureAccess(req.user!.userId, req.user!.role, "treasury_processing", TREASURY_FEATURE_DEFAULTS);
    if (!allowed) return res.json({ allowed });
    const pending = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM clearance_claims WHERE status='FINANCE_TREASURY_REVIEW'`
    );
    return res.json({ allowed, pendingCount: Number(pending[0]?.count || 0) });
  } catch (err) {
    return next(err);
  }
});

treasuryRouter.use(requireFeatureAccess("treasury_processing", TREASURY_FEATURE_DEFAULTS));

async function assignTreasuryOfficers() {
  const unassigned = await query<{ id: string }>(
    `SELECT id FROM clearance_claims WHERE status='FINANCE_TREASURY_REVIEW' AND treasury_officer_id IS NULL ORDER BY updated_at LIMIT 50`
  );
  if (!unassigned.length) return;
  const pool = await query<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u JOIN sections s ON s.id = u.section_id
      WHERE s.is_compensation_finance = true AND u.is_active = true`
  );
  const poolIds = pool.map((p) => p.id);
  if (!poolIds.length) return;
  for (const row of unassigned) {
    const officerId = await pickRoundRobinAssignee("treasury_processing", poolIds);
    if (officerId) {
      await query(`UPDATE clearance_claims SET treasury_officer_id=$2, updated_at=updated_at WHERE id=$1 AND treasury_officer_id IS NULL`, [row.id, officerId]);
    }
  }
}

const ListQuerySchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  employee_id: z.string().uuid().optional(),
  division: z.string().optional(),
  department: z.string().optional(),
  financial_outcome: z.enum(["BALANCED", "REFUND_DUE", "PAYBACK_DUE"]).optional(),
  treasury_status: z.enum(["NOT_REQUIRED", "PENDING", "PROCESSED", "RECONCILED"]).optional(),
  assigned_officer: z.string().uuid().optional(),
  destination: z.string().optional(),
  outcome_state: z.enum(["OUTSTANDING", "COMPLETED"]).optional()
});

// Server-side filtered, per the user's explicit instruction for large
// reports/queues - never loads the whole table into the browser to filter
// client-side (unlike the older Report*.tsx pages' pattern).
treasuryRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    await assignTreasuryOfficers();
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid filters", parsed.error.flatten());
    const f = parsed.data;

    const where: string[] = [`c.financial_outcome IS NOT NULL`];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

    if (f.outcome_state === "COMPLETED") where.push(`c.status = 'COMPLETED'`);
    else if (f.outcome_state === "OUTSTANDING") where.push(`c.status != 'COMPLETED'`);
    if (f.date_from) where.push(`c.submitted_at >= ${p(f.date_from)}`);
    if (f.date_to) where.push(`c.submitted_at <= ${p(f.date_to)}`);
    if (f.employee_id) where.push(`c.claimant_id = ${p(f.employee_id)}`);
    if (f.division) where.push(`dv.name = ${p(f.division)}`);
    if (f.department) where.push(`u.department = ${p(f.department)}`);
    if (f.financial_outcome) where.push(`c.financial_outcome = ${p(f.financial_outcome)}`);
    if (f.treasury_status) where.push(`c.treasury_settlement_status = ${p(f.treasury_status)}`);
    if (f.assigned_officer) where.push(`c.treasury_officer_id = ${p(f.assigned_officer)}`);
    if (f.destination) where.push(`c.duty_station ILIKE ${p(`%${f.destination}%`)}`);

    const rows = await query<any>(
      `SELECT c.id, c.claimant_id, u.full_name AS employee_name, u.employee_no,
              dv.name AS division_name, u.department, c.duty_station AS destination,
              c.submitted_at, c.closed_at,
              c.advance_amount, c.claim_total AS verified_expenses,
              c.financial_outcome,
              CASE WHEN c.balance_amount < 0 THEN -c.balance_amount ELSE 0 END AS refund_amount,
              CASE WHEN c.balance_amount > 0 THEN c.balance_amount ELSE 0 END AS payback_amount,
              c.employee_clearance_status, c.status AS workflow_status,
              c.treasury_settlement_status, c.sent_to_treasury_at,
              off.full_name AS treasury_officer_name, c.treasury_officer_id,
              c.treasury_completed_at, c.payback_verified_at,
              COALESCE(c.currency, 'LSL') AS currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN users off ON off.id = c.treasury_officer_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.submitted_at DESC NULLS LAST`,
      params
    );

    const summary = {
      awaiting_review: rows.filter((r) => r.workflow_status === "FINANCE_TREASURY_REVIEW").length,
      refunds_awaiting_payment: rows.filter((r) => r.financial_outcome === "REFUND_DUE" && r.workflow_status === "FINANCE_TREASURY_REVIEW").length,
      paybacks_awaiting_reconciliation: rows.filter((r) => r.financial_outcome === "PAYBACK_DUE" && r.workflow_status === "FINANCE_TREASURY_REVIEW").length,
      balanced_awaiting_completion: rows.filter((r) => r.financial_outcome === "BALANCED" && r.workflow_status === "FINANCE_TREASURY_REVIEW").length,
      returned_to_hr: rows.filter((r) => r.workflow_status === "PAYBACK_PROOF_SUBMITTED" && r.treasury_returned_at).length,
      completed_today: rows.filter((r) => r.treasury_completed_at && new Date(r.treasury_completed_at).toDateString() === new Date().toDateString()).length,
      total_outstanding_refund: rows.filter((r) => r.financial_outcome === "REFUND_DUE" && r.workflow_status !== "COMPLETED").reduce((s, r) => s + Number(r.refund_amount || 0), 0)
    };

    return res.json({ items: rows, summary });
  } catch (err) {
    return next(err);
  }
});

async function loadTreasuryClaim(id: string) {
  const claim = (await query<any>(`SELECT * FROM clearance_claims WHERE id=$1`, [id]))[0];
  if (!claim) throw notFound();
  if (!claim.financial_outcome) throw badRequest("This clearance has not yet reached a financial outcome");
  return claim;
}

async function completeAndNotify(claimId: string, actorId: string, message: string) {
  const notificationContext = await getClaimNotificationContext(claimId);
  if (notificationContext) {
    await notifyClaimTask({
      claimId,
      status: "COMPLETED",
      claimantName: notificationContext.full_name,
      claimantEmail: notificationContext.email,
      department: notificationContext.department,
      claimTotal: Number(notificationContext.claim_total),
      currency: notificationContext.currency,
      claimType: notificationContext.claim_type
    });
  }
}

treasuryRouter.post("/:id/complete-balanced", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadTreasuryClaim(req.params.id);
    if (claim.financial_outcome !== "BALANCED") throw badRequest("This action is only for a BALANCED outcome");
    if (claim.status !== "FINANCE_TREASURY_REVIEW") throw badRequest("This clearance is not awaiting Treasury review");

    const parsed = z.object({ posting_reference: z.string().trim().optional(), comment: z.string().trim().optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    await query(
      `UPDATE clearance_claims SET
         treasury_settlement_status='RECONCILED', status='COMPLETED',
         treasury_posting_reference=$2, treasury_comment=$3, treasury_completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [claim.id, parsed.data.posting_reference ?? null, parsed.data.comment ?? null]
    );
    await writeClaimAudit({
      actorId: req.user!.userId, claimId: claim.id, action: "TREASURY_COMPLETE_BALANCED",
      before: { status: claim.status }, after: { status: "COMPLETED", treasury_settlement_status: "RECONCILED" }
    });
    await completeAndNotify(claim.id, req.user!.userId, "Balanced clearance completed by Treasury");
    return res.json({ ok: true, status: "COMPLETED" });
  } catch (err) {
    return next(err);
  }
});

const ProcessRefundSchema = z.object({
  amount: z.coerce.number().positive("Amount is required"),
  payment_date: z.string().trim().min(1, "Payment date is required"),
  payment_method: z.string().trim().min(1, "Payment method is required"),
  reference: z.string().trim().min(1, "Payment reference is required"),
  voucher_reference: z.string().trim().optional(),
  comment: z.string().trim().optional()
});

treasuryRouter.post("/:id/process-refund", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadTreasuryClaim(req.params.id);
    if (claim.financial_outcome !== "REFUND_DUE") throw badRequest("This action is only for a REFUND_DUE outcome");
    if (claim.status !== "FINANCE_TREASURY_REVIEW") throw badRequest("This clearance is not awaiting Treasury review");

    const parsed = ProcessRefundSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid refund payload", parsed.error.flatten());

    // Partial refunds are not supported by the current business process -
    // reject any amount that doesn't exactly match the approved refund.
    const requiredAmount = Number((-Number(claim.balance_amount)).toFixed(2));
    if (Number(parsed.data.amount.toFixed(2)) !== requiredAmount) {
      throw badRequest(`Refund amount must exactly match the approved refund amount (${requiredAmount.toFixed(2)})`);
    }

    await query(
      `UPDATE clearance_claims SET
         treasury_settlement_status='PROCESSED', employee_clearance_status='FULLY_CLEARED', status='COMPLETED',
         settled_method=$2, settled_reference=$3, settled_at=now(), settlement_amount=$4,
         treasury_posting_reference=$5, treasury_comment=$6, treasury_completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [claim.id, parsed.data.payment_method, parsed.data.reference, parsed.data.amount, parsed.data.voucher_reference ?? null, parsed.data.comment ?? null]
    );
    await writeClaimAudit({
      actorId: req.user!.userId, claimId: claim.id, action: "TREASURY_PROCESS_REFUND",
      before: { status: claim.status },
      after: { status: "COMPLETED", treasury_settlement_status: "PROCESSED", amount: parsed.data.amount, reference: parsed.data.reference }
    });

    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext?.email) {
      await notifyClaimTask({
        claimId: claim.id, status: "COMPLETED", claimantName: notificationContext.full_name, claimantEmail: notificationContext.email,
        department: notificationContext.department, claimTotal: parsed.data.amount, currency: notificationContext.currency, claimType: notificationContext.claim_type
      });
    }
    return res.json({ ok: true, status: "COMPLETED" });
  } catch (err) {
    return next(err);
  }
});

const ReconcilePaybackSchema = z.object({
  amount_received: z.coerce.number().positive("Amount received is required"),
  receipt_date: z.string().trim().min(1, "Receipt date is required"),
  transaction_reference: z.string().trim().min(1, "Transaction reference is required"),
  bank_reference: z.string().trim().optional(),
  posting_reference: z.string().trim().optional(),
  reconciliation_date: z.string().trim().min(1, "Reconciliation date is required"),
  comment: z.string().trim().optional()
});

treasuryRouter.post("/:id/reconcile-payback", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadTreasuryClaim(req.params.id);
    if (claim.financial_outcome !== "PAYBACK_DUE") throw badRequest("This action is only for a PAYBACK_DUE outcome");
    if (!claim.payback_verified_at) throw badRequest("HR Operations has not yet verified this repayment - Treasury cannot reconcile unverified payback proof");
    if (claim.status !== "FINANCE_TREASURY_REVIEW") throw badRequest("This clearance is not awaiting Treasury review");

    const parsed = ReconcilePaybackSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid reconciliation payload", parsed.error.flatten());

    await query(
      `UPDATE clearance_claims SET
         treasury_settlement_status='RECONCILED', status='COMPLETED',
         settled_reference=$2, settlement_amount=$3, settled_at=$4,
         treasury_posting_reference=$5, treasury_reconciliation_date=$6, treasury_comment=$7,
         treasury_completed_at=now(), updated_at=now()
       WHERE id=$1`,
      [
        claim.id, parsed.data.transaction_reference, parsed.data.amount_received, parsed.data.receipt_date,
        parsed.data.posting_reference ?? null, parsed.data.reconciliation_date, parsed.data.comment ?? null
      ]
    );
    await writeClaimAudit({
      actorId: req.user!.userId, claimId: claim.id, action: "TREASURY_RECONCILE_PAYBACK",
      before: { status: claim.status },
      after: { status: "COMPLETED", treasury_settlement_status: "RECONCILED", amount_received: parsed.data.amount_received }
    });
    await completeAndNotify(claim.id, req.user!.userId, "Payback reconciled by Treasury");
    return res.json({ ok: true, status: "COMPLETED" });
  } catch (err) {
    return next(err);
  }
});

const ReturnToHrSchema = z.object({ reason: z.string().trim().min(1, "A reason is required") });

// Treasury couldn't locate/reconcile the payment - sends it back to HR
// Operations without discarding the prior verification or the payment
// proof (spec: preserve the previous HR Operations verification and create
// a new audit entry).
treasuryRouter.post("/:id/return-to-hr", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ReturnToHrSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("A reason is required", parsed.error.flatten());

    const claim = await loadTreasuryClaim(req.params.id);
    if (claim.financial_outcome !== "PAYBACK_DUE") throw badRequest("This action is only for a PAYBACK_DUE outcome");
    if (claim.status !== "FINANCE_TREASURY_REVIEW") throw badRequest("This clearance is not awaiting Treasury review");

    await query(
      `UPDATE clearance_claims SET
         status='PAYBACK_PROOF_SUBMITTED',
         treasury_return_reason=$2, treasury_returned_at=now(), updated_at=now()
       WHERE id=$1`,
      [claim.id, parsed.data.reason]
    );
    await writeClaimAudit({
      actorId: req.user!.userId, claimId: claim.id, action: "TREASURY_RETURNED_TO_HR",
      before: { status: claim.status }, after: { status: "PAYBACK_PROOF_SUBMITTED", reason: parsed.data.reason }
    });

    // Notify the same round-robin HR Operations reviewer who verified this
    // payback originally (claim.approval_chain's last step) - not Treasury,
    // who is the one sending it back.
    const notificationContext = await getClaimNotificationContext(claim.id);
    const chain = claim.approval_chain as { assigned_user_id?: string | null; approvers?: { id: string; name: string | null; email: string | null; title: string | null }[] }[] | null;
    const lastStep = chain?.[chain.length - 1];
    const reviewer = lastStep?.approvers?.find((a) => a.id === lastStep.assigned_user_id) ?? null;
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status: "PAYBACK_PROOF_SUBMITTED",
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type,
        nextApprover: reviewer ? { id: reviewer.id, name: reviewer.name, email: reviewer.email, title: `${reviewer.title || "HR Operations"} (returned by Treasury: ${parsed.data.reason})` } : null,
        stepOrder: chain ? chain.length - 1 : undefined
      });
    }
    return res.json({ ok: true, status: "PAYBACK_PROOF_SUBMITTED" });
  } catch (err) {
    return next(err);
  }
});
