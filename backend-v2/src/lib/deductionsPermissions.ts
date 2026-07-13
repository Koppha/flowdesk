import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

// Module-wide gate (not per-deduction): ADMIN always has access; everyone
// else needs to belong to one of the groups an admin has granted access to.
export async function canAccessDeductions(userId: string, role: string): Promise<boolean> {
  if (role === "ADMIN") return true;
  const granted = await query<{ group_name: string }>(`SELECT group_name FROM deduction_access_groups`);
  if (granted.length === 0) return false;
  const groups = await getUserGroups(userId);
  return granted.some((g) => groups.includes(g.group_name));
}
