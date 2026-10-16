import { badRequest, forbidden } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { canApproveStep, getPendingGroup, type ChainStep } from "../../lib/workflowEngine.js";

export type ClaimStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "MANAGER_APPROVED"
  | "EXCO_APPROVED"
  | "HR_OFFICER"
  | "FINANCE_VERIFIED"
  | "PAYMENT_PROCESSING"
  | "SETTLED"
  | "CLOSED"
  | "REJECTED"
  // Trip-completion clearance outcomes (new, additive - see
  // ensureClearanceOutcomeSchema in bootstrap/system.ts). Reached only via
  // the chain-completion branch in advanceClaimWorkflowStep below; the
  // legacy SETTLED/PAYMENT_PROCESSING/CLOSED values above are left in place
  // for history and are never produced for a claim that reaches this branch.
  | "REFUND_DUE"
  | "PAYBACK_DUE"
  | "PAYBACK_PROOF_SUBMITTED"
  | "PAYBACK_PROOF_REJECTED"
  | "FINANCE_TREASURY_REVIEW"
  | "COMPLETED"
  // Voided outright - distinct from REJECTED (a step's decision during
  // active approval) and from DRAFT (rollback, still re-submittable as-is).
  // See claims.routes.ts's POST /:id/cancel.
  | "CANCELLED";

// Permanent once set at chain completion - never changes again, so reports
// retain the original settlement direction even after the claim is later
// FULLY_CLEARED/COMPLETED.
export type FinancialOutcome = "BALANCED" | "REFUND_DUE" | "PAYBACK_DUE";

// The employee-facing "am I done" signal - distinct from `status` (workflow
// stage) and `financial_outcome` (which direction the money moved, if any).
export type EmployeeClearanceStatus = "NOT_CLEARED" | "CLEARANCE_PENDING" | "FULLY_CLEARED";

// clearanceBalance = verifiedExpenseAmount - approvedAdvanceAmount, but this
// codebase's existing balance_amount column (claim_total vs advance_amount,
// already frozen from submission onward - see PUT /:id and PUT /:id/trips,
// both DRAFT-only) is computed the other way around: advanceAmount -
// claimTotal, so a POSITIVE balance_amount already means "employee spent
// less than the advance" (payback owed) and a NEGATIVE one means "employee
// spent more" (refund owed) - the exact convention deductions.routes.ts /
// refundable.routes.ts already rely on. Reuse it as-is rather than
// introducing an inverted duplicate field. Values are already rounded to
// cents via Number(x.toFixed(2)) at write time (the pattern used throughout
// claims.routes.ts), so a plain numeric comparison is safe here - no epsilon
// needed.
export function computeFinancialOutcome(balanceAmount: number): FinancialOutcome {
  if (balanceAmount === 0) return "BALANCED";
  return balanceAmount > 0 ? "PAYBACK_DUE" : "REFUND_DUE";
}

export type ClaimAction =
  | "MANAGER_APPROVE"
  | "EXCO_APPROVE"
  | "HR_OFFICER_APPROVE"
  | "FINANCE_VERIFY"
  | "SETTLE"
  | "MARK_SETTLED";

// Finance's decision at FINANCE_VERIFIED, made via POST /:id/settle.
// "RETURN_FOR_CORRECTION" isn't handled here — it reuses the rollback-to-DRAFT
// flow instead, since it isn't a forward status transition.
export type FinanceDecision = "ACCEPTED" | "REFUND_FROM_EMPLOYEE" | "REIMBURSE_EMPLOYEE";

export function nextStatusForFinanceDecision(decision: FinanceDecision): ClaimStatus {
  return decision === "ACCEPTED" ? "CLOSED" : "PAYMENT_PROCESSING";
}

