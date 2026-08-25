import type { PoolClient } from "pg";
import { badRequest, forbidden } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { AdvanceAction, AdvanceStatus, AdvanceTransitions } from "./advances.types.js";
import { canApproveStep, chainStepToStatus, getPendingGroup, type ChainStep } from "../../lib/workflowEngine.js";
import { formatPaymentReference } from "../../lib/pdf/pdfHelpers.js";

export function nextStatusOrThrow(current: AdvanceStatus, action: AdvanceAction): AdvanceStatus {
  const next = AdvanceTransitions[current]?.[action];
  if (!next) throw badRequest(`Invalid transition: ${current} -> ${action}`);
  return next;
}

export async function getAdvanceById(id: string) {
  const rows = await query<{
    id: string;
    requester_id: string;
    created_by_id: string;
    status: AdvanceStatus;
    requested_total: string;
    approved_total: string;
    type: string;
    purpose: string | null;
    payment_account: string | null;
    requester_department: string | null;
    requester_section: string | null;
    requester_role: string;
    override_chain: Array<{ label: string; user_id: string; user_name: string }> | null;
    workflow_id: string | null;
    workflow_step_order: number | null;
    approval_chain: ChainStep[] | null;
    currency: string | null;
    extra_cost_amount: string;
    extra_cost_description: string | null;
    travel_rate_kind: string | null;
  }>(
    `SELECT ar.id, ar.requester_id, ar.created_by_id, ar.status, ar.requested_total, ar.approved_total, ar.type, ar.purpose, ar.payment_account,
            ar.override_chain, ar.workflow_id, ar.workflow_step_order, ar.approval_chain,
            ar.extra_cost_amount, ar.extra_cost_description,
            u.department AS requester_department,
            u.role AS requester_role,
            s.name AS requester_section,
            tt.currency,
            tt.rate_kind AS travel_rate_kind
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN travel_types tt ON tt.code = ar.type
      WHERE ar.id=$1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function createAdvance(
  args: {
    requesterId: string;
    createdById: string;
    type: string;
    purpose?: string | null;
    project_number?: string | null;
    payment_method: "ECOCASH" | "BANK";
    payment_account?: string | null;
    requested_total: number;
    payback_months?: number | null;
    override_chain?: Array<{ label: string; user_id: string; user_name: string }> | null;
    // Extra cost (e.g. ticket/visa/baggage fee) on top of the day-by-day
    // rows total, for travel types flagged has_extra_costs.
    extra_cost_amount?: number | null;
    extra_cost_description?: string | null;
  },
  client?: PoolClient
) {
  const sql = `INSERT INTO advance_requests
      (requester_id, created_by_id, type, purpose, project_number, payment_method, payment_account, requested_total, payback_months, override_chain, extra_cost_amount, extra_cost_description, sequence_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, nextval('advance_request_seq'))
     RETURNING id`;
  const params = [
    args.requesterId,
    args.createdById,
    args.type,
    args.purpose ?? null,
    args.project_number ?? null,
    args.payment_method,
    args.payment_account ?? null,
    args.requested_total,
    args.payback_months ?? null,
    args.override_chain?.length ? JSON.stringify(args.override_chain) : null,
    args.extra_cost_amount ?? 0,
    args.extra_cost_description ?? null
  ];
  const rows = client ? (await client.query<{ id: string }>(sql, params)).rows : await query<{ id: string }>(sql, params);

  return rows[0].id;
}

// Advances a workflow-driven advance to its next chain step. Shared between the
// generic /approve action and other actions that also need to move the chain
// forward (e.g. HR sending an accommodation booking on to Finance).
export async function advanceWorkflowStep(args: {
  adv: NonNullable<Awaited<ReturnType<typeof getAdvanceById>>>;
  userId: string;
  role: string;
  delegatedManagerIds?: string[] | null;
  userSectionId?: string | null;
  approvedTotal?: number;
}): Promise<{
  nextStatus: AdvanceStatus;
  newStepOrder: number;
  hasMore: boolean;
  currentStep: ChainStep;
  stillPending: boolean;
  nextApprover: { id: string | null; name: string | null; email: string | null; title: string | null } | null;
  nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }>;
}> {
  const { adv, userId, role, delegatedManagerIds, userSectionId, approvedTotal } = args;
  if (!adv.approval_chain?.length) throw badRequest("This advance does not have an active approval workflow.");

  // Re-reads the row locked (SELECT ... FOR UPDATE) inside a transaction
  // rather than trusting the possibly-stale `adv` passed in — two concurrent
  // approvers acting on the same parallel stage previously raced on this
  // read-modify-write and could silently drop each other's "approved" flag,
  // since workflow_step_order doesn't change until the whole stage is done
  // (so a plain optimistic WHERE guard on it wouldn't catch that case).
  return withTransaction(async (client) => {
    const lockedRows = await client.query<{ status: AdvanceStatus; workflow_step_order: number | null; approval_chain: ChainStep[] | null; approved_total: string }>(
      `SELECT status, workflow_step_order, approval_chain, approved_total FROM advance_requests WHERE id=$1 FOR UPDATE`,
      [adv.id]
    );
    const locked = lockedRows.rows[0];
    if (!locked?.approval_chain?.length) throw badRequest("This advance does not have an active approval workflow.");

    const chain = locked.approval_chain as ChainStep[];
    const stepIdx = locked.workflow_step_order ?? 0;
    if (stepIdx >= chain.length) throw badRequest("All workflow steps have been completed");

    const group = getPendingGroup(chain, stepIdx);

    // Find which pending member of the current stage this user is acting on.
    // ADMIN bypass: approve every still-pending member of the stage at once.
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
    if (role === "ADMIN") {
      for (const idx of group.indices) newChain[idx] = { ...newChain[idx], approved: true, approved_at: actedAt };
    }

    const stillPending = group.indices.some((idx) => !newChain[idx].approved);
    let nextStatus: AdvanceStatus;
    let newStepOrder: number;
    let hasMore: boolean;
    let nextApprovers: Array<{ id: string | null; name: string | null; email: string | null; title: string | null }> = [];

    if (stillPending) {
      nextStatus = locked.status;
      newStepOrder = stepIdx;
      hasMore = true;
    } else {
      const nextIdx = group.indices[group.indices.length - 1] + 1;
      const nextStep = nextIdx < newChain.length ? newChain[nextIdx] : null;
      if (nextStep?.action_type === "MARK_PAID") {
        // A dedicated MARK_PAID step follows — stop chain here at APPROVED.
        // The payment step's team will use the "Mark Advance Paid" button.
        hasMore = false;
        nextStatus = "APPROVED";
        newStepOrder = nextIdx;
      } else {
        hasMore = nextIdx < newChain.length;
        nextStatus = hasMore ? chainStepToStatus(newChain, nextIdx) : "APPROVED";
        newStepOrder = hasMore ? nextIdx : newChain.length;
        // No explicit MARK_PAID step — completing the final approval step also
        // marks the advance as paid in the same action.
        if (!hasMore) {
          nextStatus = "PAID";
        }
        if (hasMore) {
          // Each step in the pending stage can now have more than one
          // assigned person — expand to one notification target per person
          // so everyone who can act on it is told, not just the first.
          nextApprovers = getPendingGroup(newChain, nextIdx).steps.flatMap((s) =>
            s.approvers?.length
              ? s.approvers.map((a) => ({ id: a.id, name: a.name, email: a.email, title: a.title || s.position_name }))
              : s.approver_id
              ? [{ id: s.approver_id, name: s.approver_name, email: s.approver_email, title: s.approver_title || s.position_name }]
              : []
          );
        }
      }
    }

    const total = typeof approvedTotal === "number" ? approvedTotal : Number(locked.approved_total || adv.requested_total);

    // Completing the chain here (no explicit MARK_PAID step) skips the
    // /mark-paid endpoint entirely, so this is the only place that would
    // ever generate a payment reference / paid_at for these advances.
    let paidReference: string | null = null;
    if (nextStatus === "PAID") {
      const seqRows = await client.query<{ seq: string }>(`SELECT nextval('payment_ref_seq') AS seq`);
      paidReference = formatPaymentReference(Number(seqRows.rows[0].seq));
    }

    await client.query(
      `UPDATE advance_requests SET status=$2, workflow_step_order=$3, approved_total=$4, approval_chain=$5,
              paid_reference = COALESCE($6, paid_reference),
              paid_at = CASE WHEN $7 THEN now() ELSE paid_at END,
              updated_at=now()
         WHERE id=$1`,
      [adv.id, nextStatus, newStepOrder, total, JSON.stringify(newChain), paidReference, nextStatus === "PAID"]
    );
    if (locked.status === "SUBMITTED") {
      await client.query(`UPDATE advance_requests SET countersigned_at=now() WHERE id=$1 AND countersigned_at IS NULL`, [adv.id]);
    }
    // Final-approval timestamp — read by the SLA report, the PDF, and
    // Deductions' VR Date, but previously never written anywhere.
    if (nextStatus === "APPROVED" || nextStatus === "PAID") {
      await client.query(`UPDATE advance_requests SET approved_at=now() WHERE id=$1 AND approved_at IS NULL`, [adv.id]);
    }

    const nextApprover = nextApprovers[0] ?? null;

    return { nextStatus, newStepOrder, hasMore, currentStep, stillPending, nextApprover, nextApprovers };
  });
}

export async function setAdvanceStatus(id: string, status: AdvanceStatus, extras?: { approvedTotal?: number }) {
  if (typeof extras?.approvedTotal === "number") {
    await query(`UPDATE advance_requests SET status=$2, approved_total=$3, updated_at=now() WHERE id=$1`, [id, status, extras.approvedTotal]);
    return;
  }
  await query(`UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}
