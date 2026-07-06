import { badRequest, forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canApproveStep, getPendingGroup, type ChainStep } from "../../lib/workflowEngine.js";

export type ClaimStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "MANAGER_APPROVED"
  | "CHIEF_OFFICER_APPROVED"
  | "HR_OFFICER"
  | "HR_MANAGER_REVIEW"
  | "FINANCE_VERIFIED"
  | "PAYMENT_PROCESSING"
  | "SETTLED"
  | "CLOSED"
  | "REJECTED";

export type ClaimAction =
  | "MANAGER_APPROVE"
  | "CHIEF_APPROVE"
  | "AUTH_OFFICER_APPROVE"
  | "HR_MANAGER_APPROVE"
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
    MANAGER_APPROVED: { CHIEF_APPROVE: "CHIEF_OFFICER_APPROVED" },
    CHIEF_OFFICER_APPROVED: { AUTH_OFFICER_APPROVE: "HR_OFFICER" },
    HR_OFFICER: { HR_MANAGER_APPROVE: "HR_MANAGER_REVIEW" },
    HR_MANAGER_REVIEW: { FINANCE_VERIFY: "FINANCE_VERIFIED" },
    FINANCE_VERIFIED: { SETTLE: "SETTLED" },
    PAYMENT_PROCESSING: { MARK_SETTLED: "CLOSED" },
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
  "CHIEF_OFFICER_APPROVED",
  "HR_OFFICER",
  "HR_MANAGER_REVIEW"
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
    claimant_section: string | null;
  }>(
    `SELECT c.id, c.claimant_id, c.status, c.claim_total, c.balance_amount, c.reason_for_overspend, c.linked_advance_id,
            c.workflow_id, c.workflow_step_order, c.approval_chain,
            u.department AS claimant_department,
            s.name AS claimant_section
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       LEFT JOIN sections s ON s.id = u.section_id
      WHERE c.id=$1`,
    [id]
  );
  return rows[0] ?? null;
}

// Advances a workflow-driven clearance claim to its next chain step. Mirrors
// advanceWorkflowStep (advances.service.ts) for clearance_claims.
export async function advanceClaimWorkflowStep(args: {
  claim: NonNullable<Awaited<ReturnType<typeof getClaimById>>>;
  userId: string;
  role: string;
  delegatedManagerId?: string | null;
  userDepartment?: string | null;
}): Promise<{
  nextStatus: ClaimStatus;
  newStepOrder: number;
  hasMore: boolean;
  currentStep: ChainStep;
  stillPending: boolean;
  nextApprover: { id: string | null; name: string | null; email: string | null; title: string | null } | null;
  nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }>;
}> {
  const { claim, userId, role, delegatedManagerId, userDepartment } = args;
  if (!claim.approval_chain?.length) throw badRequest("This clearance does not have an active approval workflow.");

  const chain = claim.approval_chain as ChainStep[];
  const stepIdx = claim.workflow_step_order ?? 0;
  if (stepIdx >= chain.length) throw badRequest("All workflow steps have been completed");

  const group = getPendingGroup(chain, stepIdx);

  let actedIdx: number | null = null;
  if (role === "ADMIN") {
    actedIdx = group.indices.find((idx) => !chain[idx].approved) ?? group.indices[0];
  } else {
    for (const idx of group.indices) {
      if (chain[idx].approved) continue;
      if (await canApproveStep(chain[idx], userId, role, delegatedManagerId, userDepartment)) { actedIdx = idx; break; }
    }
  }
  if (actedIdx == null) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);

  const currentStep = chain[actedIdx];
  const newChain = chain.map((s, i) => (i === actedIdx ? { ...s, approved: true } : s));
  if (role === "ADMIN") {
    for (const idx of group.indices) newChain[idx] = { ...newChain[idx], approved: true };
  }

  const stillPending = group.indices.some((idx) => !newChain[idx].approved);
  let nextStatus: ClaimStatus;
  let newStepOrder: number;
  let hasMore: boolean;
  let nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }> = [];

  if (stillPending) {
    nextStatus = claim.status;
    newStepOrder = stepIdx;
    hasMore = true;
  } else {
    const nextIdx = group.indices[group.indices.length - 1] + 1;
    hasMore = nextIdx < newChain.length;
    nextStatus = chainStepToClaimStatus(newChain, nextIdx);
    newStepOrder = hasMore ? nextIdx : newChain.length;
    if (hasMore) {
      nextApprovers = getPendingGroup(newChain, nextIdx).steps.map((s) => ({
        id: s.approver_id, name: s.approver_name, email: s.approver_email, title: s.approver_title || s.position_name
      }));
    }
  }

  await query(
    `UPDATE clearance_claims SET status=$2, workflow_step_order=$3, approval_chain=$4,
       closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE closed_at END, updated_at=now()
     WHERE id=$1`,
    [claim.id, nextStatus, newStepOrder, JSON.stringify(newChain)]
  );

  const nextApprover = nextApprovers[0] ?? null;

  return { nextStatus, newStepOrder, hasMore, currentStep, stillPending, nextApprover, nextApprovers };
}