export function nextClaimStatus(current: ClaimStatus, action: ClaimAction) {
  const map: Record<ClaimStatus, Partial<Record<ClaimAction, ClaimStatus>>> = {
    DRAFT: {},
    SUBMITTED: { MANAGER_APPROVE: "MANAGER_APPROVED" },
    MANAGER_APPROVED: { EXCO_APPROVE: "EXCO_APPROVED" },
    EXCO_APPROVED: { HR_OFFICER_APPROVE: "HR_OFFICER" },
    HR_OFFICER: { FINANCE_VERIFY: "FINANCE_VERIFIED" },
    FINANCE_VERIFIED: { SETTLE: "SETTLED" },
    PAYMENT_PROCESSING: { MARK_SETTLED: "CLOSED" },
    // New trip-completion outcome statuses are never reached via this legacy
    // fallback map — they're only ever produced/advanced by
    // advanceClaimWorkflowStep's chain-completion branch and the dedicated
    // payback-proof/treasury routes, which write status directly rather than
    // going through nextClaimStatus.
    REFUND_DUE: {},
    PAYBACK_DUE: {},
    PAYBACK_PROOF_SUBMITTED: {},
    PAYBACK_PROOF_REJECTED: {},
    FINANCE_TREASURY_REVIEW: {},
    COMPLETED: {},
    CANCELLED: {},
    SETTLED: {},
    CLOSED: {},
    REJECTED: {}
  };
  const next = map[current]?.[action];
  if (!next) throw badRequest(`Invalid transition: ${current} -> ${action}`);
  return next;
}

// Maps a workflow chain step index to the corresponding clearance_claims.status.
// Index 0..4 walk through the existing ClaimStatus progression so the legacy
// statuses keep working regardless of how many approval steps the configured
// workflow has. Once every chain step has approved, the claim is CLOSED
// directly — the configured workflow is the entire approval process; there's
// no implicit HR/Finance settlement step tacked on afterwards. A clearance
// type that actually needs Finance settlement should put a FINANCE step in
// its workflow rather than relying on this fallback.
const CLAIM_STATUS_PROGRESSION: ClaimStatus[] = [
  "SUBMITTED",
  "MANAGER_APPROVED",
  "EXCO_APPROVED",
  "HR_OFFICER",
  "FINANCE_VERIFIED"
];

export function chainStepToClaimStatus(chain: ChainStep[], stepIndex: number): ClaimStatus {
  if (stepIndex >= chain.length) return "CLOSED";
  return CLAIM_STATUS_PROGRESSION[stepIndex] ?? "CLOSED";
}

export async function getClaimById(id: string) {
  const rows = await query<{
    id: string;
    claimant_id: string;
    status: ClaimStatus;
    claim_total: string;
    balance_amount: string;
    reason_for_overspend: string | null;
    linked_advance_id: string | null;
    workflow_id: string | null;
    workflow_step_order: number | null;
    approval_chain: ChainStep[] | null;
    claimant_department: string | null;
    claimant_division: string | null;
    claimant_section: string | null;
    claimant_team: string | null;
    claimant_role: string | null;
  }>(
    `SELECT c.id, c.claimant_id, c.status, c.claim_total, c.balance_amount, c.reason_for_overspend, c.linked_advance_id,
            c.workflow_id, c.workflow_step_order, c.approval_chain,
            u.department AS claimant_department,
            dv.name AS claimant_division,
            s.name AS claimant_section,
            t.name AS claimant_team,
            u.role AS claimant_role
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE c.id=$1`,
    [id]
  );
  return rows[0] ?? null;
}

// Steps that never hold a clearance up: "View" (DEPT_REPORTS, read-only FYI)
// and HR Operations' close step (DEPT_CLOSE). A clearance closes as soon as
// its approvers (Manager/HOD/EXCO...) have approved; the DEPT_CLOSE step stays
// in the chain only to say who reviews a payback proof / refund afterwards.
const NON_BLOCKING_CLAIM_STEPS = new Set(["DEPT_REPORTS", "DEPT_CLOSE"]);
export function isNonBlockingClaimStep(step: { action_type?: string | null }) {
  return NON_BLOCKING_CLAIM_STEPS.has(String(step.action_type || ""));
}

// Who gets read-only access to a closed clearance, by the claimant's company:
// MNO and HigherLife -> HR Operations and Treasury & Financial Accounting;
// SEFS -> Finance Operations. Added to the chain as "View" steps when it
// finishes (so the inbox's view-only list and canViewClaim pick them up).
export function clearanceViewerGroups(company: string | null | undefined): string[] {
  return String(company || "").toUpperCase() === "SEFS"
    ? ["Department: Finance Operations"]
    : ["Section: Human Resources Operations", "Section: Treasury & Financial Accounting"];
}
export function withClearanceViewSteps(chain: ChainStep[], company: string | null | undefined): ChainStep[] {
  const existing = new Set(chain.filter((s) => s.action_type === "DEPT_REPORTS").map((s) => s.approval_group_name));
  let order = Math.max(0, ...chain.map((s) => Number(s.step_order) || 0));
  const added = clearanceViewerGroups(company)
    .filter((g) => !existing.has(g))
    .map((g) => ({
      step_order: ++order,
      action_type: "DEPT_REPORTS",
      position_name: g,
      approval_group_name: g,
      approval_mode: "ANY_ONE",
      approver_id: null,
      approver_ids: [],
      approvers: [],
      approver_name: null,
      approver_email: null,
      approver_title: null,
      required: false,
      can_reject: false,
      can_rollback: false,
      final_approval: false,
      parallel_with_previous: true,
      assigned_user_id: null
    }) as unknown as ChainStep);
  return [...chain, ...added];
}

