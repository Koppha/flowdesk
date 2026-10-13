import type { AuthedRequest } from "./auth.js";
import { getUserGroups } from "./permissionGroups.js";

// Which users have HR Operations authority — mirrors financeAuthority.ts's
// shape exactly (a small, purpose-built authority check rather than routing
// through the generic admin_feature_permissions system), since this is the
// same kind of cross-cutting "which org unit gets to act here" question.
// Membership is read straight off the user's resolved org groups
// (Department/Section strings from getUserGroups), matching the same token
// set already used elsewhere in this codebase for "is this an HR person"
// checks (e.g. advances.routes.ts's CLEARANCE_STATUS_REPORT_DEFAULT_ROLES).
const HR_OPERATIONS_GROUPS = ["Department: Human Resource", "Department: Human Resources", "Section: Human Resources Operations"];

export async function isHrOperationsUser(req: AuthedRequest): Promise<boolean> {
  if (req.user!.role === "ADMIN") return true;
  const groups = await getUserGroups(req.user!.userId);
  return groups.some((g) => HR_OPERATIONS_GROUPS.includes(g));
}
