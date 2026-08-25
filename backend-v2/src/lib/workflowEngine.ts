import { query } from "./db.js";
import { getDepartmentLeadership } from "./departments.js";
import { isCompensationFinanceSection } from "./financeAuthority.js";
import { getUserGroups } from "./permissionGroups.js";
import { normalizeWorkflowRouteCode } from "./workflowRouting.js";
import type { AdvanceStatus } from "../modules/advances/advances.types.js";

export interface ChainStep {
  step_order: number;
  position_type_code: string;
  position_name: string;
  approver_id: string | null;
  // Every person assigned to this step — first to act satisfies it. Always
  // includes approver_id as its first element when non-empty; approver_id is
  // kept for readers (PDF signature blocks, SLA grouping, etc.) that only
  // need a single primary approver.
  approver_ids: string[];
  approver_name: string | null;
  approver_title: string | null;
  approver_email: string | null;
  // Per-person contact details for every id in approver_ids, in the same
  // order — lets notifications reach each assigned person individually
  // instead of only the primary approver_email. Optional so chains persisted
  // before this field existed still deserialize fine.
  approvers?: { id: string; name: string | null; email: string | null; title: string | null }[];
  required: boolean;
  final_approval: boolean;
  approval_mode: string;
  approval_group_name: string | null;
  requires_accommodation: boolean;
  parallel_with_previous: boolean;
  action_type: string;
  can_reject: boolean;
  can_rollback: boolean;
  approved?: boolean;
  // ISO timestamp set alongside `approved` when this step is actioned — only
  // present on steps approved after this field was introduced; older steps
  // have `approved: true` with no timestamp (see SLA reporting's "no_data" state).
  approved_at?: string;
}

// Shared by the advances and claims SLA-report endpoints.
export function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.round((diff / 3_600_000) * 10) / 10;
}

// Returns the contiguous "stage" of chain steps starting at stepIdx: the step
// at stepIdx plus any immediately-following steps flagged parallel_with_previous.
// All members of a stage become pending simultaneously and the chain only
// advances once every member has approved.
export function getPendingGroup(chain: ChainStep[], stepIdx: number): { indices: number[]; steps: ChainStep[] } {
  if (stepIdx >= chain.length) return { indices: [], steps: [] };
  let start = stepIdx;
  while (start > 0 && chain[start].parallel_with_previous) start--;
  const indices = [start];
  for (let i = start + 1; i < chain.length && chain[i].parallel_with_previous; i++) indices.push(i);
  return { indices, steps: indices.map((i) => chain[i]) };
}

// Mirrors getFallbackManagerId in reporting-lines.routes.ts: the requester's
// active reporting_lines manager, falling back to their department's
// leadership chain (HOD -> EXCO, MANAGER -> HOD/EXCO, everyone else ->
// MANAGER/HOD/EXCO) when no reporting_lines row exists yet.
export async function resolveRequesterManager(
  requesterId: string
): Promise<{ id: string; full_name: string | null; title: string | null; email: string | null } | null> {
  const lineRows = await query<{ manager_id: string | null }>(
    `SELECT manager_id FROM reporting_lines WHERE employee_id = $1 AND is_active = true LIMIT 1`,
    [requesterId]
  );
  let managerId = lineRows[0]?.manager_id ?? null;

  if (!managerId || managerId === requesterId) {
    const requesterRows = await query<{ role: string; department: string | null }>(
      `SELECT role::text AS role, department FROM users WHERE id = $1`,
      [requesterId]
    );
    const requesterUser = requesterRows[0];
    if (requesterUser?.department) {
      const leadership = await getDepartmentLeadership(requesterUser.department);
      if (requesterUser.role === "HOD") managerId = leadership.exco_user_id ?? null;
      else if (requesterUser.role === "MANAGER") managerId = leadership.hod_user_id ?? leadership.exco_user_id ?? null;
      else managerId = leadership.manager_user_id ?? leadership.hod_user_id ?? leadership.exco_user_id ?? null;
    }
  }

  if (!managerId || managerId === requesterId) return null;
  return (
    (await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
      `SELECT id, full_name, title, email FROM users WHERE id = $1 AND is_active = true`,
      [managerId]
    ))[0] ?? null
  );
}

