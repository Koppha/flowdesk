import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureLocalFile } from "../../lib/fileStore.js";
import { type AuthedRequest, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { isCompensationFinanceSection, isWorkflowFinanceStaff } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import type { ChainStep } from "../../lib/workflowEngine.js";
import { notifyPaybackProofQueried } from "../../lib/notifications.js";
import { getClaimNotificationContext, paybackReviewStep, writeClaimAudit } from "../claims/claims.routes.js";
import { isTreasuryActor } from "../treasury/treasury.routes.js";
import { withTripDetails } from "../../lib/clearanceTrip.js";
import { canAccessDeductions } from "../../lib/deductionsPermissions.js";
import { getViewerDivisionScope } from "../../lib/divisionScope.js";
import { clearanceDueSql, isUnclearedSql, TODAY_SQL } from "../../lib/clearanceDue.js";

export const deductionsRouter = Router();
deductionsRouter.use(requireAuth);

const DeductedSchema = z.object({
  deducted: z.boolean()
});

type DeductionRow = {
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
  salary_deduction: string;
  payable: string;
  deducted_at: string | null;
  deducted_by_name: string | null;
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
         CASE WHEN c.balance_amount > 0 THEN c.balance_amount ELSE 0 END AS salary_deduction,
         CASE WHEN c.balance_amount < 0 THEN -c.balance_amount ELSE 0 END AS payable,
         c.deducted_at,
         db.full_name AS deducted_by_name,
         c.closed_at
    FROM clearance_claims c
    JOIN users u ON u.id = c.claimant_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN users db ON db.id = c.deducted_by_id
    LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
   WHERE c.status = 'CLOSED'
`;

// Lightweight, always-200 check the frontend uses to decide whether to show
// the Deductions nav item (and its pending-count badge) at all - the real
// enforcement is the gate below, applied to every other route on this router.
deductionsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const allowed = await canAccessDeductions(req.user!.userId, req.user!.role);
    // View Clearances has its own, wider audience (see canViewClearances).
    const viewClearances = allowed || (await canViewClearances(req));
    if (!allowed) return res.json({ allowed, viewClearances });
    const pending = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM clearance_claims
        WHERE status='CLOSED' AND balance_amount <> 0 AND deducted_at IS NULL`
    );
    return res.json({ allowed, viewClearances, pendingCount: Number(pending[0]?.count || 0) });
  } catch (err) {
    return next(err);
  }
});

// Who can open View Clearances - and everyone who can open it can also use
// its Query (payback proof) button: the Deductions row in Roles & Permissions
// (as before), the "View Clearances + Query Payback Proof" row, Treasury, and
// anyone Workflow Builder puts on an Advance Capture or a Mark Paid (payment
// officer) step - so SEFS's, and any future company's, own finance team
// qualifies as soon as their workflows are set up.
const PAYBACK_QUERY_DEFAULTS = ["ADMIN", "Section: Treasury & Financial Accounting"];
async function canViewClearances(req: AuthedRequest): Promise<boolean> {
  return (await canAccessDeductions(req.user!.userId, req.user!.role))
    || (await hasFeatureAccess(req.user!.userId, req.user!.role, "payback_query", PAYBACK_QUERY_DEFAULTS))
    || (await isTreasuryActor(req))
    || (await isWorkflowFinanceStaff(req.user!.userId));
}

// /all-clearances/* (View Clearances) sits on its own sub-router, mounted
// before the Deductions-only gate below, so it can use canViewClearances.
const viewClearancesRouter = Router();
viewClearancesRouter.use(async (req: AuthedRequest, _res, next) => {
  try {
    if (!(await canViewClearances(req))) throw forbidden("You do not have access to View Clearances");
    next();
  } catch (err) {
    next(err);
  }
});
deductionsRouter.use("/all-clearances", viewClearancesRouter);

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

