import { query, withTransaction } from "./db.js";
import { getDepartmentLeadership, getSectionLeadership, getTeamLeadership } from "./departments.js";
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
  // Narrows a wider candidate pool (approval_group_name's live members, or a
  // multi-id approver_ids roster) down to the one person who may actually
  // ACT on this step, picked round-robin at chain-build time (see
  // pickRoundRobinAssignee). Every other candidate can still VIEW the step
  // (see isRoundRobinCandidate) but canApproveStep rejects them. Absent on
  // every step that isn't round-robin-restricted, including all chains
  // built before this field existed — fully backward compatible.
  assigned_user_id?: string | null;
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

// Used by approval maintenance after a workflow definition changes. Unlike
// getPendingGroup (the stage actionable right now), this includes every
// future step whose decision has not been recorded yet, so changing a future
// EXCO step to HOD is propagated before the request reaches it.
export function getUnapprovedStepIndices(chain: ChainStep[], stepIdx: number): number[] {
  return chain
    .map((step, idx) => ({ step, idx }))
    .filter(({ step, idx }) => idx >= stepIdx && !step.approved)
    .map(({ idx }) => idx);
}

// A requires_accommodation step is parallel_with_previous and non-blocking
// (see advanceWorkflowStep's lateAccommodationIdx handling in
// advances.service.ts) - the chain's workflow_step_order pointer can move
// past it once Capture/payment complete, even though it's still unbooked.
// Callers that need to know "does this advance still need an accommodation
// booking" must scan the whole chain, not just getPendingGroup's window
// around the current pointer.
export function findPendingAccommodationStep(chain: ChainStep[]): { index: number; step: ChainStep } | null {
  const index = chain.findIndex((s) => s.requires_accommodation && !s.approved);
  return index === -1 ? null : { index, step: chain[index] };
}

// Mirrors getFallbackManagerId in reporting-lines.routes.ts: the requester's
// active reporting_lines manager, falling back to the closest available
// leadership when no reporting_lines row exists yet - their TEAM's
// leadership first (users.team_id, the UI's "Section" field - the closest
// possible org unit, e.g. Operations now has a distinct MANAGER per team:
// Transmission, NOC, IP Core Network, Network Quality, so matching on team
// finds the right one instead of picking arbitrarily among all of them),
// then their SECTION's (users.section_id, the UI's "Department" field - a
// broader unit, e.g. Technical's four sections each have their own real
// HOD), then their department's, as a broader last resort. Same HOD -> EXCO
// / MANAGER -> HOD/EXCO / everyone else -> MANAGER/HOD/EXCO chain at each
// level.
export async function resolveRequesterManager(
  requesterId: string
): Promise<{ id: string; full_name: string | null; title: string | null; email: string | null; role: string } | null> {
  const lineRows = await query<{ manager_id: string | null }>(
    `SELECT manager_id FROM reporting_lines WHERE employee_id = $1 AND is_active = true LIMIT 1`,
    [requesterId]
  );
  let managerId = lineRows[0]?.manager_id ?? null;

  if (!managerId || managerId === requesterId) {
    const requesterRows = await query<{ role: string; department: string | null; section_id: string | null; team_id: string | null }>(
      `SELECT role::text AS role, department, section_id, team_id FROM users WHERE id = $1`,
      [requesterId]
    );
    const requesterUser = requesterRows[0];
    const fallbackId = (leadership: { hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null }) => {
      if (requesterUser!.role === "HOD") return leadership.exco_user_id ?? null;
      if (requesterUser!.role === "MANAGER") return leadership.hod_user_id ?? leadership.exco_user_id ?? null;
      return leadership.manager_user_id ?? leadership.hod_user_id ?? leadership.exco_user_id ?? null;
    };
    if (requesterUser?.team_id) {
      managerId = fallbackId(await getTeamLeadership(requesterUser.team_id));
    }
    if ((!managerId || managerId === requesterId) && requesterUser?.section_id) {
      managerId = fallbackId(await getSectionLeadership(requesterUser.section_id));
    }
    if ((!managerId || managerId === requesterId) && requesterUser?.department) {
      managerId = fallbackId(await getDepartmentLeadership(requesterUser.department));
    }
  }

  if (!managerId || managerId === requesterId) return null;
  return (
    (await query<{ id: string; full_name: string | null; title: string | null; email: string | null; role: string }>(
      `SELECT id, full_name, title, email, role::text AS role FROM users WHERE id = $1 AND is_active = true`,
      [managerId]
    ))[0] ?? null
  );
}