// What a clearance becomes once its approvers are done. Balanced -> closed
// (COMPLETED, nothing left for Treasury); refund/payback -> the existing
// settlement steps, unchanged.
export function claimOutcomeAfterApproval(balanceAmount: number) {
  const financialOutcome = computeFinancialOutcome(balanceAmount);
  if (financialOutcome === "BALANCED") {
    return { financialOutcome, employeeClearanceStatus: "FULLY_CLEARED" as EmployeeClearanceStatus, treasurySettlementStatus: "NOT_REQUIRED" as const, nextStatus: "COMPLETED" as ClaimStatus };
  }
  return {
    financialOutcome,
    employeeClearanceStatus: "CLEARANCE_PENDING" as EmployeeClearanceStatus,
    treasurySettlementStatus: "PENDING" as const,
    nextStatus: (financialOutcome === "REFUND_DUE" ? "REFUND_DUE" : "PAYBACK_DUE") as ClaimStatus
  };
}

// Advances a workflow-driven clearance claim to its next chain step. Mirrors
// advanceWorkflowStep (advances.service.ts) for clearance_claims.
export async function advanceClaimWorkflowStep(args: {
  claim: NonNullable<Awaited<ReturnType<typeof getClaimById>>>;
  userId: string;
  role: string;
  delegatedManagerIds?: string[] | null;
  userSectionId?: string | null;
}): Promise<{
  nextStatus: ClaimStatus;
  newStepOrder: number;
  hasMore: boolean;
  currentStep: ChainStep;
  stillPending: boolean;
  nextApprover: { id: string | null; name: string | null; email: string | null; title: string | null } | null;
  nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }>;
  financialOutcome: FinancialOutcome | null;
}> {
  const { claim, userId, role, delegatedManagerIds, userSectionId } = args;
  if (!claim.approval_chain?.length) throw badRequest("This clearance does not have an active approval workflow.");

  // Re-reads the row locked (SELECT ... FOR UPDATE) inside a transaction
  // rather than trusting the possibly-stale `claim` passed in — mirrors the
  // fix applied to advanceWorkflowStep (advances.service.ts) for the same
  // concurrent-approver race. Also re-checks status: a REJECTED claim's
  // workflow_step_order/approval_chain are left untouched by reject (see
  // performClaimReject), so without this check the same or another eligible
  // approver could still call approve and walk a rejected claim to CLOSED.
  return withTransaction(async (client) => {
    const lockedRows = await client.query<{ status: ClaimStatus; workflow_step_order: number | null; approval_chain: ChainStep[] | null; balance_amount: string; company: string | null }>(
      `SELECT c.status, c.workflow_step_order, c.approval_chain, c.balance_amount,
              (SELECT dv.name FROM users u LEFT JOIN divisions dv ON dv.id = u.division_id WHERE u.id = c.claimant_id) AS company
         FROM clearance_claims c WHERE c.id=$1 FOR UPDATE OF c`,
      [claim.id]
    );
    const locked = lockedRows.rows[0];
    if (!locked?.approval_chain?.length) throw badRequest("This clearance does not have an active approval workflow.");
    if (locked.status === "REJECTED") throw badRequest("This claim has been rejected and can no longer be approved");

    const chain = locked.approval_chain as ChainStep[];
    const stepIdx = locked.workflow_step_order ?? 0;
    if (stepIdx >= chain.length) throw badRequest("All workflow steps have been completed");

    const group = getPendingGroup(chain, stepIdx);

    // ADMIN bypass: can stand in for whichever member of the stage is next
    // pending (skipping the canApproveStep eligibility check), but still
    // only that ONE step - never the rest of the parallel stage. Approving
    // the whole stage in one ADMIN click used to silently mark a sibling
    // step as done with nobody actually assigned to it having acted - a
    // real incident, not a hypothetical (see the identical fix in
    // advances.service.ts's advanceWorkflowStep).
    let actedIdx: number | null = null;
    if (role === "ADMIN") {
      actedIdx = group.indices.find((idx) => !chain[idx].approved) ?? group.indices[0];
    } else {
      for (const idx of group.indices) {
        if (chain[idx].approved) continue;
        if (await canApproveStep(chain[idx], userId, role, delegatedManagerIds, userSectionId)) { actedIdx = idx; break; }
      }
    }
    if (actedIdx == null) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);

    const currentStep = chain[actedIdx];
    const actedAt = new Date().toISOString();
    const newChain = chain.map((s, i) => (i === actedIdx ? { ...s, approved: true, approved_at: actedAt } : s));

    // DEPT_REPORTS ("View") never blocks the chain - a read-only FYI step
    // (see inbox.routes.ts's loadClaimsForUser), not a decision anyone needs
    // to make. It just stays unapproved forever, same treatment as
    // DEPT_ACCOMODATION gets in advances.service.ts's own advanceWorkflowStep.
    const stillPending = group.indices.some((idx) => !isNonBlockingClaimStep(chain[idx]) && !newChain[idx].approved);
    let nextStatus: ClaimStatus;
    let newStepOrder: number;
    let hasMore: boolean;
    let nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }> = [];
    // Set only when the chain just finished (the branch below fires) - the
    // trip-completion clearance outcome, computed once from the already-
    // frozen balance_amount and never recomputed again.
    let financialOutcome: FinancialOutcome | null = null;
    let employeeClearanceStatus: EmployeeClearanceStatus | null = null;
    let treasurySettlementStatus: "NOT_REQUIRED" | "PENDING" | null = null;

    if (stillPending) {
      nextStatus = locked.status;
      newStepOrder = stepIdx;
      hasMore = true;
    } else {
      let nextIdx = group.indices[group.indices.length - 1] + 1;
      // Skip over steps that don't hold a clearance up (View, HR close).
      while (nextIdx < newChain.length && isNonBlockingClaimStep(newChain[nextIdx])) nextIdx++;
      hasMore = nextIdx < newChain.length;
      newStepOrder = hasMore ? nextIdx : newChain.length;
      if (hasMore) {
        nextStatus = chainStepToClaimStatus(newChain, nextIdx);
        // Each step in the pending stage can now have more than one assigned
        // person — expand to one notification target per person so everyone
        // who can act on it is told, not just the first.
        nextApprovers = getPendingGroup(newChain, nextIdx).steps.flatMap((s) =>
          s.approvers?.length
            ? s.approvers.map((a) => ({ id: a.id, name: a.name, email: a.email, title: a.title || s.position_name }))
            : s.approver_id
            ? [{ id: s.approver_id, name: s.approver_name, email: s.approver_email, title: s.approver_title || s.position_name }]
            : []
        );
      } else {
        // The chain just finished — this is the new trip-completion outcome
        // branch. Never CLOSED directly any more: compute the financial
        // outcome and route onward instead (see computeFinancialOutcome's
        // doc comment for the balance_amount sign convention).
        // Approvers are done: balanced trips close here (no HR close, no
        // Treasury review); refunds/paybacks go to their settlement steps.
        const outcome = claimOutcomeAfterApproval(Number(locked.balance_amount));
        financialOutcome = outcome.financialOutcome;
        employeeClearanceStatus = outcome.employeeClearanceStatus;
        treasurySettlementStatus = outcome.treasurySettlementStatus;
        nextStatus = outcome.nextStatus;
      }
    }

    // closed_at is stamped for every terminal-ish outcome status below, same
    // as it always was for the old unconditional CLOSED — kept as a single
    // "when did this claim stop being purely a pending approval" marker.
    // Chain finished: give HR/Treasury (MNO, HigherLife) or Finance Operations
    // (SEFS) read-only access, and park the step pointer past the end.
    let finalChain = newChain;
    if (financialOutcome !== null) {
      finalChain = withClearanceViewSteps(newChain, locked.company);
      newStepOrder = finalChain.length;
    }
    const stampClosedAt = nextStatus === "CLOSED" || financialOutcome !== null;
    await client.query(
      `UPDATE clearance_claims SET status=$2, workflow_step_order=$3, approval_chain=$4,
         closed_at=CASE WHEN $5 THEN now() ELSE closed_at END,
         financial_outcome=COALESCE($6, financial_outcome),
         employee_clearance_status=COALESCE($7, employee_clearance_status),
         treasury_settlement_status=COALESCE($8, treasury_settlement_status),
         treasury_completed_at=CASE WHEN $9 THEN now() ELSE treasury_completed_at END,
         updated_at=now()
       WHERE id=$1`,
      [claim.id, nextStatus, newStepOrder, JSON.stringify(finalChain), stampClosedAt, financialOutcome, employeeClearanceStatus, treasurySettlementStatus, nextStatus === "COMPLETED"]
    );

    const nextApprover = nextApprovers[0] ?? null;

    return { nextStatus, newStepOrder, hasMore, currentStep, stillPending, nextApprover, nextApprovers, financialOutcome };
  });
}

