import { Router } from "express";
import { AuthedRequest, Role, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { isCompensationFinanceSection, isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { query } from "../../lib/db.js";
import { getDelegatedManagerIds, getActiveDelegationsWithTypes } from "../../lib/delegations.js";
import { canApproveStep, getPendingGroup, findPendingAccommodationStep, isRoundRobinCandidate, type ChainStep } from "../../lib/workflowEngine.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { getViewerDivisionScope } from "../../lib/divisionScope.js";
import { canViewAdvance } from "../advances/advances.routes.js";
import { canViewClaim } from "../claims/claims.routes.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";
import { listSignableDocumentsForUser, listOpenSignableDocumentsForAdmin } from "../signatures/signatures.service.js";

// "CAPTURE" was this system's original built-in capture action code;
// "DEPT_CAPTURE" is the custom one actually registered and used by every
// real workflow's Treasury/Finance capture step today (added later via the
// Action Types panel - see workflow_action_types). Mirrors the frontend's
// isCaptureActionType in Inbox.tsx - keep both in sync.
export function isCaptureActionType(code: string | null | undefined) {
  return code === "CAPTURE" || code === "DEPT_CAPTURE";
}

// Overtime (like Standby) is not wired into this role-based inbox rule
// system — its approval-route stages are employee-defined and delegation-
// scoped, not fixed by role/status, so it has its own dedicated Approvals
// screen (see Overtime.tsx) instead of a generic status-rule mapping here.
type InboxRule =
  | "ALL"
  | {
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION";
      status: string;
      advance_type?: string;
    }
  | Array<{
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION";
      status: string;
      advance_type?: string;
    }>;

async function allowedInboxForUser(role: Role, sectionId?: string | null): Promise<InboxRule | null> {
  const base = allowedInboxForRole(role);
  if (!(await isCompensationFinanceSection(sectionId)) || role === "FINANCE") return base;
  const finance = allowedInboxForRole("FINANCE");
  if (base === "ALL" || finance === "ALL") return "ALL";
  const baseArr = base ? (Array.isArray(base) ? base : [base]) : [];
  const financeArr = finance ? (Array.isArray(finance) ? finance : [finance]) : [];
  return [...baseArr, ...financeArr];
}

function allowedInboxForRole(role: Role): InboxRule | null {
  switch (role) {
    case "HOD":
      return [
        { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
      ];
    case "MANAGER":
      return [
        { doc_type: "ADVANCE", status: "SUBMITTED" },
        { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "CLAIM", status: "SUBMITTED" },
        { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
        { doc_type: "CLAIM", status: "EXCO_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" }
      ];
    case "EXCO":
      return [
        { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
        { doc_type: "CLAIM", status: "EXCO_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" },
        { doc_type: "ADVANCE", status: "COUNTERSIGNED" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" }
      ];
    case "FINANCE":
      return [
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "CLAIM", status: "PAYMENT_PROCESSING" }
      ];
    case "ADMIN":
      return "ALL";
    default:
      return null;
  }
}

export const inboxRouter = Router();

// Newest first, with each item's submitted/created time - the inbox is
// otherwise grouped by load order, and most item types carried no date.
// Lookups are by id per document table; any failure (missing table/column)
// leaves that type undated rather than breaking the inbox.
const INBOX_DATE_TABLES: Record<string, string> = {
  ADVANCE: "advance_requests",
  CLAIM: "clearance_claims",
  ACCOMMODATION: "accommodation_requests",
  CUSTOM_REQUEST: "custom_request_submissions",
  OVERTIME_REQUEST: "overtime_requests",
  OVERTIME_CLAIM: "overtime_claims",
  STANDBY_CLAIM: "standby_claims"
};
async function withDatesNewestFirst<T extends { doc_type?: string; id?: unknown; created_at?: unknown; submitted_at?: unknown }>(items: T[]): Promise<T[]> {
  for (const [docType, table] of Object.entries(INBOX_DATE_TABLES)) {
    const ids = items.filter((i) => i.doc_type === docType && i.id != null).map((i) => String(i.id));
    if (!ids.length) continue;
    try {
      const rows = await query<{ id: string; created_at: string | null; submitted_at: string | null }>(
        `SELECT id::text AS id, created_at, to_jsonb(t)->>'submitted_at' AS submitted_at FROM ${table} t WHERE id::text = ANY($1::text[])`,
        [ids]
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const it of items) {
        if (it.doc_type !== docType) continue;
        const r = byId.get(String(it.id));
        if (!r) continue;
        it.created_at = it.created_at ?? r.created_at;
        it.submitted_at = it.submitted_at ?? r.submitted_at;
      }
    } catch {
      // Leave this type undated.
    }
  }
  const ts = (i: T) => Date.parse(String(i.submitted_at || i.created_at || "")) || 0;
  return [...items].sort((a, b) => ts(b) - ts(a));
}

inboxRouter.use(requireAuth);

inboxRouter.get("/my-actions", async (req: AuthedRequest, res, next) => {
  try {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;

    const rows = await query<any>(
      `SELECT al.id,
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
       LIMIT $2`,
      [req.user!.userId, limit]
    );

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
  } catch (err) {
    return next(err);
  }
});

inboxRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    const delegatedManagerIds = await getDelegatedManagerIds(req.user!.userId);
    const customRequestDelegations = await getActiveDelegationsWithTypes(req.user!.userId);
    // A delegation with no scoped types covers everything; one scoped to
    // "CUSTOM_WORKFLOW" covers every custom request type; otherwise it must
    // list this specific type's own code.
    const isDelegatedForCustomType = (managerId: string | null, typeCode: string | null) =>
      !!managerId && customRequestDelegations.some((d) =>
        d.managerId === managerId && (d.requestTypes.length === 0 || d.requestTypes.includes("CUSTOM_WORKFLOW") || d.requestTypes.includes(typeCode || ""))
      );
    const effectiveRole = delegatedManagerIds.length > 0 && role !== "MANAGER" ? "MANAGER" : role;
    const rule = await allowedInboxForUser(effectiveRole, req.user!.sectionId);

    // Names for every manager this user is delegated by, across both the
    // advance/claim delegation set and the (possibly different) custom-request
    // one, so items can say "acting on behalf of X" instead of just being
    // silently mixed in with the user's own direct approvals.
    const allDelegatingManagerIds = Array.from(new Set([...delegatedManagerIds, ...customRequestDelegations.map((d) => d.managerId)]));
    const delegatingManagerNames = allDelegatingManagerIds.length
      ? new Map((await query<{ id: string; full_name: string | null }>(
          `SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`,
          [allDelegatingManagerIds]
        )).map((u) => [u.id, u.full_name]))
      : new Map<string, string | null>();
    // A plain (non-ANY_ONE-group) step whose approver isn't this user but is
    // one of their delegating managers - group membership is the user's own,
    // not a delegation, so it's excluded here regardless of delegatedManagerIds.
    function delegatedFrom(step: { approver_id: string | null; approver_ids?: string[]; approval_mode: string; approval_group_name: string | null }): string | null {
      if (step.approval_mode === "ANY_ONE" && step.approval_group_name) return null;
      const assignedIds = step.approver_ids?.length ? step.approver_ids : (step.approver_id ? [step.approver_id] : []);
      if (assignedIds.includes(req.user!.userId)) return null;
      return assignedIds.find((id) => delegatedManagerIds.includes(id)) ?? null;
    }

    const items: any[] = [];

    // Defense-in-depth: nothing returned by this endpoint may ever be
    // visible to a viewer who couldn't also open its full detail -
    // GET /advances/:id and GET /claims/:id both enforce canViewAdvance/
    // canViewClaim's "requester, creator, or reached chain participant"
    // rule, and the list must be exactly as strict. Checked once here,
    // right before responding, rather than trusted to every loader above
    // individually - an unapproved request must never be visible to anyone
    // but whoever actually has to sign it, even read-only.
    const managerChainCache = new Map<string, string[]>();
    const managerChainFor = async (userId: string) => {
      if (!managerChainCache.has(userId)) managerChainCache.set(userId, await getManagerChainIds(userId));
      return managerChainCache.get(userId)!;
    };
    async function stripUnviewableItems(rawItems: any[]): Promise<any[]> {
      const advanceIds = rawItems.filter((i) => i.doc_type === "ADVANCE").map((i) => i.id);
      const claimIds = rawItems.filter((i) => i.doc_type === "CLAIM").map((i) => i.id);
      if (!advanceIds.length && !claimIds.length) return rawItems;
      const advanceRows = advanceIds.length
        ? await query<any>(
            `SELECT id, requester_id, created_by_id, approval_chain, workflow_step_order
               FROM advance_requests WHERE id = ANY($1::uuid[])`,
            [advanceIds]
          )
        : [];
      const claimRows = claimIds.length
        ? await query<any>(
            `SELECT id, claimant_id, status, approval_chain, workflow_step_order
               FROM clearance_claims WHERE id = ANY($1::uuid[])`,
            [claimIds]
          )
        : [];
      const advanceById = new Map(advanceRows.map((r) => [r.id, r]));
      const claimById = new Map(claimRows.map((r) => [r.id, r]));

      const kept: any[] = [];
      for (const it of rawItems) {
        if (it.doc_type === "ADVANCE") {
          const row = advanceById.get(it.id);
          if (!row) { kept.push(it); continue; }
          let allowed = await canViewAdvance({
            role: req.user!.role,
            requesterId: row.requester_id,
            createdById: row.created_by_id,
            userId: req.user!.userId,
            approvalChain: row.approval_chain,
            workflowStepOrder: row.workflow_step_order,
            managerChainIds: await managerChainFor(row.requester_id),
            delegatedManagerIds
          });
          if (!allowed) {
            // Preserve the intentional Finance/HR-Ops capture oversight
            // grant (admin_feature_permissions, e.g. "Section: Human
            // Resources Operations" holding "capture"): visible once the
            // item's own Capture step has actually been reached, even
            // without literal membership in that step's approval_group_name -
            // same rule loadCaptureHistoryItems already applies above.
            // canViewAdvance doesn't know about this admin-configurable
            // grant, so it's re-checked here rather than widening
            // canViewAdvance itself for every other caller.
            const chain = (row.approval_chain || []) as ChainStep[];
            const captureStep = chain.find((s) => isCaptureActionType(s.action_type));
            if (captureStep) {
              const group = getPendingGroup(chain, row.workflow_step_order ?? 0);
              const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
              const captureStepReached = captureStep.approved || chain.indexOf(captureStep) <= maxReachedIdx;
              if (captureStepReached) {
                allowed = (await hasFeatureAccess(req.user!.userId, effectiveRole, "capture", ["ADMIN", "Section: Treasury & Financial Accounting"])) || (await isCompensationFinanceUser(req));
              }
            }
          }
          if (allowed) kept.push(it);
          continue;
        }
        if (it.doc_type === "CLAIM") {
          const row = claimById.get(it.id);
          if (!row) { kept.push(it); continue; }
          const allowed = await canViewClaim({
            role: req.user!.role,
            sectionId: req.user!.sectionId,
            status: row.status,
            claimantId: row.claimant_id,
            userId: req.user!.userId,
            approvalChain: row.approval_chain,
            workflowStepOrder: row.workflow_step_order,
            managerChainIds: await managerChainFor(row.claimant_id),
            delegatedManagerIds
          });
          if (allowed) kept.push(it);
          continue;
        }
        kept.push(it);
      }
      return kept;
    }

    // Load workflow-driven advances where it is this user's turn to act. A
    // request's current "stage" (getPendingGroup) may contain multiple steps
    // when they're flagged parallel_with_previous — match if the user can
    // approve any not-yet-approved member of that stage (mirrors canApproveStep,
    // including "Team: X" ANY_ONE group handling).
    const loadWorkflowAdvancesForUser = async () => {
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.workflow_step_order, ar.approval_chain,
                u.full_name AS requester_name, tt.currency, dv.name AS division
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = u.division_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status NOT IN ('DRAFT','PAID','REJECTED','CANCELLED','APPROVED')
          ORDER BY ar.created_at DESC`
      );
      for (const a of rows) {
        const chain = a.approval_chain as ChainStep[];
        const group = getPendingGroup(chain, a.workflow_step_order ?? 0);
        let matched: ChainStep | undefined;
        for (const step of group.steps) {
          if (step.approved) continue;
          if (await canApproveStep(step, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { matched = step; break; }
        }
        // Accommodation is parallel/non-blocking, so the chain's pending
        // group can move on (e.g. once Capture/payment complete) while the
        // accommodation step itself is still unbooked - fall back to a
        // whole-chain scan so HR Operations (or whoever is assigned) still
        // sees it as actionable instead of it silently disappearing once the
        // advance is APPROVED/PAID.
        let lateAccommodation: ChainStep | undefined;
        if (!matched) {
          const accStep = findPendingAccommodationStep(chain);
          if (accStep && await canApproveStep(accStep.step, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) {
            matched = accStep.step;
            lateAccommodation = accStep.step;
          }
        }
        if (matched) {
          const delegatedFromId = delegatedFrom(matched);
          items.push({
            doc_type: "ADVANCE",
            id: a.id,
            status: a.status,
            advance_type: a.type,
            requested_total: Number(a.requested_total),
            approved_total: Number(a.approved_total),
            purpose: a.purpose,
            requester_name: a.requester_name,
            currency: a.currency,
            division: a.division ?? null,
            workflow_step_order: a.workflow_step_order,
            current_step_approver_id: matched.approver_id,
            current_step_position_name: lateAccommodation ? matched.position_name : group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
            current_step_requires_accommodation: matched.requires_accommodation,
            current_step_action_type: matched.action_type,
            current_step_can_reject: matched.can_reject,
            current_step_can_rollback: matched.can_rollback,
            current_step_actionable_by_me: true,
            is_delegated: !!delegatedFromId,
            delegated_from_manager_name: delegatedFromId ? delegatingManagerNames.get(delegatedFromId) ?? null : null
          });
          continue;
        }
        // Not this user's turn — but if they're a member of this workflow's
        // approval chain at a step that has already been reached (past or
        // current, not a future step the request hasn't progressed to yet),
        // surface it as a read-only tracking item so they can follow its
        // progress.
        let isChainParticipant = false;
        // The specific step that made this a participant, when it's a
        // round-robin candidate on a "late" step outside the current pending
        // group (e.g. accommodation after Capture/payment moved on) - display
        // must come from that step, not group.steps[0], or a round-robin
        // viewer would see the wrong (or no) "needs accommodation" signal.
        let participantStep: ChainStep | undefined;
        const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
        for (let i = 0; i <= maxReachedIdx && i < chain.length; i++) {
          if (await canApproveStep(chain[i], req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { isChainParticipant = true; participantStep = chain[i]; break; }
          // A round-robin-restricted step (e.g. HR Operations accommodation
          // booking/clearance closing) rejects everyone but the one assigned
          // person above - the rest of the candidate pool still gets this
          // read-only tracking view instead of losing visibility entirely.
          if (await isRoundRobinCandidate(chain[i], req.user!.userId, effectiveRole)) { isChainParticipant = true; participantStep = chain[i]; break; }
        }
        if (!isChainParticipant) continue;
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name,
          currency: a.currency,
          division: a.division ?? null,
          workflow_step_order: a.workflow_step_order,
          current_step_approver_id: participantStep?.approver_id ?? group.steps[0]?.approver_id ?? null,
          current_step_position_name: group.indices.includes(chain.indexOf(participantStep!))
            ? group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + ")
            : participantStep?.position_name ?? "",
          current_step_requires_accommodation: participantStep?.requires_accommodation ?? false,
          current_step_can_reject: participantStep?.can_reject ?? true,
          current_step_can_rollback: participantStep?.can_rollback ?? true,
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
    const loadFinalStepApprovedAdvancesForUser = async (userId: string) => {
      // Explicit MARK_PAID steps: the workflow designates a specific payer team/person.
      // The step pointed to by workflow_step_order has action_type = 'MARK_PAID'.
      const userGroups = await getUserGroups(userId);
      const markPaidRows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.approval_chain, u.full_name AS requester_name, tt.currency, dv.name AS division
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = u.division_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status = 'APPROVED'
            AND ar.workflow_step_order IS NOT NULL
            AND (ar.approval_chain->(ar.workflow_step_order::int)->>'action_type') = 'MARK_PAID'
            AND (
              -- SINGLE step: specific named person(s) — approver_id (legacy
              -- primary) or membership in the step's approver_ids array.
              (
                (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_mode') = 'SINGLE'
                AND (
                  (ar.approval_chain->(ar.workflow_step_order::int)->>'approver_id') = $1
                  OR (ar.approval_chain->(ar.workflow_step_order::int)->'approver_ids') ? $1
                )
              )
              OR
              -- ANY_ONE group step: any member of the named group
              (
                (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_mode') = 'ANY_ONE'
                AND (ar.approval_chain->(ar.workflow_step_order::int)->>'approval_group_name') = ANY($2::text[])
              )
            )
          ORDER BY ar.created_at DESC`,
        [userId, userGroups.length > 0 ? userGroups : [""]]
      );
      for (const a of markPaidRows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        // A workflow whose Capture step this same user also holds (e.g.
        // SEFS's Finance Operations group does both DEPT_CAPTURE and
        // MARK_PAID) reaches MARK_PAID only after Capture is done - without
        // marking capture_done here, this item has none of the fields the
        // frontend's isCaptureItem check looks for, so it silently vanished
        // from the Capture Inbox entirely (claimed by this loader first,
        // ahead of loadCaptureHistoryItems below, whose dedup then skipped
        // it) instead of showing up in the Captured tab.
        const chain = a.approval_chain as ChainStep[];
        const hasCaptureStep = chain.some((s) => isCaptureActionType(s.action_type));
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name,
          currency: a.currency,
          division: a.division ?? null,
          is_final_step_approver: true,
          ...(hasCaptureStep ? { current_step_action_type: "DEPT_CAPTURE", capture_done: true } : {})
        });
      }

      // Fallback: SINGLE-mode final approval step (no explicit MARK_PAID step).
      // The named person who gave final approval can also mark as paid.
      const singleRows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.approval_chain, u.full_name AS requester_name, tt.currency, dv.name AS division
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = u.division_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status = 'APPROVED'
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ar.approval_chain) s
              WHERE s->>'action_type' = 'MARK_PAID'
            )
            AND (ar.approval_chain->(jsonb_array_length(ar.approval_chain) - 1)->>'approval_mode') = 'SINGLE'
            AND (
              (ar.approval_chain->(jsonb_array_length(ar.approval_chain) - 1)->>'approver_id') = $1
              OR (ar.approval_chain->(jsonb_array_length(ar.approval_chain) - 1)->'approver_ids') ? $1
            )
          ORDER BY ar.created_at DESC`,
        [userId]
      );
      for (const a of singleRows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        const chain = a.approval_chain as ChainStep[];
        const hasCaptureStep = chain.some((s) => isCaptureActionType(s.action_type));
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          division: a.division ?? null,
          ...(hasCaptureStep ? { current_step_action_type: "DEPT_CAPTURE", capture_done: true } : {}),
          requester_name: a.requester_name,
          currency: a.currency,
          is_final_step_approver: true
        });
      }
    };

    // DEPT_REPORTS ("View") steps are a read-only FYI, never a pending
    // action (see the stillPending exclusion in advances.service.ts /
    // claims.service.ts) - so once the request has actually reached final
    // approval, whoever holds that step should still be able to open it and
    // look, even though the two loaders above already stopped surfacing it
    // (they only track requests still in progress). Matches the same
    // SINGLE-approver / ANY_ONE-group pattern used throughout this file.
    const loadViewOnlyCompletedItemsForUser = async () => {
      const userGroups = await getUserGroups(req.user!.userId);
      const groupsParam = userGroups.length ? userGroups : [""];

      const advRows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                u.full_name AS requester_name, tt.currency, dv.name AS division
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = u.division_id
          WHERE ar.status IN ('APPROVED','PAID','CLOSED')
            AND ar.approval_chain IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(ar.approval_chain) s
              WHERE s->>'action_type' = 'DEPT_REPORTS'
                AND (
                  (s->>'approver_id') = $1
                  OR (s->'approver_ids') ? $1
                  OR ((s->>'approval_mode') = 'ANY_ONE' AND (s->>'approval_group_name') = ANY($2::text[]))
                )
            )
          ORDER BY ar.created_at DESC`,
        [req.user!.userId, groupsParam]
      );
      for (const a of advRows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name,
          currency: a.currency,
          division: a.division ?? null,
          current_step_action_type: "DEPT_REPORTS",
          current_step_actionable_by_me: false,
          is_view_only: true
        });
      }

      const claimRows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, c.currency,
                u.full_name AS claimant_name
           FROM clearance_claims c
           JOIN users u ON u.id = c.claimant_id
          WHERE c.status IN ('CLOSED','COMPLETED')
            AND c.approval_chain IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(c.approval_chain) s
              WHERE s->>'action_type' = 'DEPT_REPORTS'
                AND (
                  (s->>'approver_id') = $1
                  OR (s->'approver_ids') ? $1
                  OR ((s->>'approval_mode') = 'ANY_ONE' AND (s->>'approval_group_name') = ANY($2::text[]))
                )
            )
          ORDER BY c.created_at DESC`,
        [req.user!.userId, groupsParam]
      );
      for (const c of claimRows) {
        if (items.some((i: any) => i.id === c.id)) continue;
        items.push({
          doc_type: "CLAIM",
          id: c.id,
          status: c.status,
          claim_total: Number(c.claim_total),
          advance_amount: Number(c.advance_amount),
          balance_amount: Number(c.balance_amount),
          currency: c.currency,
          claimant_name: c.claimant_name,
          current_step_action_type: "DEPT_REPORTS",
          current_step_actionable_by_me: false,
          is_view_only: true
        });
      }
    };

    // Surfaces Capture-step items that the main loaders above miss:
    //  - ADMIN entirely skips loadWorkflowAdvancesForUser (see call site below),
    //    so without this they'd never see any workflow-driven Capture step, done or not.
    //  - For everyone else, once a request's Capture step is approved the workflow
    //    moves on, and loadWorkflowAdvancesForUser's own query excludes APPROVED/PAID
    //    advances outright — so a request the user already captured would otherwise
    //    vanish from their view entirely instead of staying visible as done. capture_done
    //    lets the frontend keep it in the Capture Inbox and swap the action to a plain
    //    PDF download instead of re-offering the (already-completed) Capture action.
    const loadCaptureHistoryItems = async () => {
      const isAdmin = rule === "ALL";
      // Whoever holds the "capture" feature grant (default: ADMIN + the
      // Treasury & Financial Accounting team) can see every pending capture
      // item for visibility, even if they're not personally in the step's
      // own ANY_ONE group - e.g. HR Operations, granted view-only access.
      // current_step_actionable_by_me below still runs the real canApproveStep
      // check, so this never grants the ability to actually capture anything.
      const captureViewOnly = !isAdmin && ((await hasFeatureAccess(req.user!.userId, effectiveRole, "capture", ["ADMIN", "Section: Treasury & Financial Accounting"])) || (await isCompensationFinanceUser(req)));
      // Non-admin capture staff only work their own company's queue - SEFS's
      // Finance Operations team shouldn't see MNO's Treasury queue mixed in
      // (and vice versa), but MNO's Treasury also handles HigherLife's
      // capture work (it has no finance staff of its own), so an MNO viewer's
      // scope is {MNO, HigherLife} rather than MNO alone. ADMIN keeps the
      // company-wide view.
      const allowedDivisions = await getViewerDivisionScope(req.user!.userId, isAdmin);
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.workflow_step_order, ar.approval_chain, u.full_name AS requester_name, tt.currency,
                dv.name AS division
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = u.division_id
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status NOT IN ('DRAFT','REJECTED','CANCELLED')
          ORDER BY ar.created_at DESC`
      );
      for (const a of rows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        if (allowedDivisions && !allowedDivisions.includes(a.division)) continue;
        const chain = a.approval_chain as ChainStep[];
        const captureStep = chain.find((s) => isCaptureActionType(s.action_type));
        if (!captureStep) continue;
        const group = getPendingGroup(chain, a.workflow_step_order ?? 0);
        // A capture-feature holder's oversight grant is for once a request
        // is actually relevant to them - not a preview of earlier stages
        // (the requester's manager/EXCO approval, etc.) before the chain
        // has reached the capture step at all. Without this cutoff, e.g.
        // Finance/Treasury saw every travel advance from the moment it was
        // submitted, regardless of whose turn it currently was.
        const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
        const captureStepReached = captureStep.approved || chain.indexOf(captureStep) <= maxReachedIdx;
        // Pending (not-yet-captured) items for non-admin users are already
        // surfaced by loadWorkflowAdvancesForUser above — only add them here
        // for ADMIN (whose main loader is skipped), a view-only capture-feature
        // holder once the chain has actually reached them, or once already captured.
        // The cutoff applies to ADMIN too: an advance still waiting on its
        // manager/HOD isn't capture work yet (it was listing - and counting
        // as pending - every advance from the moment it was submitted). The
        // admin still sees those in the Approval Inbox.
        if (!captureStep.approved && !captureStepReached) continue;
        if (!captureStep.approved && !isAdmin && !captureViewOnly) continue;
        if (!isAdmin && !captureViewOnly) {
          const eligible = await canApproveStep(captureStep, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId);
          if (!eligible) continue;
        }
        // Accommodation is parallel/non-blocking - it can still be sitting
        // unbooked (no accommodation_requests row created yet) long after
        // Capture/payment finished and this loader's own displayed step has
        // moved on to captureStep. Scan the whole chain so the item still
        // carries an accurate requires_accommodation flag and stays
        // actionable for whoever can book it, instead of silently losing
        // that signal the moment Capture completes (which is what let 56
        // advances since 2026-08-20 go all the way to PAID with no one ever
        // seeing that they still needed an accommodation booking).
        const accStep = findPendingAccommodationStep(chain);
        const captureActionable = !captureStep.approved && (isAdmin || (await canApproveStep(captureStep, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)));
        const accommodationActionable = !!accStep && (isAdmin || (await canApproveStep(accStep.step, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)));
        // Use captureStep itself for the displayed "current step" fields,
        // not just "whichever group member happens to be unapproved first"
        // (group.steps in array/step_order order) - some workflows (e.g.
        // SEFS's) have Accommodation at a lower step_order than Capture, so
        // that generic pick returned DEPT_ACCOMODATION here, which then
        // failed the frontend's isCaptureItem/isCaptureActionType check and
        // silently hid an otherwise-actionable capture item from the whole
        // Capture Inbox (including its company tab counts).
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name,
          currency: a.currency,
          division: a.division ?? null,
          workflow_step_order: a.workflow_step_order,
          current_step_approver_id: captureStep.approver_id ?? null,
          current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + ") || captureStep.position_name,
          current_step_action_type: captureStep.action_type,
          current_step_can_reject: captureStep.can_reject,
          current_step_can_rollback: captureStep.can_rollback,
          current_step_requires_accommodation: !!accStep,
          // ADMIN can act on any pending step regardless of who it's
          // assigned to (the actual capture/approve endpoints already allow
          // this) - without this, an admin viewing a step restricted to one
          // specific individual (e.g. SEFS's Capture step) never counted as
          // "actionable by me", so their Capture Inbox badge stayed stuck at
          // 0 even with dozens of items genuinely waiting to be captured.
          // Also true once capture is fully done if a booking is still
          // needed (accommodationActionable) - otherwise this item stops
          // being actionable the moment Capture/payment finishes, even
          // though the (separate, parallel) accommodation step is still open.
          current_step_actionable_by_me: captureActionable || accommodationActionable,
          capture_done: !!captureStep.approved,
          is_delegated: !!delegatedFrom(captureStep),
          delegated_from_manager_name: (() => {
            const id = delegatedFrom(captureStep);
            return id ? delegatingManagerNames.get(id) ?? null : null;
          })()
        });
      }
    };

    // Accommodation is captured/paid centrally by MNO's own Finance/Treasury
    // team for every company (unlike Advance capture, which each company's
    // own finance team handles for itself) - so who can ACT is a single
    // global, company-agnostic is_compensation_finance check, same as
    // accommodation.routes.ts's mark-paid/reject gate and Deductions/
    // Refundable's own act gates. A company's own finance-adjacent staff
    // (e.g. SEFS) can still VIEW - never act on - their own company's
    // booking: specifically whoever would be eligible on the *linked
    // advance's own* Capture step (that advance's chain is already resolved
    // per the requester's own division at submission time, so this is
    // naturally scoped to that one company already, no separate division
    // filter needed). The HR user who created it or the traveller it's for
    // can always view their own, regardless of company. DRAFT bookings are
    // real accommodation documents and Admin must have visibility into them
    // to ensure no Accommodation tab is hidden when records exist.
    const loadAccommodationItems = async () => {
      const isAdmin = rule === "ALL";
      const canAct = isAdmin || (await isCompensationFinanceSection(req.user!.sectionId));
      const captureViewOnly = !canAct && (await hasFeatureAccess(req.user!.userId, effectiveRole, "capture", ["ADMIN", "Section: Treasury & Financial Accounting"]));
      const rows = await query<any>(
        `SELECT acc.id, acc.status, acc.amount, acc.location, acc.provider,
                acc.created_by_id, acc.requester_id,
                requester.full_name AS requester_name,
                creator.full_name AS created_by_name,
                ar.approval_chain,
                dv.name AS division,
                COALESCE(tt.currency, 'LSL') AS currency
           FROM accommodation_requests acc
           JOIN users requester ON requester.id = acc.requester_id
           JOIN users creator ON creator.id = acc.created_by_id
           JOIN advance_requests ar ON ar.id = acc.advance_request_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
           LEFT JOIN divisions dv ON dv.id = requester.division_id
          ORDER BY acc.created_at DESC`
      );
      for (const a of rows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        const isOwner = a.created_by_id === req.user!.userId || a.requester_id === req.user!.userId;

        // DRAFT bookings are real accommodation documents. Include them for
        // Admin and owner/creator only (keep private from other unrelated viewers
        // until submitted to Finance).
        if (a.status === "DRAFT") {
          if (!isAdmin && !isOwner) continue;
        } else {
          // For non-DRAFT accommodation records, require a real workflow gate
          // before read-only capture visibility kicks in. A general capture
          // grant is not permission to see the booking before the linked
          // advance's capture step has actually been reached, especially for
          // HR Operations users who should not see an accommodation record in
          // their portal while it is still pending approval.
          const chain = (a.approval_chain ?? []) as ChainStep[];
          const captureStep = chain.find((s) => isCaptureActionType(s.action_type));
          const group = getPendingGroup(chain, Number(a.workflow_step_order ?? 0));
          const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
          const captureStepReached = captureStep ? (captureStep.approved || chain.indexOf(captureStep) <= maxReachedIdx) : false;
          const chainEligible = captureStep ? await canApproveStep(captureStep, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId) : false;

          if (!canAct && !isOwner && !(chainEligible || (captureViewOnly && captureStepReached))) {
            continue;
          }
        }

        items.push({
          doc_type: "ACCOMMODATION",
          id: a.id,
          status: a.status,
          amount: Number(a.amount),
          currency: a.currency,
          location: a.location,
          provider: a.provider,
          requester_name: a.requester_name,
          created_by_name: a.created_by_name,
          division: a.division ?? null,
          current_step_actionable_by_me: canAct && a.status === "SUBMITTED",
          capture_done: a.status === "PAID"
        });
      }
    };

    // Load workflow-driven clearance claims where it is this user's turn to
    // act. Mirrors loadWorkflowAdvancesForUser, but for clearance_claims.
    const loadWorkflowClaimsForUser = async () => {
      const rows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, c.currency,
                c.workflow_step_order, c.approval_chain,
                u.full_name AS claimant_name
           FROM clearance_claims c
           JOIN users u ON u.id = c.claimant_id
          WHERE c.approval_chain IS NOT NULL
            AND c.status NOT IN ('DRAFT','SETTLED','CLOSED','REJECTED','FINANCE_VERIFIED','PAYMENT_PROCESSING')
          ORDER BY c.created_at DESC`
      );
      for (const c of rows) {
        const chain = c.approval_chain as ChainStep[];
        const group = getPendingGroup(chain, c.workflow_step_order ?? 0);
        let matched: ChainStep | undefined;
        for (const step of group.steps) {
          if (step.approved) continue;
          if (await canApproveStep(step, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { matched = step; break; }
        }
        if (matched) {
          const delegatedFromId = delegatedFrom(matched);
          items.push({
            doc_type: "CLAIM",
            id: c.id,
            status: c.status,
            claim_total: Number(c.claim_total),
            advance_amount: Number(c.advance_amount),
            balance_amount: Number(c.balance_amount),
            currency: c.currency,
            claimant_name: c.claimant_name,
            workflow_step_order: c.workflow_step_order,
            current_step_approver_id: matched.approver_id,
            current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
            current_step_action_type: matched.action_type,
            current_step_actionable_by_me: true,
            is_delegated: !!delegatedFromId,
            delegated_from_manager_name: delegatedFromId ? delegatingManagerNames.get(delegatedFromId) ?? null : null
          });
          continue;
        }
        // Not this user's turn — but if they're a member of this workflow's
        // approval chain at a step that has already been reached (past or
        // current, not a future step the request hasn't progressed to yet),
        // surface it as a read-only tracking item so they can follow its
        // progress.
        let isChainParticipant = false;
        let participantStep: ChainStep | undefined;
        const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
        for (let i = 0; i <= maxReachedIdx && i < chain.length; i++) {
          if (await canApproveStep(chain[i], req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { isChainParticipant = true; participantStep = chain[i]; break; }
          // A round-robin-restricted step (e.g. HR Operations accommodation
          // booking/clearance closing) rejects everyone but the one assigned
          // person above - the rest of the candidate pool still gets this
          // read-only tracking view instead of losing visibility entirely.
          if (await isRoundRobinCandidate(chain[i], req.user!.userId, effectiveRole)) { isChainParticipant = true; participantStep = chain[i]; break; }
        }
        if (!isChainParticipant) continue;
        items.push({
          doc_type: "CLAIM",
          id: c.id,
          status: c.status,
          claim_total: Number(c.claim_total),
          advance_amount: Number(c.advance_amount),
          balance_amount: Number(c.balance_amount),
          currency: c.currency,
          claimant_name: c.claimant_name,
          workflow_step_order: c.workflow_step_order,
          current_step_approver_id: participantStep?.approver_id ?? group.steps[0]?.approver_id ?? null,
          current_step_position_name: group.indices.includes(chain.indexOf(participantStep!))
            ? group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + ")
            : participantStep?.position_name ?? "",
          current_step_action_type: participantStep?.action_type ?? null,
          current_step_actionable_by_me: false
        });
      }
    };

    // ADMIN ("ALL") backstop for workflow-driven advances/claims: the
    // per-user loaders above (loadWorkflowAdvancesForUser,
    // loadWorkflowClaimsForUser) are skipped entirely for ALL, and
    // loadAdvanceByStatus/loadClaimByStatus below only cover pre-workflow
    // legacy records (approval_chain IS NULL) plus the terminal APPROVED
    // status — so without this, a workflow-driven advance or claim sitting
    // at a normal, non-final approval step is invisible to every admin
    // account, even though performAdvanceApprove/performClaimApprove both
    // already accept an admin override for that exact step.
    //
    // current_step_actionable_by_me used to be hardcoded true for every one
    // of these - technically correct (admin CAN override any step via the
    // approve endpoints' own role === 'ADMIN' bypass), but it meant every
    // single in-progress request company-wide showed up as "Pending" in an
    // admin's own inbox, including ones a specific other person (e.g. a
    // named Manager) hasn't acted on yet - a real incident: an admin's
    // Pending count read in the dozens, mostly other people's work, with no
    // way to tell "needs me specifically" from "just visible to me." Now
    // matches the real per-step eligibility (same canApproveStep check every
    // other viewer gets), so Pending only holds items genuinely stuck with
    // no one else positioned to act - everything else still shows up here
    // for oversight, just correctly filed under Approved/not-mine.
    const loadAllWorkflowAdvancesForAdmin = async () => {
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                ar.workflow_step_order, ar.approval_chain, u.full_name AS requester_name, tt.currency
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN travel_types tt ON tt.code = ar.type
          WHERE ar.approval_chain IS NOT NULL
            AND ar.status NOT IN ('DRAFT','PAID','REJECTED','CANCELLED','APPROVED')
          ORDER BY ar.created_at DESC`
      );
      for (const a of rows) {
        if (items.some((i: any) => i.id === a.id)) continue;
        const chain = a.approval_chain as ChainStep[];
        const group = getPendingGroup(chain, a.workflow_step_order ?? 0);
        // Same rationale as loadCaptureHistoryItems: a still-open
        // requires_accommodation step can lag behind group.steps[0] once
        // parallel Capture has moved the pending group on, so it must be
        // found by a whole-chain scan, not read off the group's own steps.
        const accStep = findPendingAccommodationStep(chain);
        if ((!group.steps.length || group.steps.every((s) => s.approved)) && !accStep) continue;
        let actionableByMe = false;
        for (const s of group.steps) {
          if (s.approved) continue;
          if (await canApproveStep(s, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { actionableByMe = true; break; }
        }
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name,
          currency: a.currency,
          workflow_step_order: a.workflow_step_order,
          current_step_approver_id: group.steps[0]?.approver_id ?? null,
          current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
          current_step_requires_accommodation: !!accStep,
          current_step_action_type: group.steps[0]?.action_type ?? null,
          current_step_can_reject: group.steps[0]?.can_reject ?? true,
          current_step_can_rollback: group.steps[0]?.can_rollback ?? true,
          current_step_actionable_by_me: actionableByMe
        });
      }
    };

    const loadAllWorkflowClaimsForAdmin = async () => {
      const rows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, c.currency,
                c.workflow_step_order, c.approval_chain, u.full_name AS claimant_name
           FROM clearance_claims c
           JOIN users u ON u.id = c.claimant_id
          WHERE c.approval_chain IS NOT NULL
            AND c.status NOT IN ('DRAFT','SETTLED','CLOSED','REJECTED','FINANCE_VERIFIED','PAYMENT_PROCESSING')
          ORDER BY c.created_at DESC`
      );
      for (const c of rows) {
        if (items.some((i: any) => i.id === c.id)) continue;
        const chain = c.approval_chain as ChainStep[];
        const group = getPendingGroup(chain, c.workflow_step_order ?? 0);
        if (!group.steps.length || group.steps.every((s) => s.approved)) continue;
        let actionableByMe = false;
        for (const s of group.steps) {
          if (s.approved) continue;
          if (await canApproveStep(s, req.user!.userId, effectiveRole, delegatedManagerIds, req.user!.sectionId)) { actionableByMe = true; break; }
        }
        items.push({
          doc_type: "CLAIM",
          id: c.id,
          status: c.status,
          claim_total: Number(c.claim_total),
          advance_amount: Number(c.advance_amount),
          balance_amount: Number(c.balance_amount),
          currency: c.currency,
          claimant_name: c.claimant_name,
          workflow_step_order: c.workflow_step_order,
          current_step_approver_id: group.steps[0]?.approver_id ?? null,
          current_step_position_name: group.steps.filter((s) => !s.approved).map((s) => s.position_name).join(" + "),
          current_step_action_type: group.steps[0]?.action_type ?? null,
          current_step_actionable_by_me: actionableByMe
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
      const rows = await query<any>(
        `SELECT s.id, s.status, s.data, s.approval_chain, s.current_step_order, s.created_at, s.request_type_id,
                rt.name AS request_type_name, rt.code AS request_type_code,
                u.full_name AS requester_name
           FROM custom_request_submissions s
           JOIN custom_request_types rt ON rt.id = s.request_type_id
           JOIN users u ON u.id = s.requester_id
          WHERE s.status = 'IN_PROGRESS'
          ORDER BY s.created_at DESC`
      );
      if (!rows.length) return;

      const multiFieldRows = await query<{ request_type_id: string; field_key: string }>(
        `SELECT DISTINCT request_type_id, field_key FROM request_type_fields WHERE field_type = 'user_multi' AND is_active = true`
      );
      const multiFieldKeysByType = new Map<string, string[]>();
      for (const f of multiFieldRows) {
        multiFieldKeysByType.set(f.request_type_id, [...(multiFieldKeysByType.get(f.request_type_id) || []), f.field_key]);
      }

      for (const r of rows) {
        const chain = r.approval_chain as Array<{ approver_id: string; approver_name: string | null; position_name: string; status: string }>;
        const step = chain[r.current_step_order];
        const myFieldKeys = multiFieldKeysByType.get(r.request_type_id) || [];

        // Approving any step is blocked while a "user_multi" field (e.g.
        // Change Assignee) still has unconfirmed assignees — see the same
        // check in performCustomRequestAction(). Mirror that here so the
        // approver's inbox stays empty (not just un-actionable) until the
        // assignee has actually confirmed the implementation plan; the
        // assignee themselves still sees it as their own task below.
        const hasUnconfirmedAssignees = myFieldKeys.some((key) => {
          const arr = r.data?.[key];
          return Array.isArray(arr) && arr.some((a: any) => !a.confirmed);
        });

        // Only the approver for the CURRENT step belongs in the inbox as an
        // approval task — a later-step approver shouldn't see (or be able to
        // act on) this until every earlier step has actually been approved,
        // and no approver should see it until the assignee has signed off.
        const isDelegatedCustomMatch = !!step && step.approver_id !== req.user!.userId && isDelegatedForCustomType(step.approver_id, r.request_type_code);
        const isStepApprover = !!step && (step.approver_id === req.user!.userId || isDelegatedCustomMatch);
        const actionable = isStepApprover && !hasUnconfirmedAssignees;

        const isAssigneeTask = myFieldKeys.some((key) => {
          const arr = r.data?.[key];
          return Array.isArray(arr) && arr.some((a: any) =>
            !a.confirmed && (a.id === req.user!.userId || (a.teamId && req.user!.teamId && a.teamId === req.user!.teamId))
          );
        });

        if (!actionable && !isAssigneeTask) continue;
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
          is_delegated: actionable && isDelegatedCustomMatch,
          delegated_from_manager_name: (actionable && isDelegatedCustomMatch && step?.approver_id) ? delegatingManagerNames.get(step.approver_id) ?? null : null,
          created_at: r.created_at
        });
      }
    };

    // Electronic Signature routing documents with an approval route -
    // surfaces to whoever is the approver for the current step, same
    // is_my_turn logic as the document's own list in signatures.service.ts.
    // A routing document with no approval route (free-for-all, anyone with
    // the link can sign) never shows up here - there's no single "current
    // approver" to notify in that mode, matching how it works everywhere
    // else in that feature.
    const loadSignableDocumentsForUser = async () => {
      // ADMIN gets the same company-wide oversight every other request type
      // already gives it - every open routing document, not just ones
      // where it's literally their turn (see listOpenSignableDocumentsForAdmin's
      // own comment: this is visibility only, signing itself still enforces
      // strict turn order with no admin bypass).
      if (rule === "ALL") {
        const rows = await listOpenSignableDocumentsForAdmin();
        for (const r of rows) {
          const chain = r.approval_chain as Array<{ approver_id: string; approver_name: string | null }>;
          const isMyTurn = chain[r.current_step_order]?.approver_id === req.user!.userId;
          items.push({
            doc_type: "SIGNABLE_DOCUMENT",
            id: r.id,
            status: r.status,
            title: r.title,
            created_by_name: r.created_by_name,
            current_step_actionable_by_me: isMyTurn,
            created_at: r.created_at
          });
        }
        return;
      }
      const rows = await listSignableDocumentsForUser(req.user!.userId);
      for (const r of rows) {
        if (!r.is_my_turn) continue;
        items.push({
          doc_type: "SIGNABLE_DOCUMENT",
          id: r.id,
          status: r.status,
          title: r.title,
          created_by_name: r.created_by_name,
          current_step_actionable_by_me: true,
          created_at: r.created_at
        });
      }
    };

    // Overtime and Standby have their own employee-defined, delegation-scoped
    // approval routes (route_version + step_order on a dedicated steps table,
    // not the inline approval_chain JSONB the workflow engine uses) — same
    // shape as loadCustomRequestsForUser's chain-of-approval model, just
    // stored differently. Mirrors the exact queries behind /overtime/request-
    // approvals, /overtime/approvals and /standby/approvals so the inbox and
    // each module's own Approvals tab never disagree about who's up next.
    // Each of these has its own delegation scope (OVERTIME_REQUEST /
    // OVERTIME_CLAIM / STANDBY_CLAIM), distinct from the advance/custom-request
    // delegation set the outer delegatingManagerNames map was built from — so
    // each loader resolves names for its own delegatedFor list instead of
    // relying on that map, same as /overtime/request-approvals etc. do.
    const nameMapFor = async (managerIds: string[]) =>
      managerIds.length
        ? new Map((await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [managerIds])).map((u) => [u.id, u.full_name]))
        : new Map<string, string | null>();

    const loadOvertimeRequestItems = async () => {
      const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_REQUEST");
      const approverIds = [req.user!.userId, ...delegatedFor];
      const names = await nameMapFor(delegatedFor);
      const rows = await query<any>(
        `SELECT r.id, r.request_no, r.year, r.month, r.submitted_at, u.full_name AS employee_name, s.title AS my_title, s.approver_user_id
           FROM overtime_requests r
           JOIN overtime_request_approval_steps s ON s.request_id = r.id AND s.step_order = r.current_step_order AND s.route_version = r.current_route_version
           JOIN users u ON u.id = r.employee_id
          WHERE s.approver_user_id = ANY($1::uuid[]) AND s.status='PENDING'
          ORDER BY r.submitted_at`,
        [approverIds]
      );
      for (const r of rows) {
        const delegatedFromId = r.approver_user_id !== req.user!.userId ? r.approver_user_id : null;
        items.push({
          doc_type: "OVERTIME_REQUEST",
          id: r.id,
          status: "SUBMITTED",
          request_no: r.request_no,
          employee_name: r.employee_name,
          year: r.year,
          month: r.month,
          my_title: r.my_title,
          submitted_at: r.submitted_at,
          current_step_actionable_by_me: true,
          is_delegated: !!delegatedFromId,
          delegated_from_manager_name: delegatedFromId ? names.get(delegatedFromId) ?? null : null
        });
      }
    };

    const loadOvertimeClaimItems = async () => {
      const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "OVERTIME_CLAIM");
      const approverIds = [req.user!.userId, ...delegatedFor];
      const names = await nameMapFor(delegatedFor);
      const rows = await query<any>(
        `SELECT c.id, c.claim_no, c.year, c.month, c.submitted_at, c.total_amount, c.converted_hours,
                u.full_name AS employee_name, s.title AS my_title, s.approver_user_id
           FROM overtime_claims c
           JOIN overtime_claim_approval_steps s ON s.claim_id = c.id AND s.step_order = c.current_step_order AND s.route_version = c.current_route_version
           JOIN users u ON u.id = c.employee_id
          WHERE s.approver_user_id = ANY($1::uuid[]) AND s.status='PENDING'
          ORDER BY c.submitted_at`,
        [approverIds]
      );
      for (const c of rows) {
        const delegatedFromId = c.approver_user_id !== req.user!.userId ? c.approver_user_id : null;
        items.push({
          doc_type: "OVERTIME_CLAIM",
          id: c.id,
          status: "SUBMITTED",
          claim_no: c.claim_no,
          employee_name: c.employee_name,
          year: c.year,
          month: c.month,
          converted_hours: Number(c.converted_hours || 0),
          total_amount: Number(c.total_amount || 0),
          my_title: c.my_title,
          submitted_at: c.submitted_at,
          current_step_actionable_by_me: true,
          is_delegated: !!delegatedFromId,
          delegated_from_manager_name: delegatedFromId ? names.get(delegatedFromId) ?? null : null
        });
      }
    };

    const loadStandbyClaimItems = async () => {
      const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "STANDBY_CLAIM");
      const approverIds = [req.user!.userId, ...delegatedFor];
      const names = await nameMapFor(delegatedFor);
      const rows = await query<any>(
        `SELECT sc.id, sc.claim_no, sc.claim_month, sc.submitted_at, sc.calculated_amount,
                u.full_name AS employee_name, sas.title AS my_title, sas.approver_user_id
           FROM standby_claims sc
           JOIN standby_approval_steps sas ON sas.claim_id = sc.id AND sas.step_order = sc.current_step_order AND sas.route_version = sc.current_route_version
           JOIN users u ON u.id = sc.employee_id
          WHERE sas.approver_user_id = ANY($1::uuid[]) AND sas.status='PENDING'
          ORDER BY sc.submitted_at`,
        [approverIds]
      );
      for (const sc of rows) {
        const delegatedFromId = sc.approver_user_id !== req.user!.userId ? sc.approver_user_id : null;
        items.push({
          doc_type: "STANDBY_CLAIM",
          id: sc.id,
          status: "SUBMITTED",
          claim_no: sc.claim_no,
          employee_name: sc.employee_name,
          claim_month: sc.claim_month,
          calculated_amount: Number(sc.calculated_amount || 0),
          my_title: sc.my_title,
          submitted_at: sc.submitted_at,
          current_step_actionable_by_me: true,
          is_delegated: !!delegatedFromId,
          delegated_from_manager_name: delegatedFromId ? names.get(delegatedFromId) ?? null : null
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
      await loadFinalStepApprovedAdvancesForUser(req.user!.userId);
      await loadWorkflowClaimsForUser();
      await loadViewOnlyCompletedItemsForUser();
    }
    await loadCaptureHistoryItems();
    await loadAccommodationItems();
    await loadCustomRequestsForUser();
    await loadSignableDocumentsForUser();
    await loadOvertimeRequestItems();
    await loadOvertimeClaimItems();
    await loadStandbyClaimItems();

    if (!rule) return res.json({ items: await withDatesNewestFirst(await stripUnviewableItems(items)) });

    // Load legacy (non-workflow) advances by status.
    // The ownership filter still applies so each role only sees their own dept advances.
    const loadAdvanceByStatus = async (status: string, advanceType?: string) => {
      const params: unknown[] = [status];
      let typeFilter = "";
      if (advanceType === "NON_LOAN") {
        typeFilter = ` AND ar.type <> 'LOAN'`;
      } else if (advanceType) {
        params.push(advanceType);
        typeFilter = ` AND ar.type = $${params.length}`;
      }
      // Exclude workflow-driven advances — those are handled by loadWorkflowAdvancesForUser.
      // APPROVED is the exception: workflow-driven advances leave the active-step
      // query once approved, but FINANCE/ADMIN still need to see them here to
      // mark them paid, so include workflow-driven advances for that status.
      let ownershipFilter = status === "APPROVED" ? "" : " AND ar.approval_chain IS NULL";
      if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
        params.push([req.user!.userId, ...delegatedManagerIds]);
        ownershipFilter += ` AND d.manager_user_id = ANY($${params.length}::uuid[])`;
      }
      if (role === "HOD" && status === "COUNTERSIGNED") {
        params.push(req.user!.userId);
        ownershipFilter += ` AND d.hod_user_id = $${params.length}`;
      }
      if (role === "EXCO" && status === "COUNTERSIGNED") {
        params.push(req.user!.userId);
        ownershipFilter += ` AND d.exco_user_id = $${params.length}`;
      }
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose,
                u.full_name AS requester_name, tt.currency,
                NULL::text AS current_step_approver_id,
                NULL::int  AS workflow_step_order
           FROM advance_requests ar
           JOIN users u ON u.id = ar.requester_id
           LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
           LEFT JOIN travel_types tt ON tt.code = ar.type
          WHERE ar.status = $1${typeFilter}${ownershipFilter}
          ORDER BY ar.created_at DESC`,
        params
      );
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
          currency: a.currency,
          workflow_step_order: a.workflow_step_order,
          current_step_approver_id: a.current_step_approver_id
        });
      }
    };

    const loadClaimByStatus = async (status: string) => {
      const params: unknown[] = [status];
      let ownershipFilter = "";
      if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
        params.push([req.user!.userId, ...delegatedManagerIds]);
        ownershipFilter = ` AND d.manager_user_id = ANY($${params.length}::uuid[])`;
      }
      // Exclude workflow-driven claims — those are handled by loadWorkflowClaimsForUser.
      // FINANCE_VERIFIED/PAYMENT_PROCESSING are the exception: workflow-driven
      // claims leave the active-step query once their chain completes, but
      // FINANCE/ADMIN still need to see them here to act on, so include them.
      if (status !== "FINANCE_VERIFIED" && status !== "PAYMENT_PROCESSING") {
        ownershipFilter += " AND c.approval_chain IS NULL";
      }
      const rows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, c.currency, u.full_name AS claimant_name
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
         WHERE c.status = $1${ownershipFilter}
         ORDER BY c.created_at DESC`,
        params
      );
      for (const c of rows) {
        items.push({
          doc_type: "CLAIM",
          id: c.id,
          status: c.status,
          claim_total: Number(c.claim_total),
          advance_amount: Number(c.advance_amount),
          balance_amount: Number(c.balance_amount),
          currency: c.currency,
          claimant_name: c.claimant_name
        });
      }
    };

    if (rule === "ALL") {
      // Workflow-driven advances/claims at any pending step (see comment
      // above these functions for why this is needed at all).
      await loadAllWorkflowAdvancesForAdmin();
      await loadAllWorkflowClaimsForAdmin();

      // Legacy (non-workflow) advances by status
      await loadAdvanceByStatus("SUBMITTED");
      await loadAdvanceByStatus("COUNTERSIGNED");
      await loadAdvanceByStatus("HR_OFFICER");
      await loadAdvanceByStatus("APPROVED");

      await loadClaimByStatus("MANAGER_APPROVED");
      await loadClaimByStatus("EXCO_APPROVED");
      await loadClaimByStatus("HR_OFFICER");
      await loadClaimByStatus("FINANCE_VERIFIED");
      await loadClaimByStatus("PAYMENT_PROCESSING");

      return res.json({ items: await withDatesNewestFirst(items) });
    }

    const rules = Array.isArray(rule) ? rule : [rule];
    for (const r of rules) {
      if (r.doc_type === "ADVANCE") {
        await loadAdvanceByStatus(r.status, r.advance_type);
      } else {
        await loadClaimByStatus(r.status);
      }
    }

    return res.json({ items: await withDatesNewestFirst(await stripUnviewableItems(items)) });
  } catch (err) {
    return next(err);
  }
});