export async function resolveWorkflowChain(params: {
  requestType: string;
  department: string;
  division?: string;
  section?: string;
  advanceSubType?: string;
  needsAccommodation?: boolean;
  overrideChain?: { label: string; user_id: string; user_name?: string }[];
  requesterRole?: string;
  requesterId?: string;
}): Promise<{ workflowId: string; chain: ChainStep[] } | null> {
  const { requestType, department, division = "", section = "", advanceSubType = "", needsAccommodation = false, overrideChain = [], requesterRole = "", requesterId = "" } = params;

  // TEMPORARY workflows (with a valid date window) take priority over STICKY ones.
  // A workflow restricted to the requester's role (requester_roles) always outranks
  // an unrestricted one. Within each tier the specificity order is:
  // dept+section+subtype > dept+subtype > dept+section > dept > global.
  //
  // The division filter (w.division) exists to stop a blank-department
  // workflow scoped to one division (e.g. a SEFS-wide travel catch-all) from
  // being picked up by a requester in a different division just because
  // their own department/section has no more specific workflow of its own -
  // a real incident: MNO employees whose department had a coverage gap were
  // silently routed through SEFS's workflows and approval chain instead of
  // failing loudly or falling back within their own division. A workflow
  // with no division set still matches everyone, same as blank department.
  const workflows = await query<{ id: string }>(
    `SELECT w.*
       FROM workflows w
      WHERE w.request_type = $1
        AND w.status = 'ACTIVE'
        AND (w.valid_from  IS NULL OR w.valid_from  <= now())
        AND (w.valid_until IS NULL OR w.valid_until >= now())
        AND (w.department IS NULL OR trim(w.department) = '' OR lower(trim(w.department)) = lower(trim($2)))
        AND (w.division IS NULL OR trim(w.division) = '' OR $6 = '' OR lower(trim(w.division)) = lower(trim($6)))
        AND (w.section IS NULL OR trim(w.section) = '' OR lower(trim(w.section)) = lower(trim($3)))
        AND (
          w.advance_sub_type IS NULL OR trim(w.advance_sub_type) = ''
          OR ($4 <> '' AND lower(trim(w.advance_sub_type)) = lower(trim($4)))
          -- "TRAVEL" sub-type covers all travel advance types (anything other than SALARY/LOAN)
          OR ($4 <> '' AND lower(trim(w.advance_sub_type)) = 'travel' AND upper(trim($4)) NOT IN ('SALARY','LOAN'))
        )
        AND (w.requester_roles IS NULL OR ($5 <> '' AND $5 = ANY(w.requester_roles)))
      ORDER BY
        -- TEMPORARY workflows override STICKY ones
        CASE COALESCE(w.workflow_type,'STICKY') WHEN 'TEMPORARY' THEN 0 ELSE 1 END,
        -- A role-restricted workflow (which already passed the WHERE filter, so it
        -- matches the requester) outranks an unrestricted one.
        CASE WHEN w.requester_roles IS NOT NULL THEN 0 ELSE 1 END,
        -- A division-scoped workflow outranks a division-blank (fully global) one,
        -- same idea as department specificity below.
        CASE WHEN $6 <> '' AND lower(trim(COALESCE(w.division,''))) = lower(trim($6)) THEN 0 ELSE 1 END,
        -- Then by specificity (most specific wins)
        CASE
          WHEN $4 <> '' AND lower(trim(COALESCE(w.advance_sub_type,''))) = lower(trim($4))
               AND lower(trim(COALESCE(w.section,''))) = lower(trim($3))
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 0
          WHEN $4 <> '' AND lower(trim(COALESCE(w.advance_sub_type,''))) = lower(trim($4))
               AND (w.section IS NULL OR trim(w.section) = '')
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 1
          -- "TRAVEL" sub-type matches any non-SALARY/LOAN advance type, ranked just below an exact sub-type match
          WHEN $4 <> '' AND upper(trim($4)) NOT IN ('SALARY','LOAN') AND lower(trim(COALESCE(w.advance_sub_type,''))) = 'travel'
               AND lower(trim(COALESCE(w.section,''))) = lower(trim($3))
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 2
          WHEN $4 <> '' AND upper(trim($4)) NOT IN ('SALARY','LOAN') AND lower(trim(COALESCE(w.advance_sub_type,''))) = 'travel'
               AND (w.section IS NULL OR trim(w.section) = '')
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 3
          WHEN (w.advance_sub_type IS NULL OR trim(w.advance_sub_type) = '')
               AND lower(trim(COALESCE(w.section,''))) = lower(trim($3))
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 4
          WHEN (w.advance_sub_type IS NULL OR trim(w.advance_sub_type) = '')
               AND (w.section IS NULL OR trim(w.section) = '')
               AND lower(trim(COALESCE(w.department,''))) = lower(trim($2)) THEN 5
          ELSE 6
        END,
        w.updated_at DESC, w.created_at DESC
      LIMIT 1`,
    [requestType, department, section, advanceSubType, requesterRole, division]
  );

  const workflow = workflows[0];
  if (!workflow) return null;

  const steps = await query<{
    step_order: number;
    position_type_code: string | null;
    position_name: string;
    assigned_user_id: string | null;
    assigned_user_name: string | null;
    assigned_user_title: string | null;
    assigned_user_email: string | null;
    assigned_user_ids: string[] | null;
    is_required: boolean;
    skip_if_unassigned: boolean;
    is_final_approval: boolean;
    approval_mode: string;
    approval_group_name: string | null;
    requires_accommodation: boolean;
    parallel_with_previous: boolean;
    action_type: string;
    can_reject: boolean;
    can_rollback: boolean;
  }>(
    `SELECT ws.step_order, ws.position_type_code, ws.position_name,
            CASE WHEN u.id IS NOT NULL THEN ws.assigned_user_id ELSE NULL END AS assigned_user_id,
            u.full_name AS assigned_user_name, u.title AS assigned_user_title, u.email AS assigned_user_email,
            -- Only keep still-active assigned users, same as the single-id CASE above.
            ARRAY(SELECT au.id FROM users au WHERE au.id = ANY(ws.assigned_user_ids) AND au.is_active = true) AS assigned_user_ids,
            ws.is_required, ws.skip_if_unassigned, ws.is_final_approval,
            ws.approval_mode, ws.approval_group_name, ws.requires_accommodation, ws.parallel_with_previous, ws.action_type,
            ws.can_reject, ws.can_rollback
       FROM workflow_steps ws
       LEFT JOIN users u ON u.id = ws.assigned_user_id AND u.is_active = true
      WHERE ws.workflow_id = $1 AND ws.is_active = true
      ORDER BY ws.step_order ASC`,
    [(workflow as any).id]
  );
  const allAssignedIds = Array.from(new Set(steps.flatMap((step) => step.assigned_user_ids || [])));
  const assignedUserMap = allAssignedIds.length
    ? new Map((await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
        `SELECT id, full_name, title, email FROM users WHERE id = ANY($1::uuid[])`,
        [allAssignedIds]
      )).map((u) => [u.id, u]))
    : new Map<string, { id: string; full_name: string | null; title: string | null; email: string | null }>();
  // HR steps are routed to the org-structure leadership of the
  // "Human Resource" department, not the requester's own department.
  const hasHrStep = steps.some((step) => normalizeWorkflowRouteCode(step.position_type_code, step.position_name).startsWith("HR_"));
  const hrLeadership = hasHrStep ? await getDepartmentLeadership("Human Resource") : null;

  // A plain (non-ANY_ONE-group) EXCO step with no fixed assigned_user_id
  // routes to whichever EXCO member's own users.department matches the
  // REQUESTER's department (e.g. an HOD's request goes to their own
  // department's EXCO/GM) - one workflow covers every department instead of
  // needing a hand-built copy per department. Resolves to no approver if
  // that department has no EXCO member set up yet.
  const hasDeptExcoStep = steps.some((step) => {
    const stepCode = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);
    return stepCode === "EXCO" && !step.assigned_user_ids?.length && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
  });
  const deptExco = hasDeptExcoStep && department.trim()
    ? (await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
        `SELECT id, full_name, title, email FROM users WHERE role = 'EXCO' AND is_active = true AND lower(trim(department)) = lower(trim($1)) LIMIT 1`,
        [department]
      ))[0] ?? null
    : null;

  // A plain (non-ANY_ONE-group) MANAGER or HOD step with no fixed
  // assigned_user_id routes to the REQUESTER's own manager (reporting_lines,
  // falling back to department leadership the same way getFallbackManagerId
  // in reporting-lines.routes.ts does when no reporting_lines row exists
  // yet). HOD is included here because a requester's reporting_lines
  // manager is very often the person holding the HOD title for their
  // section — e.g. a MANAGER-role requester whose manager is an HOD; a
  // step explicitly assigned to specific people always wins over this.
  // Without this, a single company-wide workflow (e.g. the one Clearance
  // workflow covering every department) can never resolve its Manager/HOD
  // step for anybody, silently stranding every submission at that step.
  const hasDeptManagerStep = steps.some((step) => {
    const stepCode = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);
    return (stepCode === "MANAGER" || stepCode === "HOD") && !step.assigned_user_ids?.length && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
  });
  const requesterManager = hasDeptManagerStep && requesterId ? await resolveRequesterManager(requesterId) : null;

  // Requester-chosen overrides (e.g. a CEO/EXCO/MANAGER picking their own
  // countersigner/approver for a travel advance) replace the position's
  // template-driven approver. Matched by the step's action_type, not its
  // label text — "Counter Signed By" overrides any COUNTER_SIGN step,
  // "Approved By" overrides any APPROVE step.
  const overrideUsers = overrideChain.length
    ? await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
        `SELECT id, full_name, title, email FROM users WHERE id = ANY($1)`,
        [overrideChain.map((o) => o.user_id)]
      )
    : [];
  const OVERRIDE_LABEL_TO_ACTION_TYPE: Record<string, string> = {
    "counter signed by": "COUNTER_SIGN",
    "approved by": "APPROVE"
  };
  const overrideByActionType = new Map(
    overrideChain.map((o) => [
      OVERRIDE_LABEL_TO_ACTION_TYPE[o.label.trim().toLowerCase()] || o.label.trim().toUpperCase(),
      overrideUsers.find((u) => u.id === o.user_id)
    ])
  );

  const chain: ChainStep[] = [];
  let previousStepPushed = false;
  // Tracks whether a MANAGER step already dynamically resolved to
  // requesterManager earlier in this chain - a later dynamic HOD step must
  // not resolve to that same person again (see secondLevelManager below).
  let dynamicManagerAlreadyResolved = false;
  let secondLevelManager: Awaited<ReturnType<typeof resolveRequesterManager>> | undefined;
  for (const step of steps) {
    const code = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);

    // EMPLOYEE represents the requester, not an approver — exclude from the approval chain.
    if (code === "EMPLOYEE") { previousStepPushed = false; continue; }

    // A step flagged as accommodation-only is skipped unless this request needs accommodation.
    if (step.requires_accommodation && !needsAccommodation) { previousStepPushed = false; continue; }

    // A requester-chosen override for this step's action type replaces the
    // assigned user entirely (e.g. CEO/EXCO/MANAGER picking their own
    // countersigner/approver for a travel advance).
    const override = overrideByActionType.get(step.action_type);

    // HOD and MANAGER steps with no explicit assignee resolve dynamically to
    // the requester's own reporting_lines manager (see requesterManager
    // above) — an explicitly assigned step always wins over this. HR_* steps
    // still route to the Human Resource department's leadership; plain EXCO
    // steps route to the requester's own department's EXCO member (see
    // deptExco above).
    const isHrCode = code.startsWith("HR_");
    const isDeptExcoCode = code === "EXCO" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
    const isDeptManagerCode = code === "MANAGER" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
    const isDeptHodCode = code === "HOD" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
    const hasFixedAssignees = !!step.assigned_user_ids?.length;

    // A chain with a distinct earlier MANAGER step already used
    // requesterManager - resolving HOD to that same person would put the
    // same approver on two consecutive steps, so escalate one level further
    // up the reporting line instead (lazily resolved and cached).
    let hodManager = requesterManager;
    if (isDeptHodCode && dynamicManagerAlreadyResolved && requesterManager) {
      if (secondLevelManager === undefined) secondLevelManager = await resolveRequesterManager(requesterManager.id);
      hodManager = secondLevelManager;
    }

    // Multiple people can be assigned to one step — whoever acts first
    // satisfies it. The other resolution paths (HR leadership, dept EXCO/
    // Manager lookup, requester override) only ever resolve to a single
    // person, so they stay single-element arrays.
    const approverIds: string[] =
      override               ? (override.id ? [override.id] : []) :
      hasFixedAssignees      ? step.assigned_user_ids! :
      isHrCode               ? (hrLeadership?.hod_user_id ? [hrLeadership.hod_user_id] : hrLeadership?.manager_user_id ? [hrLeadership.manager_user_id] : []) :
      isDeptExcoCode          ? (deptExco?.id ? [deptExco.id] : []) :
      isDeptManagerCode       ? (requesterManager?.id ? [requesterManager.id] : []) :
      isDeptHodCode           ? (hodManager?.id ? [hodManager.id] : []) :
                                [];
    const approverId = approverIds[0] ?? null;
    if (isDeptManagerCode && approverId) dynamicManagerAlreadyResolved = true;

    const approverName =
      override               ? override.full_name :
      hasFixedAssignees      ? approverIds.map((id) => assignedUserMap.get(id)?.full_name || assignedUserMap.get(id)?.email).filter(Boolean).join(", ") || null :
      isHrCode               ? (hrLeadership?.hod_name ?? hrLeadership?.manager_name ?? null) :
      isDeptExcoCode          ? (deptExco?.full_name ?? null) :
      isDeptManagerCode       ? (requesterManager?.full_name ?? null) :
      isDeptHodCode           ? (hodManager?.full_name ?? null) :
                                null;

    const approverTitle =
      override               ? override.title :
      hasFixedAssignees      ? (assignedUserMap.get(approverId || "")?.title ?? null) :
      isHrCode               ? (hrLeadership?.hod_title ?? hrLeadership?.manager_title ?? null) :
      isDeptExcoCode          ? (deptExco?.title ?? null) :
      isDeptManagerCode       ? (requesterManager?.title ?? null) :
      isDeptHodCode           ? (hodManager?.title ?? null) :
                                null;

    const approverEmail =
      override               ? override.email :
      hasFixedAssignees      ? (assignedUserMap.get(approverId || "")?.email ?? null) :
      isHrCode               ? (hrLeadership?.hod_email ?? hrLeadership?.manager_email ?? null) :
      isDeptExcoCode          ? (deptExco?.email ?? null) :
      isDeptManagerCode       ? (requesterManager?.email ?? null) :
      isDeptHodCode           ? (hodManager?.email ?? null) :
                                null;

    // Group steps (ANY_ONE with approval_group_name) are never "unassigned" —
    // they're routed to whoever belongs to the group, not a specific individual.
    const isGroupStep = step.approval_mode === "ANY_ONE" && !!step.approval_group_name;
    if (!approverId && step.skip_if_unassigned && !isGroupStep) { previousStepPushed = false; continue; }

    const positionLabel = step.position_name;

    // Per-person contact details, in the same order as approverIds — the
    // fixed-assignee path can have more than one; every other path resolves
    // to at most one person, reusing the single name/title/email already computed.
    const approvers = hasFixedAssignees
      ? approverIds.map((id) => ({
          id,
          name: assignedUserMap.get(id)?.full_name ?? null,
          email: assignedUserMap.get(id)?.email ?? null,
          title: assignedUserMap.get(id)?.title ?? null
        }))
      : approverId
      ? [{ id: approverId, name: approverName ?? null, email: approverEmail ?? null, title: approverTitle ?? null }]
      : [];

    chain.push({
      step_order: step.step_order,
      position_type_code: code,
      position_name: positionLabel,
      approver_id: approverId,
      approver_ids: approverIds,
      approvers,
      approver_name: approverName ?? null,
      approver_title: approverTitle ?? null,
      approver_email: approverEmail ?? null,
      required: step.is_required,
      final_approval: step.is_final_approval,
      approval_mode: step.approval_mode || "SINGLE",
      approval_group_name: step.approval_group_name ?? null,
      requires_accommodation: step.requires_accommodation,
      parallel_with_previous: (step.parallel_with_previous ?? false) && previousStepPushed,
      action_type: step.action_type || "APPROVE",
      can_reject: step.can_reject ?? true,
      can_rollback: step.can_rollback ?? true
    });
    previousStepPushed = true;
  }

  return { workflowId: (workflow as any).id, chain };
}