// Same columns/division-scoping as GET / above, but every clearance
// regardless of status (not just CLOSED) - a roster for Finance to see where
// every clearance company-wide actually stands, not just the ones that have
// reached the deduction stage. The only action is querying a payback proof. A separate query (not a derivation of
// LIST_QUERY) so this status column and broader WHERE clause don't have to
// be spliced into a string built for a different purpose.
const ALL_CLEARANCES_QUERY = `
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
         -- Paid Back: what the employee has shown they repaid, from their
         -- latest payback proof. Counts as soon as it's submitted (not only
         -- once HR Operations verifies it) - a rejected proof doesn't count.
         -- Whatever has been paid back no longer needs deducting from salary.
         coalesce(pp.paid_back, 0) AS paid_back,
         CASE WHEN c.balance_amount > 0 THEN greatest(c.balance_amount - coalesce(pp.paid_back, 0), 0) ELSE 0 END AS salary_deduction,
         CASE WHEN c.balance_amount < 0 THEN -c.balance_amount ELSE 0 END AS payable,
         pp.id AS payback_proof_id,
         pp.status AS payback_proof_status,
         pp.amount_paid AS payback_proof_amount,
         pp.payment_date AS payback_payment_date,
         pp.reference AS payback_reference,
         pp.query_reason AS payback_query_reason,
         pp.queried_at AS payback_queried_at,
         pp.queried_by_name AS payback_queried_by_name,
         c.status::text AS status,
         c.closed_at
    FROM clearance_claims c
    JOIN users u ON u.id = c.claimant_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.status, p.amount_paid, p.payment_date, p.reference,
             p.query_reason, p.queried_at,
             (SELECT q.full_name FROM users q WHERE q.id = p.queried_by_id) AS queried_by_name,
             -- QUERIED (by Finance) and REJECTED (by HR Operations) proofs
             -- don't count until the employee resubmits.
             CASE WHEN p.status IN ('SUBMITTED', 'VERIFIED') THEN p.amount_paid ELSE 0 END AS paid_back
        FROM clearance_payback_proofs p
       WHERE p.clearance_claim_id = c.id
       ORDER BY p.version DESC
       LIMIT 1
    ) pp ON true
   WHERE c.status <> 'DRAFT'
`;

// Paid travel advances nobody has cleared: past the clearance window after
// the traveller returned (lib/clearanceDue.ts) with no clearance submitted.
// Shown on View Clearances as status UNCLEARED, in the same row shape as a
// clearance (id = the advance's id; nothing cleared, nothing to query).
const UNCLEARED_ADVANCES_QUERY = `
  SELECT ar.id,
         ar.requester_id AS employee_id,
         u.full_name AS employee_name,
         u.employee_no,
         dv.name AS division_name,
         nullif(trim(u.department), '') AS org_division,
         (SELECT s.name FROM sections s WHERE s.id = coalesce(u.section_id, (SELECT t.section_id FROM teams t WHERE t.id = u.team_id))) AS department_name,
         NULL::text AS duty_station,
         ar.id AS linked_advance_id,
         NULL::text AS month,
         ar.approved_at AS vr_date,
         NULL::timestamptz AS clearance_submitted_at,
         false AS has_receipts,
         COALESCE(tt.currency, 'LSL') AS currency,
         COALESCE(NULLIF(ar.approved_total, 0), ar.requested_total) AS advance_amount,
         0 AS cleared_amount,
         0 AS amount_to_be_expensed,
         0 AS paid_back,
         0 AS salary_deduction,
         0 AS payable,
         NULL::uuid AS payback_proof_id,
         NULL::text AS payback_proof_status,
         'UNCLEARED' AS status,
         NULL::timestamptz AS closed_at,
         ar.paid_at,
         to_char(${clearanceDueSql("ar")}, 'YYYY-MM-DD') AS clearance_due_at,
         (${TODAY_SQL} - ${clearanceDueSql("ar")})::int AS days_overdue,
         ar.not_cleared_confirmed_at,
         ar.recovery_deduction_amount,
         EXISTS (SELECT 1 FROM clearance_claims cc WHERE cc.linked_advance_id = ar.id AND cc.status = 'DRAFT') AS has_draft
    FROM advance_requests ar
    JOIN users u ON u.id = ar.requester_id
    JOIN travel_types tt ON tt.code = ar.type
    LEFT JOIN divisions dv ON dv.id = u.division_id
    CROSS JOIN (SELECT clearance_duration_days FROM advance_recovery_settings ORDER BY updated_at DESC LIMIT 1) ars
   WHERE ar.type NOT IN ('SALARY', 'LOAN')
     AND ${isUnclearedSql("ar")}
   ORDER BY ar.paid_at`;

viewClearancesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const isFinanceAuthority = req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId));
    const allowedDivisions = isFinanceAuthority ? null : await getViewerDivisionScope(req.user!.userId, false);
    const claims = await query<DeductionRow & { status: string }>(`${ALL_CLEARANCES_QUERY} ORDER BY c.updated_at DESC`);
    const uncleared = await query<DeductionRow & { status: string }>(UNCLEARED_ADVANCES_QUERY);
    // Uncleared advances first: they're the ones needing chasing.
    const rows = [...uncleared, ...claims];
    const items = await withTripDetails(allowedDivisions ? rows.filter((r) => r.division_name && allowedDivisions.includes(r.division_name)) : rows);
    // Everyone who can open View Clearances (the router gate) can query.
    return res.json({ items, can_query_payback: true });
  } catch (err) {
    return next(err);
  }
});

// Clearance stages at which Finance may query the employee's payback proof:
// awaiting HR Operations verification (incl. returned by Treasury), or
// verified and awaiting Treasury reconciliation. Once COMPLETED it's done.
const QUERYABLE_CLAIM_STATUSES = ["PAYBACK_PROOF_SUBMITTED", "FINANCE_TREASURY_REVIEW"];
const PaybackQuerySchema = z.object({ reason: z.string().trim().min(3, "Say what's wrong with the proof") });

// Finance queries a payback proof from View Clearances: the proof stops
// counting as paid (Salary Deduction comes back), the clearance goes back to
// the employee to upload corrected proof - reusing the existing
// PAYBACK_PROOF_REJECTED resubmission path (claims.routes.ts POST
// /:id/payback-proof) - and HR Operations is copied. The proof row is marked
// QUERIED rather than REJECTED so every screen can say it was Finance's query.
viewClearancesRouter.post("/:id/payback-proof/:proofId/query", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PaybackQuerySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("A query reason is required", parsed.error.flatten());

    const claim = (await query<{ id: string; status: string; balance_amount: string; currency: string | null; approval_chain: ChainStep[] | null; division_name: string | null }>(
      `SELECT c.id, c.status::text AS status, c.balance_amount, c.currency, c.approval_chain, dv.name AS division_name
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE c.id = $1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound("Clearance not found");
    const isFinanceAuthority = req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId));
    if (!isFinanceAuthority) {
      const allowedDivisions = await getViewerDivisionScope(req.user!.userId, false);
      if (allowedDivisions && !(claim.division_name && allowedDivisions.includes(claim.division_name))) throw forbidden();
    }
    if (!QUERYABLE_CLAIM_STATUSES.includes(claim.status)) {
      throw badRequest("This payback can only be queried while it's with HR Operations or awaiting Treasury reconciliation");
    }

    const proof = (await query<{ id: string; status: string; amount_paid: string }>(
      `SELECT id, status, amount_paid FROM clearance_payback_proofs
        WHERE clearance_claim_id=$1
        ORDER BY version DESC LIMIT 1`,
      [claim.id]
    ))[0];
    if (!proof || proof.id !== req.params.proofId) throw badRequest("Only the latest payback proof can be queried");
    if (!["SUBMITTED", "VERIFIED"].includes(proof.status)) throw badRequest("This proof has already been queried or rejected");

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE clearance_payback_proofs SET status='QUERIED', queried_by_id=$2, queried_at=now(), query_reason=$3 WHERE id=$1`,
        [proof.id, req.user!.userId, parsed.data.reason]
      );
      // Back to the employee via the existing resubmission state; undo any
      // HR verification's "fully cleared" - the payback is owed again.
      await client.query(
        `UPDATE clearance_claims SET status='PAYBACK_PROOF_REJECTED',
           employee_clearance_status='NOT_CLEARED', payback_verified_by_id=NULL, payback_verified_at=NULL,
           updated_at=now()
         WHERE id=$1`,
        [claim.id]
      );
    });

    await writeClaimAudit({
      actorId: req.user!.userId,
      claimId: claim.id,
      action: "PAYBACK_PROOF_QUERIED",
      before: { status: claim.status, proof_status: proof.status },
      after: { status: "PAYBACK_PROOF_REJECTED", proof_id: proof.id, proof_status: "QUERIED", reason: parsed.data.reason }
    });

    const ctx = await getClaimNotificationContext(claim.id);
    if (ctx) {
      const reviewStep = claim.approval_chain?.length ? paybackReviewStep(claim.approval_chain) : null;
      const reviewer = reviewStep?.approvers?.find((a) => a.id === reviewStep.assigned_user_id) ?? null;
      await notifyPaybackProofQueried({
        claimId: claim.id,
        claimantName: ctx.full_name,
        claimantEmail: ctx.email,
        department: ctx.department,
        reason: parsed.data.reason,
        amount: Number(proof.amount_paid),
        currency: ctx.currency,
        queriedByName: req.user!.fullName ?? null,
        hrReviewer: reviewer ? { name: reviewer.name, email: reviewer.email } : null
      });
    }

    return res.json({ ok: true, status: "PAYBACK_PROOF_REJECTED" });
  } catch (err) {
    return next(err);
  }
});

