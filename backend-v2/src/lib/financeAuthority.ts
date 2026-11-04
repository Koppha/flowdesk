import type { AuthedRequest } from "./auth.js";
import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

// Which Departments (the `sections` table — see the Company/Division/
// Department/Section -> divisions/departments/sections/teams mapping used
// throughout Standby/Overtime) have compensation-claim Finance authority —
// admin-assigned, org-structure-driven, shared by both Standby and Overtime
// so there is one Finance authority list and one Compensation Queue instead
// of a separate flag/queue per module. No fallback to the legacy free-text
// "Finance" department string: a user only has authority if their
// users.section_id points at a Department an admin has flagged.
export async function ensureFinanceAuthoritySchema() {
  await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS is_compensation_finance boolean NOT NULL DEFAULT false`);
  // One-time backfill from the old Standby-only flag (added earlier this
  // session, before Finance authority became shared with Overtime). Left in
  // place afterwards as unused dead weight rather than dropped.
  await query(`
    UPDATE sections SET is_compensation_finance = true
     WHERE is_standby_finance = true AND is_compensation_finance = false
  `);
}

// Lower-level check for call sites that only have a sectionId on hand
// (e.g. view-permission helpers built from a plain args object rather than
// a full request) - ADMIN bypass is the caller's responsibility there, since
// those helpers typically already special-case role === "ADMIN" themselves.
export async function isCompensationFinanceSection(sectionId?: string | null): Promise<boolean> {
  if (!sectionId) return false;
  const row = (await query<{ is_compensation_finance: boolean }>(
    `SELECT is_compensation_finance FROM sections WHERE id=$1`,
    [sectionId]
  ))[0];
  return Boolean(row?.is_compensation_finance);
}

export async function isCompensationFinanceUser(req: AuthedRequest): Promise<boolean> {
  if (req.user!.role === "ADMIN") return true;
  return isCompensationFinanceSection(req.user!.sectionId);
}

// "Finance" as set up in Workflow Builder, whatever the company (MNO, SEFS,
// or any added later): anyone on a Capture step of an Advance workflow, or on
// a Mark Paid (payment officer) step of any workflow - named directly on the
// step, or a member of the step's group ("Section: X", "Department: X",
// "Team: X", ...). Only steps of ACTIVE, unexpired workflows count.
// Capture steps on other request types are left out on purpose: e.g. the
// Travel Clearance workflow's Capture step is HR's ("Team: Human Resource").
export async function isWorkflowFinanceStaff(userId: string): Promise<boolean> {
  const steps = await query<{ assigned_user_id: string | null; assigned_user_ids: string[] | null; approval_group_name: string | null }>(
    `SELECT ws.assigned_user_id, ws.assigned_user_ids, ws.approval_group_name
       FROM workflow_steps ws
       JOIN workflows w ON w.id = ws.workflow_id
      WHERE ws.is_active = true
        AND w.status = 'ACTIVE'
        AND (w.valid_until IS NULL OR w.valid_until > now())
        AND (ws.action_type = 'MARK_PAID'
             OR (ws.action_type IN ('CAPTURE', 'DEPT_CAPTURE') AND w.request_type = 'ADVANCE_REQUEST'))`
  );
  if (steps.some((s) => s.assigned_user_id === userId || (s.assigned_user_ids || []).includes(userId))) return true;
  const stepGroups = steps.map((s) => s.approval_group_name).filter((g): g is string => Boolean(g));
  if (!stepGroups.length) return false;
  const userGroups = await getUserGroups(userId);
  return stepGroups.some((g) => userGroups.includes(g));
}
