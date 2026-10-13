import { query } from "./db.js";
import {
  ChainStep,
  getPendingGroup,
  getUnapprovedStepIndices,
  resolveDeptExco,
  resolveRequesterHod,
  resolveRequesterManager,
  resolveWorkflowChain
} from "./workflowEngine.js";
import { normalizeWorkflowRouteCode } from "./workflowRouting.js";
import { isTravelAdvanceType } from "./travel.js";
import { notifyAdvanceTask, notifyClaimTask } from "./notifications.js";

// Statuses where a chain-bearing request still has a live pending approver -
// mirrors the transition maps in advances.types.ts / claims.service.ts.
const ADVANCE_PENDING_STATUSES = ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER", "APPROVED"];
const CLAIM_PENDING_STATUSES = ["SUBMITTED", "MANAGER_APPROVED", "EXCO_APPROVED", "HR_OFFICER", "FINANCE_VERIFIED", "PAYMENT_PROCESSING"];

export interface ReassignmentResult {
  module: "advance" | "claim";
  requestId: string;
  requestType: string;
  positionType: "MANAGER" | "HOD" | "EXCO";
  oldApproverId: string | null;
  oldApproverName: string | null;
  newApproverId: string;
  newApproverName: string | null;
}

export interface ReassignmentWarning {
  module: "advance" | "claim";
  requestId: string;
  reason: string;
}

type ResolvedApprover = { id: string; full_name: string | null; title: string | null; email: string | null };

// Mirrors the same rule in workflowEngine.ts's resolveWorkflowChain: a
// requester who already sits at HOD tier or above (HOD/EXCO/CEO/ADMIN)
// structurally has no "Manager" above them, and above EXCO tier has no
// "HOD" either - resolveDynamicApprover coming back empty for them is
// expected, not a data gap. The live chain already has whatever approver
// was resolved at submission/last-reassignment time (still perfectly
// usable) - there's nothing to flag here, unlike the same empty result
// for a plain EMPLOYEE/MANAGER-role requester, which almost always means
// their reporting line genuinely hasn't been set up.
function approverExemptFromRequirement(positionCode: "MANAGER" | "HOD" | "EXCO", requesterRole: string | null): boolean {
  if (positionCode === "MANAGER") return ["HOD", "EXCO", "CEO", "ADMIN"].includes(requesterRole || "");
  if (positionCode === "HOD") return ["EXCO", "CEO", "ADMIN"].includes(requesterRole || "");
  return false;
}

// The generic "No MANAGER found for the employee's current placement"
// message gave an admin nothing to act on - not which employee, not which
// request, not where they actually sit in the org (the very thing that's
// missing a manager/HOD/EXCO to resolve against). Name the employee and
// their full org placement so this reads as an actionable ticket instead
// of a puzzle.
function missingApproverReason(
  positionCode: string,
  employeeName: string | null,
  employeeNo: string | null,
  division: string | null,
  department: string | null,
  section: string | null,
  team: string | null
): string {
  const who = employeeName ? `${employeeName}${employeeNo ? ` (${employeeNo})` : ""}` : "this employee";
  const placement = [division, department, section, team].filter((v) => v && v.trim()).join(" › ");
  const roleLabel = positionCode === "MANAGER" ? "Manager" : positionCode === "HOD" ? "Head of Department" : "EXCO member";
  return placement
    ? `No ${roleLabel} is set up for ${who}'s placement (${placement}) - assign one in Organizational Structure or Reporting Lines.`
    : `No ${roleLabel} is set up for ${who}, who has no division/department/section/team assigned - complete their org placement first.`;
}