// The payback proof attachment behind a row's Paid Back amount on View
// Clearances. Gated by the same module access (router-level guard above) and
// company scoping as the list itself, rather than claims.routes.ts's
// per-claim canViewClaim - Finance viewing this roster usually isn't on the
// clearance's approval chain.
viewClearancesRouter.get("/:id/payback-proof/:proofId/file", async (req: AuthedRequest, res, next) => {
  try {
    const row = (await query<{ file_path: string; division_name: string | null }>(
      `SELECT p.file_path, dv.name AS division_name
         FROM clearance_payback_proofs p
         JOIN clearance_claims c ON c.id = p.clearance_claim_id
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE p.id = $1 AND p.clearance_claim_id = $2`,
      [req.params.proofId, req.params.id]
    ))[0];
    if (!row) throw notFound("Payback proof not found");
    const isFinanceAuthority = req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId));
    if (!isFinanceAuthority) {
      const allowedDivisions = await getViewerDivisionScope(req.user!.userId, false);
      if (allowedDivisions && !(row.division_name && allowedDivisions.includes(row.division_name))) throw forbidden();
    }
    const localPath = await ensureLocalFile(row.file_path);
    if (!localPath) throw notFound("This proof's file is missing");

    const ext = path.extname(row.file_path).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg"
    };
    const fileName = path.basename(row.file_path).replace(/^\d+-/, "");
    res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    fs.createReadStream(localPath).pipe(res);
  } catch (err) {
    return next(err);
  }
});

deductionsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    // Deductions are recorded centrally by MNO's own Finance/Treasury team
    // for every company (unlike Advance capture, which each company's own
    // finance team handles for itself) - so a Finance-authority viewer's
    // scope is company-wide, not limited to their own division. Anyone else
    // with view-only module access (e.g. a company's own finance-adjacent
    // staff granted visibility but not the is_compensation_finance flag)
    // still only sees their own company's rows.
    const isFinanceAuthority = req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId));
    const allowedDivisions = isFinanceAuthority ? null : await getViewerDivisionScope(req.user!.userId, false);
    const rows = await query<DeductionRow>(`${LIST_QUERY} ORDER BY c.closed_at DESC NULLS LAST, c.created_at DESC`);
    const items = await withTripDetails(allowedDivisions ? rows.filter((r) => r.division_name && allowedDivisions.includes(r.division_name)) : rows);
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

// Viewing the Deductions list can be granted to any group (e.g. HR
// Operations, for visibility only), but actually recording a deduction is
// restricted to Finance dept / ADMIN regardless of that grant - mirrors the
// same view-vs-act split used for Payments and Capture Inbox.
deductionsRouter.patch("/:id/deducted", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN" && !(await isCompensationFinanceSection(req.user!.sectionId))) {
      throw forbidden("Only Finance can record a deduction");
    }
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
