import { Router } from "express";
import { isFinanceDept, requireAuth } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";
import { canApproveStep, getPendingGroup } from "../../lib/workflowEngine.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
function allowedInboxForUser(role, department) {
    const base = allowedInboxForRole(role);
    if (!isFinanceDept(department) || role === "FINANCE")
        return base;
    const finance = allowedInboxForRole("FINANCE");
    if (base === "ALL" || finance === "ALL")
        return "ALL";
    const baseArr = base ? (Array.isArray(base) ? base : [base]) : [];
    const financeArr = finance ? (Array.isArray(finance) ? finance : [finance]) : [];
    return [...baseArr, ...financeArr];
}
function allowedInboxForRole(role) {
    switch (role) {
        case "HOD":
            return [
                { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
                { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_OFFICER" },
                { doc_type: "ADVANCE", status: "APPROVED" },
            ];
        case "MANAGER":
            return [
                { doc_type: "ADVANCE", status: "SUBMITTED" },
                { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
                { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_OFFICER" },
                { doc_type: "ADVANCE", status: "APPROVED" },
                { doc_type: "CLAIM", status: "SUBMITTED" },
                { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
                { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
                { doc_type: "CLAIM", status: "HR_OFFICER" },
                { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
                { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
                { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" },
                { doc_type: "OVERTIME_REQUEST", status: "SUBMITTED" },
                { doc_type: "OVERTIME_REQUEST", status: "SUPERVISOR_APPROVED" },
                { doc_type: "OVERTIME_CLAIM", status: "SUBMITTED" }
            ];
        case "HR_MANAGER":
            return [
                { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_OFFICER" },
                { doc_type: "ADVANCE", status: "APPROVED" },
                { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
                { doc_type: "CLAIM", status: "HR_OFFICER" },
                { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
                { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
                { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" },
                { doc_type: "OVERTIME_CLAIM", status: "MANAGER_AUTHORISED" },
                { doc_type: "OVERTIME_CLAIM", status: "FINANCE_VERIFIED" },
                { doc_type: "OVERTIME_CLAIM", status: "EARNINGS_RECORDED" }
            ];
        case "EXCO":
            return [
                { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
                { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
                { doc_type: "CLAIM", status: "HR_OFFICER" },
                { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
                { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
                { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" },
                { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
                { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_REVIEW" },
                { doc_type: "ADVANCE", status: "HR_OFFICER" },
                { doc_type: "ADVANCE", status: "APPROVED" },
                { doc_type: "OVERTIME_REQUEST", status: "HOD_APPROVED" }
            ];
        case "FINANCE":
            return [
                { doc_type: "ADVANCE", status: "HR_OFFICER" },
                { doc_type: "ADVANCE", status: "APPROVED" },
                { doc_type: "ACCOMMODATION", status: "SUBMITTED" },
                { doc_type: "CLAIM", status: "HR_OFFICER" },
                { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
                { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
                { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" },
                { doc_type: "OVERTIME_CLAIM", status: "HR_NOTED" }
            ];
        case "ADMIN":
            return "ALL";
        default:
            return null;
    }
}
export const inboxRouter = Router();
inboxRouter.use(requireAuth);
inboxRouter.get("/my-actions", async (req, res, next) => {
    try {
        const limitRaw = Number(req.query.limit ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
        const rows = await query(`SELECT al.id,
              al.action,
              al.entity_type,
              al.entity_id,
              al.before_json,
              al.after_json,
              al.created_at,
              ar.status AS current_status,
              acc.status AS accommodation_status,
              COALESCE(u.full_name, acc_requester.full_name) AS requester_name
       FROM audit_log al
       LEFT JOIN advance_requests ar
         ON al.entity_type='advance_requests'
        AND ar.id = al.entity_id
       LEFT JOIN users u
         ON u.id = ar.requester_id
       LEFT JOIN accommodation_requests acc
         ON al.entity_type='accommodation_requests'
        AND acc.id = al.entity_id
       LEFT JOIN users acc_requester
         ON acc_requester.id = acc.requester_id
       WHERE al.actor_id = $1
       ORDER BY al.created_at DESC
       LIMIT $2`, [req.user.userId, limit]);
        const items = rows.map((r) => ({
            id: r.id,
            action: r.action,
            doc_type: r.entity_type === "advance_requests" ? "ADVANCE" : r.entity_type,
            entity_id: r.entity_id,
            current_status: r.current_status ?? r.accommodation_status ?? null,
            requester_name: r.requester_name ?? null,
            created_at: r.created_at
        }));
        return res.json({ items });
    }
    catch (err) {
        return next(err);
    }
});
inboxRouter.get("/", async (req, res, next) => {
    try {
        const role = req.user.role;
        const delegation = await getActiveManagerDelegation(req.user.userId);
        const effectiveRole = delegation && role !== "MANAGER" ? "MANAGER" : role;
        const rule = allowedInboxForUser(effectiveRole, req.user.department);
        const items = [];
        // Load workflow-driven advances where it is this user's turn to act. A
        // request's current "stage" (getPendingGroup) may contain multiple steps
        // when they're flagged parallel_with_previous — match if the user can
        // approve any not-yet-approved member of that stage (mirrors canApproveStep,
        // including "Team: X" ANY_ONE group handling).
        const loadWorkflowAdvancesForUser = async () => {
            const rows = await query(`SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.workflow_step_order, ar.approval_chain,
                u.full_name AS requester_name
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status NOT IN ('DRAFT','PAID','REJECTED','CANCELLED','APPROVED')
          ORDER BY ar.created_at DESC`);
            for (const a of rows) {
                const chain = a.approval_chain;
                const group = getPendingGroup(chain, a.workflow_step_order ?? 0);
                let matched;
                for (const step of group.steps) {
                    if (step.approved)
                        continue;
                    if (await canApproveStep(step, req.user.userId, effectiveRole, delegation?.manager_id, req.user.department)) {
                        matched = step;
                        break;
                    }
                }
                if (matched) {
                    items.push({
                        doc_type: "ADVANCE",
                        id: a.id,
                        status: a.status,
                        advance_type: a.type,
                        requested_total: Number(a.requested_total),
                        approved_total: Number(a.approved_total),
                        purpose: a.purpose,
                        requester_name: a.requester_name,
                        workflow_step_order: a.workflow_step_order,
                        current_step_approver_id: matched.approver_id,
                        current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
                        current_step_requires_accommodation: matched.requires_accommodation,
                        current_step_action_type: matched.action_type,
                        current_step_can_reject: matched.can_reject,
                        current_step_can_rollback: matched.can_rollback,
                        current_step_actionable_by_me: true
                    });
                    continue;
                }
                // Not this user's turn — but if they're a member of this workflow's
                // approval chain at a step that has already been reached (past or
                // current, not a future step the request hasn't progressed to yet),
                // surface it as a read-only tracking item so they can follow its
                // progress.
                let isChainParticipant = false;
                const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
                for (let i = 0; i <= maxReachedIdx && i < chain.length; i++) {
                    if (await canApproveStep(chain[i], req.user.userId, effectiveRole, delegation?.manager_id, req.user.department)) {
                        isChainParticipant = true;
                        break;
                    }
                }
                if (!isChainParticipant)
                    continue;
                items.push({
                    doc_type: "ADVANCE",
                    id: a.id,
                    status: a.status,
                    advance_type: a.type,
                    requested_total: Number(a.requested_total),
                    approved_total: Number(a.approved_total),
                    purpose: a.purpose,
                    requester_name: a.requester_name,
                    workflow_step_order: a.workflow_step_order,
                    current_step_approver_id: group.steps[0]?.approver_id ?? null,
                    current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
                    current_step_requires_accommodation: group.steps[0]?.requires_accommodation ?? false,
                    current_step_can_reject: group.steps[0]?.can_reject ?? true,
                    current_step_can_rollback: group.steps[0]?.can_rollback ?? true,
                    current_step_actionable_by_me: false
                });
            }
        };
        // Advances where this user was named as the final ("Finance Officer")
        // approval step and that step has now completed (status APPROVED) — they
        // still need to mark the advance as paid even though their account role
        // may not be FINANCE. ADMIN ("ALL") gets everything via the
        // allWorkflowRows + loadAdvanceByStatus("APPROVED") queries below, so skip
        // it there.
        const loadFinalStepApprovedAdvancesForUser = async (userId) => {
            // Explicit MARK_PAID steps: the workflow designates a specific payer team/person.
            // The step pointed to by workflow_step_order has action_type = 'MARK_PAID'.
            const userGroups = await getUserGroups(userId);
            const markPaidRows = await query(`SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                u.full_name AS requester_name
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status = 'APPROVED'
            AND ar.workflow_step_order IS NOT NULL
            AND (ar.approval_chain->(ar.workflow_step_order::int)->>'action_type') = 'MARK_PAID'
            AND (
              -- SINGLE step: specific named person
              (
                (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_mode') = 'SINGLE'
                AND (ar.approval_chain->(ar.workflow_step_order::int)->>'approver_id') = $1
              )
              OR
              -- ANY_ONE group step: any member of the named group
              (
                (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_mode') = 'ANY_ONE'
                AND (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_group_name') = ANY($2::text[])
              )
            )
          ORDER BY ar.created_at DESC`, [userId, userGroups.length > 0 ? userGroups : [""]]);
            for (const a of markPaidRows) {
                if (items.some((i) => i.id === a.id))
                    continue;
                items.push({
                    doc_type: "ADVANCE",
                    id: a.id,
                    status: a.status,
                    advance_type: a.type,
                    requested_total: Number(a.requested_total),
                    approved_total: Number(a.approved_total),
                    purpose: a.purpose,
                    requester_name: a.requester_name,
                    is_final_step_approver: true
                });
            }
            // Fallback: SINGLE-mode final approval step (no explicit MARK_PAID step).
            // The named person who gave final approval can also mark as paid.
            const singleRows = await query(`SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                u.full_name AS requester_name
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status = 'APPROVED'
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ar.approval_chain) s
              WHERE s->>'action_type' = 'MARK_PAID'
            )
            AND (ar.approval_chain->(jsonb_array_length(ar.approval_chain) - 1)->>'approval_mode') = 'SINGLE'
            AND (ar.approval_chain->(jsonb_array_length(ar.approval_chain) - 1)->>'approver_id') = $1
          ORDER BY ar.created_at DESC`, [userId]);
            for (const a of singleRows) {
                if (items.some((i) => i.id === a.id))
                    continue;
                items.push({
                    doc_type: "ADVANCE",
                    id: a.id,
                    status: a.status,
                    advance_type: a.type,
                    requested_total: Number(a.requested_total),
                    approved_total: Number(a.approved_total),
                    purpose: a.purpose,
                    requester_name: a.requester_name,
                    is_final_step_approver: true
                });
            }
        };
        // Load workflow-driven clearance claims where it is this user's turn to
        // act. Mirrors loadWorkflowAdvancesForUser, but for clearance_claims.
        const loadWorkflowClaimsForUser = async () => {
            const rows = await query(`SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount,
                c.workflow_step_order, c.approval_chain,
                u.full_name AS claimant_name
           FROM clearance_claims c
           JOIN users u ON u.id = c.claimant_id
          WHERE c.approval_chain IS NOT NULL
            AND c.status NOT IN ('DRAFT','SETTLED','CLOSED','REJECTED','FINANCE_VERIFIED','PAYMENT_PROCESSING')
          ORDER BY c.created_at DESC`);
            for (const c of rows) {
                const chain = c.approval_chain;
                const group = getPendingGroup(chain, c.workflow_step_order ?? 0);
                let matched;
                for (const step of group.steps) {
                    if (step.approved)
                        continue;
                    if (await canApproveStep(step, req.user.userId, effectiveRole, delegation?.manager_id, req.user.department)) {
                        matched = step;
                        break;
                    }
                }
                if (matched) {
                    items.push({
                        doc_type: "CLAIM",
                        id: c.id,
                        status: c.status,
                        claim_total: Number(c.claim_total),
                        advance_amount: Number(c.advance_amount),
                        balance_amount: Number(c.balance_amount),
                        claimant_name: c.claimant_name,
                        workflow_step_order: c.workflow_step_order,
                        current_step_approver_id: matched.approver_id,
                        current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
                        current_step_actionable_by_me: true
                    });
                    continue;
                }
                // Not this user's turn — but if they're a member of this workflow's
                // approval chain at a step that has already been reached (past or
                // current, not a future step the request hasn't progressed to yet),
                // surface it as a read-only tracking item so they can follow its
                // progress.
                let isChainParticipant = false;
                const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
                for (let i = 0; i <= maxReachedIdx && i < chain.length; i++) {
                    if (await canApproveStep(chain[i], req.user.userId, effectiveRole, delegation?.manager_id, req.user.department)) {
                        isChainParticipant = true;
                        break;
                    }
                }
                if (!isChainParticipant)
                    continue;
                items.push({
                    doc_type: "CLAIM",
                    id: c.id,
                    status: c.status,
                    claim_total: Number(c.claim_total),
                    advance_amount: Number(c.advance_amount),
                    balance_amount: Number(c.balance_amount),
                    claimant_name: c.claimant_name,
                    workflow_step_order: c.workflow_step_order,
                    current_step_approver_id: group.steps[0]?.approver_id ?? null,
                    current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
                    current_step_actionable_by_me: false
                });
            }
        };
        // Custom request types (e.g. Change Requests) with a requester-defined
        // approval chain — surface to whichever user is the approver for the
        // current step, regardless of role-based inbox rules. Also surface to
        // anyone (or any team) named as an unconfirmed assignee on a "user_multi"
        // field (e.g. Change Assignee), so being assigned shows up the same way
        // a pending approval does — same bell badge, same inbox list.
        const loadCustomRequestsForUser = async () => {
            const rows = await query(`SELECT s.id, s.status, s.data, s.approval_chain, s.current_step_order, s.created_at, s.request_type_id,
                rt.name AS request_type_name, rt.code AS request_type_code,
                u.full_name AS requester_name
           FROM custom_request_submissions s
           JOIN custom_request_types rt ON rt.id = s.request_type_id
           JOIN users u ON u.id = s.requester_id
          WHERE s.status = 'IN_PROGRESS'
          ORDER BY s.created_at DESC`);
            if (!rows.length)
                return;
            const multiFieldRows = await query(`SELECT DISTINCT request_type_id, field_key FROM request_type_fields WHERE field_type = 'user_multi' AND is_active = true`);
            const multiFieldKeysByType = new Map();
            for (const f of multiFieldRows) {
                multiFieldKeysByType.set(f.request_type_id, [...(multiFieldKeysByType.get(f.request_type_id) || []), f.field_key]);
            }
            for (const r of rows) {
                const chain = r.approval_chain;
                const step = chain[r.current_step_order];
                // Only the approver for the CURRENT step belongs in the inbox as an
                // approval task — a later-step approver shouldn't see (or be able to
                // act on) this until every earlier step has actually been approved.
                const actionable = !!step && step.approver_id === req.user.userId;
                const myFieldKeys = multiFieldKeysByType.get(r.request_type_id) || [];
                const isAssigneeTask = myFieldKeys.some((key) => {
                    const arr = r.data?.[key];
                    return Array.isArray(arr) && arr.some((a) => !a.confirmed && (a.id === req.user.userId || (a.teamId && req.user.teamId && a.teamId === req.user.teamId)));
                });
                if (!actionable && !isAssigneeTask)
                    continue;
                items.push({
                    doc_type: "CUSTOM_REQUEST",
                    id: r.id,
                    status: r.status,
                    request_type_name: r.request_type_name,
                    request_type_code: r.request_type_code,
                    requester_name: r.requester_name,
                    current_step_position_name: step?.position_name ?? null,
                    current_step_actionable_by_me: actionable,
                    is_assignee_task: isAssigneeTask,
                    created_at: r.created_at
                });
            }
        };
        // Workflow-driven advances for this user (their pending approval steps).
        // Runs regardless of `rule` so a step with a specific assigned_user_id is
        // visible even if the user's role has no general inbox rule (e.g. an
        // EMPLOYEE individually named as a workflow approver). ADMIN ("ALL") gets
        // everything via the allWorkflowRows query below, so skip it there.
        if (rule !== "ALL") {
            await loadWorkflowAdvancesForUser();
            await loadFinalStepApprovedAdvancesForUser(req.user.userId);
            await loadWorkflowClaimsForUser();
        }
        await loadCustomRequestsForUser();
        if (!rule)
            return res.json({ items });
        // Load legacy (non-workflow) advances by status.
        // The ownership filter still applies so each role only sees their own dept advances.
        const loadAdvanceByStatus = async (status, advanceType) => {
            const params = [status];
            let typeFilter = "";
            if (advanceType === "NON_LOAN") {
                typeFilter = ` AND ar.type <> 'LOAN'`;
            }
            else if (advanceType) {
                params.push(advanceType);
                typeFilter = ` AND ar.type = $${params.length}`;
            }
            // Exclude workflow-driven advances — those are handled by loadWorkflowAdvancesForUser.
            // APPROVED is the exception: workflow-driven advances leave the active-step
            // query once approved, but FINANCE/ADMIN still need to see them here to
            // mark them paid, so include workflow-driven advances for that status.
            let ownershipFilter = status === "APPROVED" ? "" : " AND ar.approval_chain IS NULL";
            if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
                params.push(delegation?.manager_id || req.user.userId);
                ownershipFilter += ` AND d.manager_user_id = $${params.length}`;
            }
            if (role === "HOD" && status === "COUNTERSIGNED") {
                params.push(req.user.userId);
                ownershipFilter += ` AND d.hod_user_id = $${params.length}`;
            }
            if (role === "EXCO" && status === "COUNTERSIGNED") {
                params.push(req.user.userId);
                ownershipFilter += ` AND d.exco_user_id = $${params.length}`;
            }
            const rows = await query(`SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                u.full_name AS requester_name,
                NULL::text AS current_step_approver_id,
                NULL::int  AS workflow_step_order
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
          WHERE ar.status = $1${typeFilter}${ownershipFilter}
          ORDER BY ar.created_at DESC`, params);
            for (const a of rows) {
                items.push({
                    doc_type: "ADVANCE",
                    id: a.id,
                    status: a.status,
                    advance_type: a.type,
                    requested_total: Number(a.requested_total),
                    approved_total: Number(a.approved_total),
                    purpose: a.purpose,
                    requester_name: a.requester_name,
                    workflow_step_order: a.workflow_step_order,
                    current_step_approver_id: a.current_step_approver_id
                });
            }
        };
        const loadClaimByStatus = async (status) => {
            const params = [status];
            let ownershipFilter = "";
            if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
                params.push(delegation?.manager_id || req.user.userId);
                ownershipFilter = ` AND d.manager_user_id = $${params.length}`;
            }
            // Exclude workflow-driven claims — those are handled by loadWorkflowClaimsForUser.
            // FINANCE_VERIFIED/PAYMENT_PROCESSING are the exception: workflow-driven
            // claims leave the active-step query once their chain completes, but
            // FINANCE/ADMIN still need to see them here to act on, so include them.
            if (status !== "FINANCE_VERIFIED" && status !== "PAYMENT_PROCESSING") {
                ownershipFilter += " AND c.approval_chain IS NULL";
            }
            const rows = await query(`SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, u.full_name AS claimant_name
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
         WHERE c.status = $1${ownershipFilter}
         ORDER BY c.created_at DESC`, params);
            for (const c of rows) {
                items.push({
                    doc_type: "CLAIM",
                    id: c.id,
                    status: c.status,
                    claim_total: Number(c.claim_total),
                    advance_amount: Number(c.advance_amount),
                    balance_amount: Number(c.balance_amount),
                    claimant_name: c.claimant_name
                });
            }
        };
        const loadAccommodationByStatus = async (status) => {
            const rows = await query(`SELECT acc.id,
                acc.status,
                acc.amount,
                acc.location,
                acc.provider,
                requester.full_name AS requester_name,
                creator.full_name AS created_by_name
           FROM accommodation_requests acc
           JOIN users requester ON requester.id = acc.requester_id
           JOIN users creator ON creator.id = acc.created_by_id
          WHERE acc.status = $1
          ORDER BY acc.created_at DESC`, [status]);
            for (const a of rows) {
                items.push({
                    doc_type: "ACCOMMODATION",
                    id: a.id,
                    status: a.status,
                    amount: Number(a.amount),
                    location: a.location,
                    provider: a.provider,
                    requester_name: a.requester_name,
                    created_by_name: a.created_by_name
                });
            }
        };
        const loadOvertimeRequestByStatus = async (status) => {
            const rows = await query(`SELECT o.id, o.status, o.employee_name, o.section_name, o.year, o.month,
                u.full_name AS created_by_name
         FROM overtime_requests o
         JOIN users u ON u.id = o.created_by_id
         WHERE o.status = $1
         ORDER BY o.created_at DESC`, [status]);
            for (const o of rows) {
                items.push({
                    doc_type: "OVERTIME_REQUEST",
                    id: o.id,
                    status: o.status,
                    employee_name: o.employee_name,
                    section_name: o.section_name,
                    year: o.year,
                    month: o.month
                });
            }
        };
        const loadOvertimeClaimByStatus = async (status) => {
            const rows = await query(`SELECT o.id, o.status, o.employee_name, o.division, o.year, o.month, o.total_amount
         FROM overtime_claims o
         WHERE o.status = $1
         ORDER BY o.created_at DESC`, [status]);
            for (const o of rows) {
                items.push({
                    doc_type: "OVERTIME_CLAIM",
                    id: o.id,
                    status: o.status,
                    employee_name: o.employee_name,
                    division: o.division,
                    year: o.year,
                    month: o.month,
                    total_amount: Number(o.total_amount)
                });
            }
        };
        if (rule === "ALL") {
            // Legacy (non-workflow) advances by status
            await loadAdvanceByStatus("SUBMITTED");
            await loadAdvanceByStatus("COUNTERSIGNED");
            await loadAdvanceByStatus("HR_MANAGER_REVIEW");
            await loadAdvanceByStatus("HR_REVIEW");
            await loadAdvanceByStatus("HR_OFFICER");
            await loadAdvanceByStatus("APPROVED");
            await loadAccommodationByStatus("SUBMITTED");
            await loadClaimByStatus("SUBMITTED");
            await loadClaimByStatus("MANAGER_APPROVED");
            await loadClaimByStatus("CHIEF_OFFICER_APPROVED");
            await loadClaimByStatus("HR_OFFICER");
            await loadClaimByStatus("HR_MANAGER_REVIEW");
            await loadClaimByStatus("FINANCE_VERIFIED");
            await loadClaimByStatus("PAYMENT_PROCESSING");
            await loadOvertimeRequestByStatus("SUBMITTED");
            await loadOvertimeRequestByStatus("SUPERVISOR_APPROVED");
            await loadOvertimeRequestByStatus("HOD_APPROVED");
            await loadOvertimeClaimByStatus("SUBMITTED");
            await loadOvertimeClaimByStatus("MANAGER_AUTHORISED");
            await loadOvertimeClaimByStatus("HR_NOTED");
            await loadOvertimeClaimByStatus("FINANCE_VERIFIED");
            await loadOvertimeClaimByStatus("EARNINGS_RECORDED");
            return res.json({ items });
        }
        const rules = Array.isArray(rule) ? rule : [rule];
        for (const r of rules) {
            if (r.doc_type === "ADVANCE") {
                await loadAdvanceByStatus(r.status, r.advance_type);
            }
            else if (r.doc_type === "ACCOMMODATION") {
                await loadAccommodationByStatus(r.status);
            }
            else if (r.doc_type === "OVERTIME_REQUEST") {
                await loadOvertimeRequestByStatus(r.status);
            }
            else if (r.doc_type === "OVERTIME_CLAIM") {
                await loadOvertimeClaimByStatus(r.status);
            }
            else {
                await loadClaimByStatus(r.status);
            }
        }
        return res.json({ items });
    }
    catch (err) {
        return next(err);
    }
});