// Only MANAGER/HOD/EXCO steps that resolved dynamically (no fixed assignee,
// not an ANY_ONE org-unit group) are eligible for reassignment — everything
// else (fixed picks, Team:/Section:/Department: group steps) is left alone.
async function classifyDynamicStep(
  workflowId: string,
  step: ChainStep
): Promise<{ code: "MANAGER" | "HOD" | "EXCO"; positionName: string } | null> {
  const rows = await query<{
    position_type_code: string | null;
    position_name: string;
    assigned_user_id: string | null;
    assigned_user_ids: string[] | null;
    approval_mode: string;
    approval_group_name: string | null;
  }>(
    `SELECT position_type_code, position_name, assigned_user_id, assigned_user_ids, approval_mode, approval_group_name
       FROM workflow_steps
      WHERE workflow_id=$1 AND step_order=$2 AND is_active=true
      ORDER BY updated_at DESC
      LIMIT 1`,
    [workflowId, step.step_order]
  );
  const def = rows[0];
  if (!def) return null;
  const code = normalizeWorkflowRouteCode(def.position_type_code, def.position_name);
  if (code !== "MANAGER" && code !== "HOD" && code !== "EXCO") return null;
  const hasFixedAssignees = !!def.assigned_user_id || !!(def.assigned_user_ids && def.assigned_user_ids.length);
  const isGroupStep = def.approval_mode === "ANY_ONE" && !!def.approval_group_name;
  if (hasFixedAssignees || isGroupStep) return null;
  return { code, positionName: def.position_name };
}

// Re-resolves who should fill a dynamic step, exactly mirroring
// resolveWorkflowChain's own step-building logic (workflowEngine.ts) so a
// reassignment never disagrees with what a fresh submission would produce.
async function resolveDynamicApprover(
  positionCode: "MANAGER" | "HOD" | "EXCO",
  movedUserId: string,
  department: string | null,
  chain: ChainStep[],
  stepIdx: number,
  workflowId: string
): Promise<ResolvedApprover | null> {
  if (positionCode === "EXCO") return resolveDeptExco(department || "", movedUserId);

  const candidate = positionCode === "HOD"
    ? await resolveRequesterHod(movedUserId)
    : await resolveRequesterManager(movedUserId);
  if (positionCode !== "HOD" || !candidate) return candidate;

  // Collision avoidance: if an earlier step in this same stored chain is
  // ITSELF a dynamic MANAGER position, escalate one level further so the
  // same "direct manager" slot doesn't fill both steps — mirrors
  // resolveWorkflowChain's dynamicManagerAlreadyResolved/secondLevelManager.
  // This has to be a structural check (was that earlier step a dynamic
  // MANAGER step at all), not an identity comparison against its stored
  // approver_id — that id is frozen from whenever it last resolved, and a
  // move can change what resolveRequesterManager(movedUserId) returns
  // without touching the earlier step's stale approver_id at all, which
  // silently defeated this check (see Thuto Matlakala's HOD step landing on
  // his own direct manager, Lithakong Mothibe, instead of escalating to the
  // real Operations HOD, Paka Mahao).
  for (let i = 0; i < stepIdx; i++) {
    const earlierDefinition = await classifyDynamicStep(workflowId, chain[i]);
    if (earlierDefinition?.code === "MANAGER" && chain[i].approver_id === candidate.id) {
      return resolveRequesterManager(candidate.id);
    }
  }
  return candidate;
}

// The sweep previously only patched a step when the resolved APPROVER
// changed (a different person) - if the same person is still correctly
// resolved but their own profile changed since this step was last written
// (e.g. a title update), nothing ever refreshed it, since approver_name/
// title/email are frozen into the chain at resolution time and never
// re-read live afterward. That left stale personal details (like an old
// job title) permanently stuck on any already-submitted, still-pending
// request - not fixable by reassignment at all, since there was nothing to
// "reassign." Compared here so a same-person match still counts as
// "changed" whenever any of these three drifted.
function approverAttributesStale(step: ChainStep, resolved: ResolvedApprover): boolean {
  return step.approver_name !== resolved.full_name || step.approver_title !== resolved.title || step.approver_email !== resolved.email;
}

