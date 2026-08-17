import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

// Refundable is ADMIN-only until an admin grants it to other roles/groups via
// the "Refundable" row on the Roles & Permissions screen (admin_feature_permissions,
// same mechanism as every other admin feature - see requireFeatureAccess in auth.ts).
const REFUNDABLE_DEFAULT_ROLES = ["ADMIN"];

// Module-wide gate (not per-claim): ADMIN always has access; everyone else
// needs their role or one of their permission groups to be in the allow-list
// an admin has configured for the "refundable" feature. Mirrors
// canAccessDeductions (deductionsPermissions.ts) for the opposite direction:
// a claimant who overspent their own money and is owed a refund, rather than
// owing the company a salary deduction.
export async function canAccessRefundable(userId: string, role: string): Promise<boolean> {
  if (role === "ADMIN") return true;
  await query(
    `CREATE TABLE IF NOT EXISTS admin_feature_permissions (
       feature_key text PRIMARY KEY,
       allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const rows = await query<{ allowed_roles: string[] }>(
    `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = 'refundable' LIMIT 1`
  );
  const allowed = rows[0]?.allowed_roles ?? REFUNDABLE_DEFAULT_ROLES;
  if (allowed.includes(role)) return true;
  const groups = await getUserGroups(userId);
  return allowed.some((g) => groups.includes(g));
}