// Maps workflow position_type_code to advance_requests.status for the given step.
export function chainStepToStatus(chain: ChainStep[], stepIndex: number): AdvanceStatus {
  const step = chain[stepIndex];
  if (!step) return "SUBMITTED";

  if (step.position_type_code.startsWith("HR_")) return "HR_OFFICER";

  switch (step.position_type_code) {
    case "MANAGER":      return "SUBMITTED";
    // HOD/EXCO/CEO steps all come after the initial Manager step, so they
    // share the "COUNTERSIGNED" bucket rather than EXCO/CEO falling through
    // to the default and looking identical to a request that was *just*
    // submitted (AdvanceStatus is a small closed enum — there's no separate
    // bucket per position, only "how far along" it roughly is).
    case "HOD":
    case "EXCO":
    case "CEO":           return "COUNTERSIGNED";
    case "FINANCE":      return "HR_OFFICER";
    default:             return "SUBMITTED";
  }
}

// Returns true if userId/userRole is permitted to act on the given workflow step.
// delegatedManagerIds are the manager_ids the current user is acting on behalf
// of - a delegate can hold more than one active delegation at once.
export async function canApproveStep(
  step: ChainStep,
  userId: string,
  userRole: string,
  delegatedManagerIds?: string[] | null,
  userSectionId?: string | null
): Promise<boolean> {
  // ANY_ONE steps (e.g. "Team: X", "Section: X", or "Department: X") can be
  // actioned by any member of the named permission group, regardless of who
  // the step's approver_id is. These org-unit groups are scoped to officers —
  // HOD/Manager already have their own dedicated steps, so they don't
  // double-dip on the group's ANY_ONE step.
  if (step.approval_mode === "ANY_ONE" && step.approval_group_name) {
    const ORG_UNIT_PREFIXES = ["Team: ", "Section: ", "Department: "];
    const isOrgUnitGroup = ORG_UNIT_PREFIXES.some((p) => step.approval_group_name!.startsWith(p));
    const isManagementRole = userRole === "HOD" || userRole === "MANAGER";
    // HOD/Manager never act on these org-unit steps, even if they also
    // happen to be the step's approver_id via department-leadership lookup.
    if (isOrgUnitGroup && isManagementRole) return false;
    const groups = await getUserGroups(userId);
    if (groups.includes(step.approval_group_name)) return true;
  }
  if (step.approver_id) {
    // A step can have more than one assigned person — first to act
    // satisfies it, so any of them (or anyone delegating for any of them)
    // can act.
    const assignedIds = step.approver_ids?.length ? step.approver_ids : [step.approver_id];
    if (assignedIds.includes(userId)) return true;
    // Delegation: allow if acting on behalf of any of the assigned approvers
    // delegating to this user, whatever their position type - delegation
    // eligibility (Manager/HOD/Exco/CEO) is already enforced when the
    // delegation itself is created.
    if (delegatedManagerIds?.some((id) => assignedIds.includes(id))) return true;
    return false;
  }
  // No specific approver resolved via org structure — FINANCE is based on
  // the admin-assigned is_compensation_finance flag on the user's section
  // (see financeAuthority.ts), not a free-text department name; everything
  // else has no role-based fallback. A step with no org-structure approver
  // simply has no one who can act on it until it's assigned a person or
  // department.
  if (step.position_type_code === "FINANCE") return isCompensationFinanceSection(userSectionId);
  return false;
}