function patchStep(step: ChainStep, resolved: ResolvedApprover) {
  step.approver_id = resolved.id;
  step.approver_ids = [resolved.id];
  step.approver_name = resolved.full_name;
  step.approver_title = resolved.title;
  step.approver_email = resolved.email;
  step.approvers = [{ id: resolved.id, name: resolved.full_name, email: resolved.email, title: resolved.title }];
}

async function writeAudit(action: string, entityType: string, requestId: string, actorId: string | null, before: unknown, after: unknown) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, action, entityType, requestId, JSON.stringify(before), JSON.stringify(after)]
  );
}

// requesterId: reassign only this person's own pending requests (the
// employee-move trigger). null: sweep every requester's pending requests
// (the daily cron sweep) - each row is still resolved against its own
// requester, never the caller's identity.
async function reassignAdvances(
  requesterId: string | null,
  actorId: string | null,
  auditAction: string,
  reassignments: ReassignmentResult[],
  warnings: ReassignmentWarning[]
) {
  const rows = await query<{
    id: string;
    requester_id: string;
    type: string;
    workflow_id: string;
    workflow_step_order: number | null;
    approval_chain: ChainStep[];
    requester_department: string | null;
    requester_section: string | null;
    requester_team: string | null;
    division: string | null;
    role: string;
    requester_name: string | null;
    requester_employee_no: string | null;
  }>(
    `SELECT ar.id, ar.requester_id, ar.type, ar.workflow_id, ar.workflow_step_order, ar.approval_chain,
            u.department AS requester_department, s.name AS requester_section, tm.name AS requester_team,
            d.name AS division, u.role, u.full_name AS requester_name, u.employee_no AS requester_employee_no
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN divisions d ON d.id = u.division_id
       LEFT JOIN teams tm ON tm.id = u.team_id
      WHERE ($1::uuid IS NULL OR ar.requester_id = $1)
        AND ar.status = ANY($2)
        AND ar.approval_chain IS NOT NULL
        AND ar.workflow_id IS NOT NULL`,
    [requesterId, ADVANCE_PENDING_STATUSES]
  );

  for (const row of rows) {
    const chain = row.approval_chain;
    const stepIdx = row.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    const pendingNow = new Set(group.indices);
    // A workflow edit can change a step the request has not reached yet
    // (for example Manager -> HOD -> EXCO becoming Manager -> HOD -> HR).
    // Sweep every still-unapproved dynamic step from the current pointer
    // forward, not only the currently visible inbox stage.
    const unapprovedIndices = getUnapprovedStepIndices(chain, stepIdx);
    let changed = false;
    let currentPatched: ResolvedApprover | null = null;

    for (const idx of unapprovedIndices) {
      const step = chain[idx];
      if (!step) continue;
      const definition = await classifyDynamicStep(row.workflow_id, step);
      if (!definition) continue;
      const positionCode = definition.code;

      const resolved = await resolveDynamicApprover(positionCode, row.requester_id, row.requester_department, chain, idx, row.workflow_id);
      if (!resolved) {
        if (!approverExemptFromRequirement(positionCode, row.role)) {
          warnings.push({
            module: "advance",
            requestId: row.id,
            reason: missingApproverReason(positionCode, row.requester_name, row.requester_employee_no, row.division, row.requester_department, row.requester_section, row.requester_team)
          });
        }
        continue;
      }
      const routeChanged = step.position_type_code !== positionCode || step.position_name !== definition.positionName;
      if (resolved.id === step.approver_id && !routeChanged && !approverAttributesStale(step, resolved)) continue;

      const before = { approver_id: step.approver_id, approver_name: step.approver_name, position_type: step.position_type_code };
      reassignments.push({
        module: "advance", requestId: row.id, requestType: row.type, positionType: positionCode,
        oldApproverId: step.approver_id, oldApproverName: step.approver_name,
        newApproverId: resolved.id, newApproverName: resolved.full_name
      });
      patchStep(step, resolved);
      step.position_type_code = positionCode;
      step.position_name = definition.positionName;
      changed = true;
      if (pendingNow.has(idx)) currentPatched = resolved;
      await writeAudit(auditAction, "advance_requests", row.id, actorId, before, { approver_id: resolved.id, approver_name: resolved.full_name, position_type: positionCode });
    }

    if (!changed) continue;

    // Safety net: if the org move changed which workflow applies (not just
    // who fills a role), step-patching alone can't fix that — flag it.
    const needsAccommodation = (await isTravelAdvanceType(row.type))
      ? Number(
          (await query<{ count: string }>(`SELECT count(*)::text AS count FROM advance_lines WHERE advance_request_id=$1`, [row.id]))[0]?.count ?? "0"
        ) > 1
      : false;
    const probe = await resolveWorkflowChain({
      requestType: "ADVANCE_REQUEST",
      department: row.requester_department || "",
      division: row.division || "",
      section: row.requester_section || "",
      team: row.requester_team || "",
      advanceSubType: row.type,
      needsAccommodation,
      requesterRole: row.role,
      requesterId: row.requester_id
    });
    if (!probe || probe.workflowId !== row.workflow_id) {
      warnings.push({ module: "advance", requestId: row.id, reason: "This request's current placement now matches a different workflow entirely — review manually" });
    }

    await query(`UPDATE advance_requests SET approval_chain=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(chain), row.id]);

    if (currentPatched) {
      void notifyAdvanceTask({
        advanceId: row.id,
        status: chainStepStatusForNotify(chain, stepIdx),
        advanceType: row.type,
        requesterName: null,
        department: row.requester_department,
        requestedTotal: 0,
        nextApprover: { id: currentPatched.id, name: currentPatched.full_name, email: currentPatched.email, title: currentPatched.title },
        stepOrder: stepIdx
      });
    }
  }
}

// notifyAdvanceTask keys its email wording off `status`, not the chain
// itself - reuse the request's own status label rather than re-deriving it,
// since we only need "who to notify", not a status transition here.
function chainStepStatusForNotify(chain: ChainStep[], stepIdx: number): string {
  const step = chain[stepIdx];
  if (!step) return "SUBMITTED";
  if (step.position_type_code.startsWith("HR_")) return "HR_OFFICER";
  if (step.position_type_code === "MANAGER") return "SUBMITTED";
  if (["HOD", "EXCO", "CEO"].includes(step.position_type_code)) return "COUNTERSIGNED";
  return "SUBMITTED";
}

async function reassignClaims(
  requesterId: string | null,
  actorId: string | null,
  auditAction: string,
  reassignments: ReassignmentResult[],
  warnings: ReassignmentWarning[]
) {
  const rows = await query<{
    id: string;
    claimant_id: string;
    workflow_id: string;
    workflow_step_order: number | null;
    approval_chain: ChainStep[];
    claimant_department: string | null;
    claimant_division: string | null;
    claimant_section: string | null;
    claimant_team: string | null;
    claimant_role: string | null;
    linked_advance_type: string | null;
    claimant_name: string | null;
    claimant_employee_no: string | null;
  }>(
    `SELECT c.id, c.claimant_id, c.workflow_id, c.workflow_step_order, c.approval_chain,
            u.department AS claimant_department, dv.name AS claimant_division,
            s.name AS claimant_section, tm.name AS claimant_team,
            u.role AS claimant_role,
            ar.type AS linked_advance_type,
            u.full_name AS claimant_name, u.employee_no AS claimant_employee_no
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN teams tm ON tm.id = u.team_id
       LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
      WHERE ($1::uuid IS NULL OR c.claimant_id = $1)
        AND c.status = ANY($2)
        AND c.approval_chain IS NOT NULL
        AND c.workflow_id IS NOT NULL`,
    [requesterId, CLAIM_PENDING_STATUSES]
  );

  for (const row of rows) {
    const chain = row.approval_chain;
    const stepIdx = row.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    const pendingNow = new Set(group.indices);
    const unapprovedIndices = getUnapprovedStepIndices(chain, stepIdx);
    let changed = false;
    let currentPatched: ResolvedApprover | null = null;

    for (const idx of unapprovedIndices) {
      const step = chain[idx];
      if (!step) continue;
      const definition = await classifyDynamicStep(row.workflow_id, step);
      if (!definition) continue;
      const positionCode = definition.code;

      const resolved = await resolveDynamicApprover(positionCode, row.claimant_id, row.claimant_department, chain, idx, row.workflow_id);
      if (!resolved) {
        if (!approverExemptFromRequirement(positionCode, row.claimant_role)) {
          warnings.push({
            module: "claim",
            requestId: row.id,
            reason: missingApproverReason(positionCode, row.claimant_name, row.claimant_employee_no, row.claimant_division, row.claimant_department, row.claimant_section, row.claimant_team)
          });
        }
        continue;
      }
      const routeChanged = step.position_type_code !== positionCode || step.position_name !== definition.positionName;
      if (resolved.id === step.approver_id && !routeChanged && !approverAttributesStale(step, resolved)) continue;

      const before = { approver_id: step.approver_id, approver_name: step.approver_name, position_type: step.position_type_code };
      reassignments.push({
        module: "claim", requestId: row.id, requestType: "CLEARANCE_REQUEST", positionType: positionCode,
        oldApproverId: step.approver_id, oldApproverName: step.approver_name,
        newApproverId: resolved.id, newApproverName: resolved.full_name
      });
      patchStep(step, resolved);
      step.position_type_code = positionCode;
      step.position_name = definition.positionName;
      changed = true;
      if (pendingNow.has(idx)) currentPatched = resolved;
      await writeAudit(auditAction, "clearance_claims", row.id, actorId, before, { approver_id: resolved.id, approver_name: resolved.full_name, position_type: positionCode });
    }

    if (!changed) continue;

    const probe = await resolveWorkflowChain({
      requestType: "CLEARANCE_REQUEST",
      department: row.claimant_department || "",
      division: row.claimant_division || "",
      section: row.claimant_section || "",
      team: row.claimant_team || "",
      advanceSubType: row.linked_advance_type || undefined,
      requesterRole: row.claimant_role || "",
      requesterId: row.claimant_id
    });
    if (!probe || probe.workflowId !== row.workflow_id) {
      warnings.push({ module: "claim", requestId: row.id, reason: "This request's current placement now matches a different workflow entirely — review manually" });
    }

    await query(`UPDATE clearance_claims SET approval_chain=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(chain), row.id]);

    if (currentPatched) {
      void notifyClaimTask({
        claimId: row.id,
        status: chainStepStatusForNotify(chain, stepIdx),
        claimantName: null,
        department: row.claimant_department,
        claimTotal: 0,
        nextApprover: { id: currentPatched.id, name: currentPatched.full_name, email: currentPatched.email, title: currentPatched.title },
        stepOrder: stepIdx
      });
    }
  }
}

