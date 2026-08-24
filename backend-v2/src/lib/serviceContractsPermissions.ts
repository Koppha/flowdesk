import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

// Service Contracts is ADMIN-only until an admin grants it via the Roles &
// Permissions screen (admin_feature_permissions, same mechanism as every
// other admin feature - see requireFeatureAccess in auth.ts). Two separate
// feature keys give view and manage independent grants, same split
// Vendor Contracts/Deductions/Refundable use between seeing the list and
// acting on it. API key issuance is gated separately, hard-coded to ADMIN
// only, regardless of a manage grant - see the routes file.
const VIEW_DEFAULT_ROLES = ["ADMIN"];
const MANAGE_DEFAULT_ROLES = ["ADMIN"];

async function hasFeatureGrant(userId: string, role: string, featureKey: string, defaultRoles: string[]): Promise<boolean> {
  if (role === "ADMIN") return true;
  await query(
    `CREATE TABLE IF NOT EXISTS admin_feature_permissions (
       feature_key text PRIMARY KEY,
       allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const rows = await query<{ allowed_roles: string[] }>(
    `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = $1 LIMIT 1`,
    [featureKey]
  );
  const allowed = rows[0]?.allowed_roles ?? defaultRoles;
  if (allowed.includes(role)) return true;
  const groups = await getUserGroups(userId);
  return allowed.some((g) => groups.includes(g));
}

// Module-wide view gate: seeing the Service Contracts list/dashboard/reports.
export async function canAccessServiceContracts(userId: string, role: string): Promise<boolean> {
  return hasFeatureGrant(userId, role, "service_contracts", VIEW_DEFAULT_ROLES);
}

// Stricter gate: creating/editing contracts, toggling visibility, managing
// lookups. A view grant does not imply a manage grant.
export async function canManageServiceContracts(userId: string, role: string): Promise<boolean> {
  return hasFeatureGrant(userId, role, "service_contracts_manage", MANAGE_DEFAULT_ROLES);
}
