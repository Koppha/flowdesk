import { badRequest, forbidden, notFound } from "./errors.js";
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

export async function assertUserCanRequest(userId: string) {
  const user = await getUserAccountState(userId);
  if (!isProfileComplete(user)) {
    throw badRequest("Complete your profile before requesting an advance");
  }
  if (user.employment_type === "INTERN" || user.employment_type === "TEMPORARY") {
    throw forbidden("Interns and temporary employees cannot request advances");
  }
  return user;
}

export function isPermanentEmployee(user: Pick<UserAccountState, "employment_type">) {
  return String(user.employment_type || "PERMANENT").trim().toUpperCase() === "PERMANENT";
}

export function canCreateAdvanceOnBehalf(user: Pick<UserAccountState, "employment_type" | "role">) {
  const role = String(user.role || "").trim().toUpperCase();
  if (isPermanentEmployee(user)) return true;
  return ["HOD", "MANAGER", "FINANCE", "ADMIN", "CEO", "EXCO"].includes(role);
}
