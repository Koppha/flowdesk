import { badRequest, notFound } from "./errors.js";
import { query } from "./db.js";

export type UserAccountState = {
  id: string;
  role: string;
  full_name: string | null;
  employee_no: string | null;
  department: string | null;
  division_id: string | null;
  section_id: string | null;
  team_id: string | null;
  employment_type: string | null;
  profile_completed: boolean | null;
  is_active: boolean;
};

export function isProfileComplete(user: Pick<UserAccountState, "full_name" | "department" | "employee_no" | "employment_type" | "profile_completed">) {
  if (typeof user.profile_completed === "boolean") return user.profile_completed;
  const fullName = String(user.full_name || "").trim();
  const department = String(user.department || "").trim();
  const employeeNo = String(user.employee_no || "").trim();
  const employmentType = String(user.employment_type || "PERMANENT").trim().toUpperCase();
  if (!fullName || !department) return false;
  if (employmentType === "INTERN" || employmentType === "TEMPORARY") return true;
  return Boolean(employeeNo);
}

export async function getUserAccountState(userId: string) {
  const rows = await query<UserAccountState>(
    `SELECT id, role, full_name, employee_no, department, division_id, section_id, team_id, employment_type, profile_completed, is_active
     FROM users
     WHERE id=$1`,
    [userId]
  );
  const user = rows[0];
  if (!user) throw notFound("User not found");
  return user;
}

// Despite the name, this only gates clearance submission (see claims.routes.ts) -
// advances have their own eligibility check in resolveAdvanceRequester, which
// already allows interns and temporary employees to self-request. Clearance
// should be available to anyone who can hold an advance to begin with, so
// this doesn't re-block them by employment type.
export async function assertUserCanRequest(userId: string) {
  const user = await getUserAccountState(userId);
  if (!isProfileComplete(user)) {
    throw badRequest("Complete your profile before requesting a clearance");
  }
  return user;
}

export function isPermanentEmployee(user: Pick<UserAccountState, "employment_type">) {
  return String(user.employment_type || "PERMANENT").trim().toUpperCase() === "PERMANENT";
}

// Temporary staff and interns can never request an advance on someone else's
// behalf, regardless of role - only permanent employees can.
export function canCreateAdvanceOnBehalf(user: Pick<UserAccountState, "employment_type" | "role">) {
  return isPermanentEmployee(user);
}