// Best-effort: called after PUT /users/:id commits a department/division/
// section change. Never throws — a failure here must not fail the employee
// move itself, only skip the (auditable, retryable) reassignment side effect.
export async function reassignPendingRequestsForMovedEmployee(movedUserId: string): Promise<{
  reassignments: ReassignmentResult[];
  warnings: ReassignmentWarning[];
}> {
  const reassignments: ReassignmentResult[] = [];
  const warnings: ReassignmentWarning[] = [];
  await reassignAdvances(movedUserId, movedUserId, "APPROVAL_STEP_REASSIGNED_ON_MOVE", reassignments, warnings);
  await reassignClaims(movedUserId, movedUserId, "APPROVAL_STEP_REASSIGNED_ON_MOVE", reassignments, warnings);
  return { reassignments, warnings };
}

// Daily sweep (see index.ts) covering every requester, not just one just-
// moved employee - catches the case this feature was actually built for:
// a request went out to nobody-resolvable (or a stale approver) days ago,
// and the right person (e.g. a manager whose account was inactive/unset)
// has since become available. actor_id is left null on the audit trail to
// mark these as system-triggered rather than admin-triggered.
export async function reassignAllPendingApprovals(): Promise<{
  reassignments: ReassignmentResult[];
  warnings: ReassignmentWarning[];
}> {
  const reassignments: ReassignmentResult[] = [];
  const warnings: ReassignmentWarning[] = [];
  await reassignAdvances(null, null, "APPROVAL_STEP_REASSIGNED_BY_SWEEP", reassignments, warnings);
  await reassignClaims(null, null, "APPROVAL_STEP_REASSIGNED_BY_SWEEP", reassignments, warnings);
  return { reassignments, warnings };
}