// Resolve the actual HOD tier for a requester, rather than treating a HOD
// workflow step as another name for the requester's immediate manager. Walk
// the reporting line until a HOD is reached; EXCO is the valid fallback when
// the org unit has no HOD. This makes a workflow changed from MANAGER to HOD
// route above a MANAGER such as Mothibe instead of remaining with them.
export async function resolveRequesterHod(
  requesterId: string
): Promise<{ id: string; full_name: string | null; title: string | null; email: string | null; role: string } | null> {
  const seen = new Set<string>([requesterId]);
  let currentId = requesterId;
  for (let depth = 0; depth < 12; depth++) {
    const candidate = await resolveRequesterManager(currentId);
    if (!candidate || seen.has(candidate.id)) return null;
    if (candidate.role === "HOD" || candidate.role === "EXCO" || candidate.role === "CEO") return candidate;
    seen.add(candidate.id);
    currentId = candidate.id;
  }
  return null;
}

// The EXCO member for a given department (plain, non-ANY_ONE-group EXCO
// steps route here) — extracted so both the resolution-time step loop below
// and any later re-resolution (e.g. reassigning a pending step when an
// employee moves departments) use the exact same lookup.
//
// departments.exco_user_id is checked first - the actual maintained
// leadership assignment (e.g. ensureSefsExcoReportsToCeo sets it for every
// SEFS department to Moeketsi Mafereka, who himself sits at division level
// with no department underneath him). The plain users-table department-
// string match only ever finds an EXCO whose own users.department field
// happens to equal the target department - which fails for exactly this
// SEFS shape, silently leaving a "plain EXCO" step unresolvable even
// though the correct answer was sitting right there in departments.
export async function resolveDeptExco(
  department: string
): Promise<{ id: string; full_name: string | null; title: string | null; email: string | null } | null> {
  if (!department.trim()) return null;
  const viaDepartment = (await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
    `SELECT u.id, u.full_name, u.title, u.email
       FROM departments d JOIN users u ON u.id = d.exco_user_id
      WHERE lower(trim(d.name)) = lower(trim($1)) AND u.is_active = true LIMIT 1`,
    [department]
  ))[0];
  if (viaDepartment) return viaDepartment;
  return (
    (await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
      `SELECT id, full_name, title, email FROM users WHERE role = 'EXCO' AND is_active = true AND lower(trim(department)) = lower(trim($1)) LIMIT 1`,
      [department]
    ))[0] ?? null
  );
}

