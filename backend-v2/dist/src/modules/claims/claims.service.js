import { badRequest, forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canApproveStep } from "../../lib/workflowEngine.js";
export function nextClaimStatus(current, action) {
    const map = {
        DRAFT: {},
        SUBMITTED: { MANAGER_APPROVE: "MANAGER_APPROVED" },
        MANAGER_APPROVED: { CHIEF_APPROVE: "CHIEF_OFFICER_APPROVED" },
        CHIEF_OFFICER_APPROVED: { AUTH_OFFICER_APPROVE: "HR_OFFICER" },
        HR_OFFICER: { HR_MANAGER_APPROVE: "HR_MANAGER_REVIEW" },
        HR_MANAGER_REVIEW: { FINANCE_VERIFY: "FINANCE_VERIFIED" },
        FINANCE_VERIFIED: { SETTLE: "SETTLED" },
        SETTLED: {},
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
    const { claim, userId, role, delegatedManagerId } = args;
    if (!claim.approval_chain?.length)
        throw badRequest("This clearance does not have an active approval workflow.");
    const chain = claim.approval_chain;
    const stepIdx = claim.workflow_step_order ?? 0;
    if (stepIdx >= chain.length)
        throw badRequest("All workflow steps have been completed");
    const currentStep = chain[stepIdx];
    if (role !== "ADMIN" && !canApproveStep(currentStep, userId, role, delegatedManagerId)) {
        throw forbidden(`You are not the assigned approver for step: ${currentStep.position_name}`);
    }
    const nextIdx = stepIdx + 1;
    const hasMore = nextIdx < chain.length;
    const nextStatus = chainStepToClaimStatus(chain, nextIdx);
    const newStepOrder = hasMore ? nextIdx : chain.length;
    await query(`UPDATE clearance_claims SET status=$2, workflow_step_order=$3, updated_at=now() WHERE id=$1`, [claim.id, nextStatus, newStepOrder]);
    const nextApprover = hasMore
        ? { name: chain[nextIdx].approver_name, email: chain[nextIdx].approver_email, title: chain[nextIdx].approver_title || chain[nextIdx].position_name }
        : null;
    return { nextStatus, newStepOrder, hasMore, currentStep, nextApprover };
}
