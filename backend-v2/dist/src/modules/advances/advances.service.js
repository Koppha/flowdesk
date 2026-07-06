import { badRequest, forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { AdvanceTransitions } from "./advances.types.js";
import { canApproveStep, chainStepToStatus, getPendingGroup } from "../../lib/workflowEngine.js";
export function nextStatusOrThrow(current, action) {
    const next = AdvanceTransitions[current]?.[action];
    if (!next)
        throw badRequest(`Invalid transition: ${current} -> ${action}`);
    return next;
}
export async function getAdvanceById(id) {
    const rows = await query(`SELECT ar.id, ar.requester_id, ar.created_by_id, ar.status, ar.requested_total, ar.approved_total, ar.type, ar.purpose, ar.payment_account,
            ar.override_chain, ar.workflow_id, ar.workflow_step_order, ar.approval_chain,
            u.department AS requester_department,
            s.name AS requester_section
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       LEFT JOIN sections s ON s.id = u.section_id
      WHERE ar.id=$1`, [id]);
    return rows[0] ?? null;
}
export async function createAdvance(args) {
    const rows = await query(`INSERT INTO advance_requests
      (requester_id, created_by_id, type, purpose, project_number, payment_method, payment_account, requested_total, override_chain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`, [
        args.requesterId,
        args.createdById,
        args.type,
        args.purpose ?? null,
        args.project_number ?? null,
        args.payment_method,
        args.payment_account ?? null,
        args.requested_total,
        args.override_chain?.length ? JSON.stringify(args.override_chain) : null
    ]);
    return rows[0].id;
}
// Advances a workflow-driven advance to its next chain step. Shared between the
// generic /approve action and other actions that also need to move the chain
// forward (e.g. HR sending an accommodation booking on to Finance).
export async function advanceWorkflowStep(args) {
    const { adv, userId, role, delegatedManagerId, userDepartment, approvedTotal } = args;
    if (!adv.approval_chain?.length)
        throw badRequest("This advance does not have an active approval workflow.");
    const chain = adv.approval_chain;
    const stepIdx = adv.workflow_step_order ?? 0;
    if (stepIdx >= chain.length)
        throw badRequest("All workflow steps have been completed");
    const group = getPendingGroup(chain, stepIdx);
    // Find which pending member of the current stage this user is acting on.
    // ADMIN bypass: approve every still-pending member of the stage at once.
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
    const actedAt = new Date().toISOString();
    const newChain = chain.map((s, i) => (i === actedIdx ? { ...s, approved: true, approved_at: actedAt } : s));
    if (role === "ADMIN") {
        for (const idx of group.indices)
            newChain[idx] = { ...newChain[idx], approved: true, approved_at: actedAt };
    }
    const stillPending = group.indices.some((idx) => !newChain[idx].approved);
    let nextStatus;
    let newStepOrder;
    let hasMore;
    let nextApprovers = [];
    if (stillPending) {
        nextStatus = adv.status;
        newStepOrder = stepIdx;
        hasMore = true;
    }
    else {
        const nextIdx = group.indices[group.indices.length - 1] + 1;
        const nextStep = nextIdx < newChain.length ? newChain[nextIdx] : null;
        if (nextStep?.action_type === "MARK_PAID") {
            // A dedicated MARK_PAID step follows — stop chain here at APPROVED.
            // The payment step's team will use the "Mark Advance Paid" button.
            hasMore = false;
            nextStatus = "APPROVED";
            newStepOrder = nextIdx;
        }
        else {
            hasMore = nextIdx < newChain.length;
            nextStatus = hasMore ? chainStepToStatus(newChain, nextIdx) : "APPROVED";
            newStepOrder = hasMore ? nextIdx : newChain.length;
            // No explicit MARK_PAID step — completing the final approval step also
            // marks the advance as paid in the same action.
            if (!hasMore) {
                nextStatus = "PAID";
            }
            if (hasMore) {
                nextApprovers = getPendingGroup(newChain, nextIdx).steps.map((s) => ({
                    id: s.approver_id, name: s.approver_name, email: s.approver_email, title: s.approver_title || s.position_name
                }));
            }
        }
    }
    const total = typeof approvedTotal === "number" ? approvedTotal : Number(adv.approved_total || adv.requested_total);
    await query(`UPDATE advance_requests SET status=$2, workflow_step_order=$3, approved_total=$4, approval_chain=$5, updated_at=now() WHERE id=$1`, [adv.id, nextStatus, newStepOrder, total, JSON.stringify(newChain)]);
    if (adv.status === "SUBMITTED") {
        await query(`UPDATE advance_requests SET countersigned_at=now() WHERE id=$1 AND countersigned_at IS NULL`, [adv.id]);
    }
    const nextApprover = nextApprovers[0] ?? null;
    return { nextStatus, newStepOrder, hasMore, currentStep, stillPending, nextApprover, nextApprovers };
}
export async function setAdvanceStatus(id, status, extras) {
    if (typeof extras?.approvedTotal === "number") {
        await query(`UPDATE advance_requests SET status=$2, approved_total=$3, updated_at=now() WHERE id=$1`, [id, status, extras.approvedTotal]);
        return;
    }
    await query(`UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}
