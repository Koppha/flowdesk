import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

// Salaries is ADMIN-only until an admin grants it to other roles/groups via
// the "Salaries" row on the Roles & Permissions screen (admin_feature_permissions,
// same mechanism as every other admin feature - see requireFeatureAccess in auth.ts).
const SALARIES_DEFAULT_ROLES = ["ADMIN"];

// Module-wide gate: ADMIN always has access; everyone else needs their role
// or one of their permission groups to be in the allow-list an admin has
// configured for the "salaries" feature.
export async function canAccessSalaries(userId: string, role: string): Promise<boolean> {
  if (role === "ADMIN") return true;
  await query(
    `CREATE TABLE IF NOT EXISTS admin_feature_permissions (
       feature_key text PRIMARY KEY,
       allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const rows = await query<{ allowed_roles: string[] }>(
    `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = 'salaries' LIMIT 1`
  );
  const allowed = rows[0]?.allowed_roles ?? SALARIES_DEFAULT_ROLES;
  if (allowed.includes(role)) return true;
  const groups = await getUserGroups(userId);
  return allowed.some((g) => groups.includes(g));
}