// Best-effort: called after PUT /users/:id commits a title-only edit (no
// department/division/section change, so reassignPendingRequestsForMovedEmployee
// wouldn't run). A title edit never changes WHO approves, only what's shown
// for them, so this only rewrites the display title on steps that haven't
// been actioned yet — an already-approved step keeps the title the approver
// actually held at the time they approved, same as any other audit trail.
export async function syncApproverTitleForPendingSteps(userId: string, newTitle: string | null): Promise<{
  advancesUpdated: number;
  claimsUpdated: number;
}> {
  let advancesUpdated = 0;
  let claimsUpdated = 0;

  function patchChain(chain: ChainStep[]): { chain: ChainStep[]; changed: boolean } {
    let changed = false;
    const patched = chain.map((step) => {
      if (step.approved) return step;
      let stepChanged = false;
      const next: ChainStep = { ...step };
      if (next.approver_id === userId && next.approver_title !== newTitle) {
        next.approver_title = newTitle;
        stepChanged = true;
      }
      if (Array.isArray(next.approvers)) {
        let approversChanged = false;
        const approvers = next.approvers.map((a) => {
          if (a.id === userId && a.title !== newTitle) {
            approversChanged = true;
            return { ...a, title: newTitle };
          }
          return a;
        });
        if (approversChanged) {
          next.approvers = approvers;
          stepChanged = true;
        }
      }
      if (stepChanged) changed = true;
      return stepChanged ? next : step;
    });
    return { chain: patched, changed };
  }

  const advanceRows = await query<{ id: string; approval_chain: ChainStep[] }>(
    `SELECT id, approval_chain FROM advance_requests
      WHERE status = ANY($1::text[]) AND approval_chain IS NOT NULL AND approval_chain::text LIKE $2`,
    [ADVANCE_PENDING_STATUSES, `%${userId}%`]
  );
  for (const row of advanceRows) {
    const { chain, changed } = patchChain(row.approval_chain);
    if (changed) {
      await query(`UPDATE advance_requests SET approval_chain=$2 WHERE id=$1`, [row.id, JSON.stringify(chain)]);
      advancesUpdated++;
    }
  }

  const claimRows = await query<{ id: string; approval_chain: ChainStep[] }>(
    `SELECT id, approval_chain FROM clearance_claims
      WHERE status = ANY($1::text[]) AND approval_chain IS NOT NULL AND approval_chain::text LIKE $2`,
    [CLAIM_PENDING_STATUSES, `%${userId}%`]
  );
  for (const row of claimRows) {
    const { chain, changed } = patchChain(row.approval_chain);
    if (changed) {
      await query(`UPDATE clearance_claims SET approval_chain=$2 WHERE id=$1`, [row.id, JSON.stringify(chain)]);
      claimsUpdated++;
    }
  }

  return { advancesUpdated, claimsUpdated };
}
