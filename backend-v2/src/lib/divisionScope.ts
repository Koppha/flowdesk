import { query } from "./db.js";

// MNO's Treasury/Finance staff also perform Capture/Payments/Deductions/
// Refundable work for HigherLife (a subsidiary with no finance staff of its
// own), so an MNO-division viewer's scope includes HigherLife too - while
// the two stay labelled separately in the company tabs. SEFS has its own
// dedicated Finance Operations team and stays scoped to itself only.
const DIVISION_SCOPE_GROUPS: Record<string, string[]> = {
  MNO: ["MNO", "HigherLife"],
  HigherLife: ["MNO", "HigherLife"],
  SEFS: ["SEFS"]
};

// Returns the set of `divisions.name` values a non-admin viewer may see, or
// null for "no restriction" (admins, and anyone whose own division doesn't
// map to a known company - e.g. a cross-company HR/Compensation grant).
export async function getViewerDivisionScope(userId: string, isAdmin: boolean): Promise<string[] | null> {
  if (isAdmin) return null;
  const rows = await query<{ division: string | null }>(
    `SELECT dv.name AS division FROM users u LEFT JOIN divisions dv ON dv.id = u.division_id WHERE u.id=$1`,
    [userId]
  );
  const division = rows[0]?.division ?? null;
  return division ? DIVISION_SCOPE_GROUPS[division] ?? null : null;
}
