import { query } from "./db.js";
import { getDepartmentLeadership } from "./departments.js";
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
    }>(
      `SELECT ws.step_order, ws.position_type_code, ws.position_name,
              ws.assigned_user_id, u.full_name AS assigned_user_name, u.title AS assigned_user_title, u.email AS assigned_user_email,
              ws.is_required, ws.skip_if_unassigned, ws.is_final_approval,
              ws.approval_mode, ws.approval_group_name, ws.requires_accommodation
         FROM workflow_steps ws
         LEFT JOIN users u ON u.id = ws.assigned_user_id
        WHERE ws.workflow_id = $1 AND ws.is_active = true
        ORDER BY ws.step_order ASC`,
      [(workflow as any).id]
    ),
    getDepartmentLeadership(department)
  ]);

  const chain: ChainStep[] = [];
  for (const step of steps) {
    const code = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);

    // EMPLOYEE represents the requester, not an approver — exclude from the approval chain.
    if (code === "EMPLOYEE") continue;

    // A step flagged as accommodation-only is skipped unless this request needs accommodation.
    if (step.requires_accommodation && !needsAccommodation) continue;

    // A specific assigned user on the step overrides the department-leadership lookup
    // (e.g. a second "Manager" step routed to a different department's manager).
    const approverId =
      step.assigned_user_id ? step.assigned_user_id :
      code === "HOD"        ? leadership.hod_user_id :
      code === "MANAGER"    ? leadership.manager_user_id :
      code === "EXCO_OWNER" ? leadership.exco_user_id :
                              null;

    const approverName =
      step.assigned_user_id ? step.assigned_user_name :
      code === "HOD"        ? leadership.hod_name :
      code === "MANAGER"    ? leadership.manager_name :
      code === "EXCO_OWNER" ? leadership.exco_name :
                              null;

    const approverTitle =
      step.assigned_user_id ? step.assigned_user_title :
      code === "HOD"        ? leadership.hod_title :
      code === "MANAGER"    ? leadership.manager_title :
      code === "EXCO_OWNER" ? leadership.exco_title :
                              null;

    const approverEmail =
      step.assigned_user_id ? step.assigned_user_email :
      code === "HOD"        ? leadership.hod_email :
      code === "MANAGER"    ? leadership.manager_email :
      code === "EXCO_OWNER" ? leadership.exco_email :
                              null;

    if (!approverId && step.skip_if_unassigned) continue;

    const positionLabel =
      code === "EXCO_OWNER" && leadership.exco_title
        ? leadership.exco_title
        : step.position_name;

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
      requires_accommodation: step.requires_accommodation
    });
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
    case "HOD":
    case "EXCO_OWNER":   return "COUNTERSIGNED";
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
export function canApproveStep(
  step: ChainStep,
  userId: string,
  userRole: string,
  delegatedManagerId?: string | null
): boolean {
  if (step.approver_id) {
    if (step.approver_id === userId) return true;
    // Delegation: allow if acting on behalf of the assigned manager
    if (step.position_type_code === "MANAGER" && delegatedManagerId && step.approver_id === delegatedManagerId) return true;
    return false;
  }
  // No specific approver — fall back to role-based
  const roleMap: Record<string, string[]> = {
    MANAGER:           ["MANAGER"],
    HOD:               ["HOD"],
    EXCO_OWNER:        ["EXCO"],
    HR_MANAGER_REVIEW: ["HR_MANAGER"],
    HR_REVIEW:         ["HR_MANAGER"],
    FINANCE:           ["FINANCE"],
    CEO:               ["CEO"]
  };
  return (roleMap[step.position_type_code] ?? []).includes(userRole);
}
