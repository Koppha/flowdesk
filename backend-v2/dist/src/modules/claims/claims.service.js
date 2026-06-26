import { badRequest, forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canApproveStep, getPendingGroup } from "../../lib/workflowEngine.js";
export function nextStatusForFinanceDecision(decision) {
    return decision === "ACCEPTED" ? "CLOSED" : "PAYMENT_PROCESSING";
}
export function nextClaimStatus(current, action) {
    const map = {
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
    if (!next)
        throw badRequest(`Invalid transition: ${current} -> ${action}`);
    return next;
}
// Maps a workflow chain step index to the corresponding clearance_claims.status.
// Index 0..4 walk through the existing ClaimStatus progression so the legacy
// statuses (and the FINANCE settle step) keep working regardless of how many
// approval steps the configured workflow has. Once every chain step has
// approved, the claim becomes FINANCE_VERIFIED and is ready for /settle.
const CLAIM_STATUS_PROGRESSION = [
    "SUBMITTED",
    "MANAGER_APPROVED",
    "CHIEF_OFFICER_APPROVED",
    "HR_OFFICER",
    "HR_MANAGER_REVIEW"
];
export function chainStepToClaimStatus(chain, stepIndex) {
    if (stepIndex >= chain.length)
        return "FINANCE_VERIFIED";
    return CLAIM_STATUS_PROGRESSION[stepIndex] ?? "FINANCE_VERIFIED";
}
export async function getClaimById(id) {
    const rows = await query(`SELECT c.id, c.claimant_id, c.status, c.claim_total, c.linked_advance_id,
            c.workflow_id, c.workflow_step_order, c.approval_chain,
            u.department AS claimant_department,
            s.name AS claimant_section
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       LEFT JOIN sections s ON s.id = u.section_id
      WHERE c.id=$1`, [id]);
    return rows[0] ?? null;
}
// Advances a workflow-driven clearance claim to its next chain step. Mirrors
// advanceWorkflowStep (advances.service.ts) for clearance_claims.
export async function advanceClaimWorkflowStep(args) {
    const { claim, userId, role, delegatedManagerId, userDepartment } = args;
    if (!claim.approval_chain?.length)
        throw badRequest("This clearance does not have an active approval workflow.");
    const chain = claim.approval_chain;
    const stepIdx = claim.workflow_step_order ?? 0;
    if (stepIdx >= chain.length)
        throw badRequest("All workflow steps have been completed");
    const group = getPendingGroup(chain, stepIdx);
    let actedIdx = null;
    if (role === "ADMIN") {
        actedIdx = group.indices.find((idx) => !chain[idx].approved) ?? group.indices[0];
    }
    else {
        for (const idx of group.indices) {
            if (chain[idx].approved)
                continue;
            if (await canApproveStep(chain[idx], userId, role, delegatedManagerId, userDepartment)) {
                actedIdx = idx;
                break;
            }
        }
    }
    if (actedIdx == null)
        throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
    const currentStep = chain[actedIdx];
    const newChain = chain.map((s, i) => (i === actedIdx ? { ...s, approved: true } : s));
    if (role === "ADMIN") {
        for (const idx of group.indices)
            newChain[idx] = { ...newChain[idx], approved: true };
    }
    const stillPending = group.indices.some((idx) => !newChain[idx].approved);
    let nextStatus;
    let newStepOrder;
    let hasMore;
    let nextApprovers = [];
    if (stillPending) {
        nextStatus = claim.status;
        newStepOrder = stepIdx;
        hasMore = true;
    }
    else {
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
    await query(`UPDATE clearance_claims SET status=$2, workflow_step_order=$3, approval_chain=$4, updated_at=now() WHERE id=$1`, [claim.id, nextStatus, newStepOrder, JSON.stringify(newChain)]);
    const nextApprover = nextApprovers[0] ?? null;
    return { nextStatus, newStepOrder, hasMore, currentStep, stillPending, nextApprover, nextApprovers };
}