export async function resolveWorkflowChain(params: {
  requestType: string;
  department: string;
  division?: string;
  section?: string;
  team?: string;
  advanceSubType?: string;
  needsAccommodation?: boolean;
  overrideChain?: { label: string; user_id: string; user_name?: string }[];
  requesterRole?: string;
  requesterId?: string;
}): Promise<{ workflowId: string; chain: ChainStep[] } | null> {
  const { requestType, department, division = "", section = "", team = "", advanceSubType = "", needsAccommodation = false, overrideChain = [], requesterRole = "", requesterId = "" } = params;

  // TEMPORARY workflows (with a valid date window) take priority over STICKY ones.
  // A workflow restricted to the requester's role (requester_roles) always outranks
  // an unrestricted one. Below that, precedence is a strict scope hierarchy -
  // Team > Section > Department > Division > company-wide - the most specific
  // non-blank scope a workflow declares always wins, with sub-type
  // specificity (exact match > "TRAVEL" catch-all > unrestricted) only
  // breaking ties within the same scope tier, never overriding it. Every
  // candidate here already passed the WHERE clause below, so a workflow
  // with e.g. w.section set is a real, confirmed match for this requester's
  // own section, not just present - safe to always prefer over a broader
  // department/division/company-wide workflow regardless of sub-type.
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
        -- A workflow with no division set matches everyone (same as blank
        -- department below), but a workflow scoped to a SPECIFIC division
        -- must only match a requester actually in that division - a blank/
        -- unresolved requester division ($6='') must NOT wildcard-match it,
        -- or someone outside that division leaks into a division-only
        -- workflow (e.g. a SEFS-scoped travel workflow matching an MNO
        -- employee whenever their division came through blank).
        AND (w.division IS NULL OR trim(w.division) = '' OR lower(trim(w.division)) = lower(trim($6)))
        AND (w.section IS NULL OR trim(w.section) = '' OR lower(trim(w.section)) = lower(trim($3)))
        -- Same reasoning as w.division above: a workflow scoped to a specific
        -- team (the UI's "Section" field - Operations, for instance, has a
        -- distinct workflow per team: Transmission, NOC, IP Core Network,
        -- Network Quality) must only match a requester actually on that team,
        -- not wildcard-match everyone whenever the requester's own team came
        -- through blank.
        AND (w.team IS NULL OR trim(w.team) = '' OR lower(trim(w.team)) = lower(trim($7)))
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
        -- Scope precedence: Team > Section > Department > Division > company-wide.
        CASE
          WHEN w.team IS NOT NULL AND trim(w.team) <> '' THEN 0
          WHEN w.section IS NOT NULL AND trim(w.section) <> '' THEN 1
          WHEN w.department IS NOT NULL AND trim(w.department) <> '' THEN 2
          WHEN w.division IS NOT NULL AND trim(w.division) <> '' THEN 3
          ELSE 4
        END,
        -- Within the same scope tier: exact sub-type match > "TRAVEL"
        -- catch-all (any non-SALARY/LOAN type) > no sub-type restriction.
        CASE
          WHEN $4 <> '' AND lower(trim(COALESCE(w.advance_sub_type,''))) = lower(trim($4)) THEN 0
          WHEN $4 <> '' AND upper(trim($4)) NOT IN ('SALARY','LOAN') AND lower(trim(COALESCE(w.advance_sub_type,''))) = 'travel' THEN 1
          WHEN w.advance_sub_type IS NULL OR trim(w.advance_sub_type) = '' THEN 2
          ELSE 3
        END,
        w.updated_at DESC, w.created_at DESC
      LIMIT 1`,
    [requestType, department, section, advanceSubType, requesterRole, division, team]
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
  const deptExco = hasDeptExcoStep ? await resolveDeptExco(department) : null;

  // A plain (non-ANY_ONE-group) MANAGER step with no fixed assigned_user_id
  // routes to the REQUESTER's own manager (reporting_lines,
  // falling back to department leadership the same way getFallbackManagerId
  // in reporting-lines.routes.ts does when no reporting_lines row exists
  // yet). A HOD step walks that reporting line to the actual HOD tier; a
  // step explicitly assigned to specific people always wins over this.
  // Without this, a single company-wide workflow (e.g. the one Clearance
  // workflow covering every department) can never resolve its Manager/HOD
  // step for anybody, silently stranding every submission at that step.
  const hasDeptManagerStep = steps.some((step) => {
    const stepCode = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);
    return (stepCode === "MANAGER" || stepCode === "HOD") && !step.assigned_user_ids?.length && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
  });
  const requesterManager = hasDeptManagerStep && requesterId ? await resolveRequesterManager(requesterId) : null;
  const requesterHod = hasDeptManagerStep && requesterId ? await resolveRequesterHod(requesterId) : null;

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
  // The most recently pushed real APPROVE step's approver - lets the next
  // APPROVE step (regardless of tier: dynamic Manager/HOD, dept EXCO, or a
  // workflow-fixed pick) skip itself if it resolves to that same person,
  // rather than asking them to approve the same request twice in a row
  // (see approvalProgressStages in Inbox.tsx, which already only tracks
  // APPROVE steps for exactly this reason). Only tracked across APPROVE
  // steps - a DEPT_CAPTURE/MARK_PAID/DEPT_CLOSE step by the same person
  // right after their own approval is a distinct real action, not a
  // repeated decision, so it's left alone.
  let lastApproveApproverId: string | null = null;
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

    // MANAGER steps with no explicit assignee resolve dynamically to the
    // requester's direct reporting-lines manager; HOD steps resolve to the
    // actual HOD tier (see requesterManager/requesterHod above). HR_* steps
    // still route to the Human Resource department's leadership; plain EXCO
    // steps route to the requester's own department's EXCO member (see
    // deptExco above).
    const isHrCode = code.startsWith("HR_");
    const isDeptExcoCode = code === "EXCO" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);

    // An EXCO-role requester (e.g. a GM) submitting their own request would
    // otherwise resolve this step back to themselves - they're their own
    // department's EXCO member - which isn't a real second review. Skip the
    // step entirely rather than have someone approve their own request; the
    // CEO/Manager step above already covers their sign-off.
    if (isDeptExcoCode && requesterId && deptExco?.id === requesterId) { previousStepPushed = false; continue; }

    const isDeptManagerCode = code === "MANAGER" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
    const isDeptHodCode = code === "HOD" && !(step.approval_mode === "ANY_ONE" && step.approval_group_name);
    const hasFixedAssignees = !!step.assigned_user_ids?.length;

    // A chain with a distinct earlier MANAGER step already used
    // requesterManager - resolving HOD to that same person would put the
    // same approver on two consecutive steps, so escalate one level further
    // up the reporting line instead (lazily resolved and cached).
    let hodManager = requesterHod;
    if (isDeptHodCode && dynamicManagerAlreadyResolved && requesterManager && requesterHod?.id === requesterManager.id) {
      if (secondLevelManager === undefined) secondLevelManager = await resolveRequesterManager(requesterHod.id);
      hodManager = secondLevelManager;
    }

    // A step whose approver is a FIXED, single named pick in the workflow
    // (e.g. a specific EXCO hardcoded on this step) is a deliberate choice
    // by whoever built the workflow, not a coincidental repeat - even if an
    // earlier dynamic step (Manager/HOD) happens to resolve to that same
    // person (e.g. a small department where the only escalation target for
    // both tiers is the same GM), the fixed pick is trusted as-is and the
    // chain doesn't escalate past it looking for a "different" approver.

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

    // Same person, same kind of decision, back to back - not a real second
    // review. Applies regardless of how each side resolved (dynamic lookup
    // or a workflow-fixed pick): e.g. a small department with no HOD, whose
    // Manager-tier fallback and whose EXCO are the same one person.
    if (step.action_type === "APPROVE" && approverId && approverId === lastApproveApproverId) {
      previousStepPushed = false;
      continue;
    }

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

    // HR Operations handles accommodation booking and clearance closing as
    // an operational queue, not a group sign-off - every member should still
    // see these in their inbox, but only one person should actually own each
    // one, spread round-robin rather than left as "any of three people, race
    // to act" (which is how every other ANY_ONE group step still works).
    let assignedUserId: string | null = null;
    if (isGroupStep && step.approval_group_name === "Section: Human Resources Operations" && step.requires_accommodation) {
      const candidates = await resolveGroupMemberIds(step.approval_group_name);
      assignedUserId = await pickRoundRobinAssignee("accommodation_hr_ops", candidates);
    } else if (step.action_type === "DEPT_CLOSE" && hasFixedAssignees && approverIds.length > 1) {
      assignedUserId = await pickRoundRobinAssignee("clearance_close_hr_ops", approverIds);
    }

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
      can_rollback: step.can_rollback ?? true,
      assigned_user_id: assignedUserId
    });
    previousStepPushed = true;
    if (step.action_type === "APPROVE") lastApproveApproverId = approverId;
  }

  return { workflowId: (workflow as any).id, chain };
}

// Synthesizes a 4-step chain for a requester whose department/section has no
// configured workflow at all - used only when resolveWorkflowChain returns
// null and the requester has supplied exactly two named approvers via the
// "Custom Approval Chain" fallback (see advances.routes.ts /:id/submit).
// Ends in the same Treasury capture/mark-paid group steps every real
// workflow uses (group-resolved via getUserGroups, same mechanism
// canApproveStep already relies on for every ANY_ONE step - no hardcoded
// user ids), so the request flows through the identical downstream
// inbox/payment machinery as any normally-routed one.
export async function buildAdHocChain(
  overrideChain: { label: string; user_id: string; user_name?: string }[]
): Promise<ChainStep[]> {
  const counterSigner = overrideChain.find((o) => o.label === "Counter Signed By");
  const approver = overrideChain.find((o) => o.label === "Approved By");
  if (!counterSigner || !approver) return [];

  const users = await query<{ id: string; full_name: string | null; title: string | null; email: string | null }>(
    `SELECT id, full_name, title, email FROM users WHERE id = ANY($1) AND is_active = true`,
    [[counterSigner.user_id, approver.user_id]]
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const counterSignerUser = byId.get(counterSigner.user_id);
  const approverUser = byId.get(approver.user_id);
  if (!counterSignerUser || !approverUser) return [];

  const namedStep = (
    stepOrder: number,
    positionTypeCode: string,
    positionName: string,
    actionType: string,
    u: { id: string; full_name: string | null; title: string | null; email: string | null },
    finalApproval: boolean
  ): ChainStep => ({
    step_order: stepOrder,
    position_type_code: positionTypeCode,
    position_name: positionName,
    approver_id: u.id,
    approver_ids: [u.id],
    approver_name: u.full_name,
    approver_title: u.title,
    approver_email: u.email,
    approvers: [{ id: u.id, name: u.full_name, email: u.email, title: u.title }],
    required: true,
    final_approval: finalApproval,
    approval_mode: "SINGLE",
    approval_group_name: null,
    requires_accommodation: false,
    parallel_with_previous: false,
    action_type: actionType,
    can_reject: true,
    can_rollback: true
  });

  const treasuryStep = (stepOrder: number, actionType: string): ChainStep => ({
    step_order: stepOrder,
    position_type_code: "MANAGER",
    position_name: "Team: Treasury & Financial Accounting",
    approver_id: null,
    approver_ids: [],
    approver_name: null,
    approver_title: null,
    approver_email: null,
    approvers: [],
    required: true,
    final_approval: false,
    approval_mode: "ANY_ONE",
    approval_group_name: "Team: Treasury & Financial Accounting",
    requires_accommodation: false,
    parallel_with_previous: false,
    action_type: actionType,
    can_reject: true,
    can_rollback: true
  });

  return [
    namedStep(0, "MANAGER", "Counter Signed By", "COUNTER_SIGN", counterSignerUser, false),
    namedStep(1, "EXCO", "Approved By", "APPROVE", approverUser, true),
    treasuryStep(2, "DEPT_CAPTURE"),
    treasuryStep(3, "MARK_PAID")
  ];
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
  // A round-robin-restricted step (see pickRoundRobinAssignee) narrows a
  // wider candidate pool down to one specific person - every other
  // candidate can still VIEW the step (see isRoundRobinCandidate) but only
  // the assigned one may act. Checked first so it overrides both the group
  // and fixed-roster branches below rather than needing to duplicate this
  // guard in each of them.
  if (step.assigned_user_id) {
    if (userId === step.assigned_user_id) return true;
    if (delegatedManagerIds?.includes(step.assigned_user_id)) return true;
    return false;
  }
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

// For a round-robin-restricted step (assigned_user_id set), everyone else in
// the wider candidate pool should still see it in their inbox read-only,
// rather than it vanishing for them the moment they're not the one picked.
// canApproveStep alone can't answer that (it deliberately rejects everyone
// but the assigned person now) - this checks the underlying pool instead:
// live group membership for a "Section:/Team:/Department: X" step, or the
// fixed approver_ids roster otherwise.
export async function isRoundRobinCandidate(step: ChainStep, userId: string, userRole: string): Promise<boolean> {
  if (!step.assigned_user_id) return false;
  if (step.approval_mode === "ANY_ONE" && step.approval_group_name) {
    const ORG_UNIT_PREFIXES = ["Team: ", "Section: ", "Department: "];
    const isOrgUnitGroup = ORG_UNIT_PREFIXES.some((p) => step.approval_group_name!.startsWith(p));
    if (isOrgUnitGroup && (userRole === "HOD" || userRole === "MANAGER")) return false;
    const groups = await getUserGroups(userId);
    return groups.includes(step.approval_group_name);
  }
  return (step.approver_ids || []).includes(userId);
}

// Live member ids of a "Section: X" or "Team: X" group, for picking a
// round-robin assignee at chain-build time. Mirrors getUserGroups's own
// section/team join and canApproveStep's HOD/MANAGER exclusion for org-unit
// groups, so the candidate pool always matches who could actually act on
// the step.
async function resolveGroupMemberIds(groupName: string): Promise<string[]> {
  const sectionMatch = groupName.startsWith("Section: ") ? groupName.slice("Section: ".length) : null;
  const teamMatch = groupName.startsWith("Team: ") ? groupName.slice("Team: ".length) : null;
  if (!sectionMatch && !teamMatch) return [];
  const rows = await query<{ id: string }>(
    sectionMatch
      ? `SELECT DISTINCT u.id FROM users u
           LEFT JOIN teams t ON t.id = u.team_id
           LEFT JOIN sections s ON s.id = COALESCE(u.section_id, t.section_id)
          WHERE s.name = $1 AND u.is_active = true AND u.role NOT IN ('MANAGER','HOD')
          ORDER BY u.id`
      : `SELECT DISTINCT u.id FROM users u JOIN teams t ON t.id = u.team_id
          WHERE t.name = $1 AND u.is_active = true AND u.role NOT IN ('MANAGER','HOD')
          ORDER BY u.id`,
    [sectionMatch ?? teamMatch]
  );
  return rows.map((r) => r.id);
}

let roundRobinTableEnsured = false;
async function ensureRoundRobinTable() {
  if (roundRobinTableEnsured) return;
  await query(
    `CREATE TABLE IF NOT EXISTS round_robin_state (
       rotation_key text PRIMARY KEY,
       last_assigned_user_id uuid,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
    []
  );
  roundRobinTableEnsured = true;
}

