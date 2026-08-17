import type { AuthedRequest } from "./auth.js";
import { query } from "./db.js";

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
