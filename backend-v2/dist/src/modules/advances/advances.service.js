import { badRequest, forbidden } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { AdvanceTransitions } from "./advances.types.js";
import { canApproveStep, chainStepToStatus } from "../../lib/workflowEngine.js";
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
    const { adv, userId, role, delegatedManagerId, approvedTotal } = args;
    if (!adv.approval_chain?.length)
        throw badRequest("This advance does not have an active approval workflow.");
    const chain = adv.approval_chain;
    const stepIdx = adv.workflow_step_order ?? 0;
    if (stepIdx >= chain.length)
        throw badRequest("All workflow steps have been completed");
    const currentStep = chain[stepIdx];
    if (role !== "ADMIN" && !canApproveStep(currentStep, userId, role, delegatedManagerId)) {
        throw forbidden(`You are not the assigned approver for step: ${currentStep.position_name}`);
    }
    const nextIdx = stepIdx + 1;
    const hasMore = nextIdx < chain.length;
    const nextStatus = hasMore ? chainStepToStatus(chain, nextIdx) : "APPROVED";
    const newStepOrder = hasMore ? nextIdx : chain.length;
    const total = typeof approvedTotal === "number" ? approvedTotal : Number(adv.approved_total || adv.requested_total);
    await query(`UPDATE advance_requests SET status=$2, workflow_step_order=$3, approved_total=$4, updated_at=now() WHERE id=$1`, [adv.id, nextStatus, newStepOrder, total]);
    if (adv.status === "SUBMITTED") {
        await query(`UPDATE advance_requests SET countersigned_at=now() WHERE id=$1 AND countersigned_at IS NULL`, [adv.id]);
    }
    const nextApprover = hasMore
        ? { name: chain[nextIdx].approver_name, email: chain[nextIdx].approver_email, title: chain[nextIdx].approver_title || chain[nextIdx].position_name }
        : null;
    return { nextStatus, newStepOrder, hasMore, currentStep, nextApprover };
}
export async function setAdvanceStatus(id, status, extras) {
    if (typeof extras?.approvedTotal === "number") {
        await query(`UPDATE advance_requests SET status=$2, approved_total=$3, updated_at=now() WHERE id=$1`, [id, status, extras.approvedTotal]);
        return;
    }
    await query(`UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}
