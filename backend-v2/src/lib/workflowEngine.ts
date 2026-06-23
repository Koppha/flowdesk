import { query } from "./db.js";
import { getDepartmentLeadership } from "./departments.js";
import { isFinanceDept } from "./auth.js";
import { getUserGroups } from "./permissionGroups.js";
import { normalizeWorkflowRouteCode } from "./workflowRouting.js";
import type { AdvanceStatus } from "../modules/advances/advances.types.js";

export interface ChainStep {
  step_order: number;
  position_type_code: string;
  position_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_title: string | null;
  approver_email: string | null;
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

export async function resolveWorkflowChain(params: {
  requestType: string;
  department: string;
  section?: string;
  advanceSubType?: string;
  needsAccommodation?: boolean;
}): Promise<{ workflowId: string; chain: ChainStep[] } | null> {
  const { requestType, department, section = "", advanceSubType = "", needsAccommodation = false } = params;

  // TEMPORARY workflows (with a valid date window) take priority over STICKY ones.
  // Within each type the specificity order is: dept+section+subtype > dept+subtype > dept+section > dept > global.
  const workflows = await query<{ id: string }>(
    `SELECT w.*
       FROM workflows w
      WHERE w.request_type = $1
        AND w.status = 'ACTIVE'
        AND (w.valid_from  IS NULL OR w.valid_from  <= now())
        AND (w.valid_until IS NULL OR w.valid_until >= now())
        AND (w.department IS NULL OR trim(w.department) = '' OR lower(trim(w.department)) = lower(trim($2)))
        AND (w.section IS NULL OR trim(w.section) = '' OR lower(trim(w.section)) = lower(trim($3)))
        AND (
          w.advance_sub_type IS NULL OR trim(w.advance_sub_type) = ''
          OR ($4 <> '' AND lower(trim(w.advance_sub_type)) = lower(trim($4)))
          -- "TRAVEL" sub-type covers all travel advance types (anything other than SALARY/LOAN)
          OR ($4 <> '' AND lower(trim(w.advance_sub_type)) = 'travel' AND upper(trim($4)) NOT IN ('SALARY','LOAN'))
        )
      ORDER BY
        -- TEMPORARY workflows override STICKY ones
        CASE COALESCE(w.workflow_type,'STICKY') WHEN 'TEMPORARY' THEN 0 ELSE 1 END,
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
    [requestType, department, section, advanceSubType]
  );

  const workflow = workflows[0];
  if (!workflow) return null;

  const [steps, leadership] = await Promise.all([
    query<{
      step_order: number;
      position_type_code: string | null;
      position_name: string;
      assigned_user_id: string | null;
      assigned_user_name: string | null;
      assigned_user_title: string | null;
      assigned_user_email: string | null;
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
              ws.is_required, ws.skip_if_unassigned, ws.is_final_approval,
              ws.approval_mode, ws.approval_group_name, ws.requires_accommodation, ws.parallel_with_previous, ws.action_type,
              ws.can_reject, ws.can_rollback
         FROM workflow_steps ws
         LEFT JOIN users u ON u.id = ws.assigned_user_id AND u.is_active = true
        WHERE ws.workflow_id = $1 AND ws.is_active = true
        ORDER BY ws.step_order ASC`,
      [(workflow as any).id]
    ),
    getDepartmentLeadership(department)
  ]);
  // HR_MANAGER_REVIEW / HR_REVIEW steps are routed to the org-structure
  // leadership of the "Human Resource" department, not the requester's own
  // department — there's no per-requester "HR manager" concept.
  const hasHrStep = steps.some((step) => normalizeWorkflowRouteCode(step.position_type_code, step.position_name).startsWith("HR_"));
  const hrLeadership = hasHrStep ? await getDepartmentLeadership("Human Resource") : null;

  const chain: ChainStep[] = [];
  let previousStepPushed = false;
  for (const step of steps) {
    const code = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);

    // EMPLOYEE represents the requester, not an approver — exclude from the approval chain.
    if (code === "EMPLOYEE") { previousStepPushed = false; continue; }

    // A step flagged as accommodation-only is skipped unless this request needs accommodation.
    if (step.requires_accommodation && !needsAccommodation) { previousStepPushed = false; continue; }

    // A specific assigned user on the step overrides the department-leadership lookup
    // (e.g. a second "Manager" step routed to a different department's manager).
    const isHrCode = code.startsWith("HR_");

    const approverId =
      step.assigned_user_id ? step.assigned_user_id :
      code === "HOD"        ? leadership.hod_user_id :
      code === "MANAGER"    ? leadership.manager_user_id :
      isHrCode              ? (hrLeadership?.hod_user_id ?? hrLeadership?.manager_user_id ?? null) :
                              null;

    const approverName =
      step.assigned_user_id ? step.assigned_user_name :
      code === "HOD"        ? leadership.hod_name :
      code === "MANAGER"    ? leadership.manager_name :
      isHrCode              ? (hrLeadership?.hod_name ?? hrLeadership?.manager_name ?? null) :
                              null;

    const approverTitle =
      step.assigned_user_id ? step.assigned_user_title :
      code === "HOD"        ? leadership.hod_title :
      code === "MANAGER"    ? leadership.manager_title :
      isHrCode              ? (hrLeadership?.hod_title ?? hrLeadership?.manager_title ?? null) :
                              null;

    const approverEmail =
      step.assigned_user_id ? step.assigned_user_email :
      code === "HOD"        ? leadership.hod_email :
      code === "MANAGER"    ? leadership.manager_email :
      isHrCode              ? (hrLeadership?.hod_email ?? hrLeadership?.manager_email ?? null) :
                              null;

    // Group steps (ANY_ONE with approval_group_name) are never "unassigned" —
    // they're routed to whoever belongs to the group, not a specific individual.
    const isGroupStep = step.approval_mode === "ANY_ONE" && !!step.approval_group_name;
    if (!approverId && step.skip_if_unassigned && !isGroupStep) { previousStepPushed = false; continue; }

    const positionLabel = step.position_name;

    chain.push({
      step_order: step.step_order,
      position_type_code: code,
      position_name: positionLabel,
      approver_id: approverId,
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
// For consecutive HR_REVIEW steps, the second+ occurrence maps to HR_REVIEW.
export function chainStepToStatus(chain: ChainStep[], stepIndex: number): AdvanceStatus {
  const step = chain[stepIndex];
  if (!step) return "SUBMITTED";

  switch (step.position_type_code) {
    case "MANAGER":      return "SUBMITTED";
    case "HOD":           return "COUNTERSIGNED";
    case "HR_MANAGER_REVIEW": return "HR_MANAGER_REVIEW";
    case "HR_REVIEW": {
      const prevHr = chain.slice(0, stepIndex).some(s =>
        s.position_type_code === "HR_REVIEW" || s.position_type_code === "HR_MANAGER_REVIEW"
      );
      return prevHr ? "HR_REVIEW" : "HR_MANAGER_REVIEW";
    }
    case "FINANCE":      return "HR_OFFICER";
    default:             return "HR_MANAGER_REVIEW";
  }
}

// Returns true if userId/userRole is permitted to act on the given workflow step.
// delegatedManagerId is the manager_id the current user is acting on behalf of (from delegation).
export async function canApproveStep(
  step: ChainStep,
  userId: string,
  userRole: string,
  delegatedManagerId?: string | null,
  userDepartment?: string | null
): Promise<boolean> {
  // ANY_ONE steps (e.g. "Team: X") can be actioned by any member of the named
  // permission group, regardless of who the step's approver_id is. "Team: X"
  // groups are scoped to officers — HOD/Manager already have their own
  // dedicated steps, so they don't double-dip on the team's ANY_ONE step.
  if (step.approval_mode === "ANY_ONE" && step.approval_group_name) {
    const isTeamGroup = step.approval_group_name.startsWith("Team: ");
    const isManagementRole = userRole === "HOD" || userRole === "MANAGER";
    // HOD/Manager never act on "Team: X" steps, even if they also happen to
    // be the step's approver_id via department-leadership lookup.
    if (isTeamGroup && isManagementRole) return false;
    const groups = await getUserGroups(userId);
    if (groups.includes(step.approval_group_name)) return true;
  }
  if (step.approver_id) {
    if (step.approver_id === userId) return true;
    // Delegation: allow if acting on behalf of the assigned manager
    if (step.position_type_code === "MANAGER" && delegatedManagerId && step.approver_id === delegatedManagerId) return true;
    return false;
  }
  // No specific approver resolved via org structure — FINANCE is based on
  // department membership (Department: Finance); everything else has no
  // role-based fallback. A step with no org-structure approver simply has
  // no one who can act on it until it's assigned a person or department.
  if (step.position_type_code === "FINANCE") return isFinanceDept(userDepartment);
  return false;
}