// One-off catch-up for clearances that were already waiting when the
// "close once the approvers have approved" rule came in:
//  - still in the approval chain but with only non-blocking steps (HR close /
//    View) left -> finish them exactly as the last approval now would;
//  - balanced ones parked in FINANCE_TREASURY_REVIEW -> close (COMPLETED).
// Refunds/paybacks already in their settlement steps are left alone. Each
// change is audit-logged. dryRun returns what would change without writing.
export async function autoCloseFinishedClearances(opts: { dryRun: boolean; actorId?: string | null }) {
  const rows = await query<{ id: string; status: ClaimStatus; workflow_step_order: number | null; approval_chain: ChainStep[] | null; balance_amount: string; financial_outcome: string | null; company: string | null; claimant: string | null }>(
    `SELECT c.id, c.status, c.workflow_step_order, c.approval_chain, c.balance_amount, c.financial_outcome,
            dv.name AS company, u.full_name AS claimant
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       LEFT JOIN divisions dv ON dv.id = u.division_id
      WHERE c.approval_chain IS NOT NULL
        AND (c.status IN ('SUBMITTED','MANAGER_APPROVED','EXCO_APPROVED','HR_OFFICER')
             OR (c.status = 'FINANCE_TREASURY_REVIEW' AND c.financial_outcome = 'BALANCED'))`
  );
  const changes: Array<{ id: string; claimant: string | null; company: string | null; from: string; to: string }> = [];
  for (const r of rows) {
    const chain = r.approval_chain as ChainStep[];
    let to: ClaimStatus;
    let outcome: ReturnType<typeof claimOutcomeAfterApproval> | null = null;
    if (r.status === "FINANCE_TREASURY_REVIEW") {
      to = "COMPLETED";
    } else {
      const remaining = chain.slice(r.workflow_step_order ?? 0);
      if (!remaining.length || remaining.some((s) => !isNonBlockingClaimStep(s) && !(s as any).approved)) continue;
      outcome = claimOutcomeAfterApproval(Number(r.balance_amount));
      to = outcome.nextStatus;
    }
    changes.push({ id: r.id, claimant: r.claimant, company: r.company, from: r.status, to });
    if (opts.dryRun) continue;
    const finalChain = withClearanceViewSteps(chain, r.company);
    await withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE clearance_claims SET status=$2, workflow_step_order=$3, approval_chain=$4,
           closed_at=COALESCE(closed_at, now()),
           financial_outcome=COALESCE($5, financial_outcome),
           employee_clearance_status=COALESCE($6, employee_clearance_status),
           treasury_settlement_status=COALESCE($7, treasury_settlement_status),
           treasury_completed_at=CASE WHEN $8 THEN now() ELSE treasury_completed_at END,
           updated_at=now()
         WHERE id=$1 AND status=$9`,
        [r.id, to, finalChain.length, JSON.stringify(finalChain), outcome?.financialOutcome ?? null,
         to === "COMPLETED" ? "FULLY_CLEARED" : (outcome?.employeeClearanceStatus ?? null),
         to === "COMPLETED" ? "NOT_REQUIRED" : (outcome?.treasurySettlementStatus ?? null),
         to === "COMPLETED", r.status]
      );
      if (res.rowCount) {
        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1, 'CLAIM_AUTO_CLOSED', 'CLAIM', $2, $3, $4)`,
          [opts.actorId ?? null, r.id, JSON.stringify({ status: r.status }), JSON.stringify({ status: to, reason: "Clearance closes once the approvers have approved" })]
        );
      }
    });
  }
  return changes;
}