// Picks the next candidate after whichever one this rotation_key last
// assigned, wrapping around - so repeat work (e.g. every advance needing an
// HR Operations accommodation booking) spreads evenly across the pool
// instead of always landing on whoever's first alphabetically or however
// the group happens to be ordered. Locks the state row for the duration of
// the pick so two chains resolving concurrently don't both land on the same
// person.
export async function pickRoundRobinAssignee(rotationKey: string, candidateIds: string[]): Promise<string | null> {
  if (!candidateIds.length) return null;
  if (candidateIds.length === 1) return candidateIds[0];
  await ensureRoundRobinTable();
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ last_assigned_user_id: string | null }>(
      `SELECT last_assigned_user_id FROM round_robin_state WHERE rotation_key=$1 FOR UPDATE`,
      [rotationKey]
    );
    const lastId = rows[0]?.last_assigned_user_id ?? null;
    const lastIdx = lastId ? candidateIds.indexOf(lastId) : -1;
    const nextId = candidateIds[(lastIdx + 1) % candidateIds.length];
    await client.query(
      `INSERT INTO round_robin_state (rotation_key, last_assigned_user_id, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (rotation_key) DO UPDATE SET last_assigned_user_id=$2, updated_at=now()`,
      [rotationKey, nextId]
    );
    return nextId;
  });
}
