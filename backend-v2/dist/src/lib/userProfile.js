import { badRequest, forbidden, notFound } from "./errors.js";
import { query } from "./db.js";
export function isProfileComplete(user) {
    if (typeof user.profile_completed === "boolean")
        return user.profile_completed;
    const fullName = String(user.full_name || "").trim();
    const department = String(user.department || "").trim();
    const employeeNo = String(user.employee_no || "").trim();
    const employmentType = String(user.employment_type || "PERMANENT").trim().toUpperCase();
    if (!fullName || !department)
        return false;
    if (employmentType === "INTERN" || employmentType === "TEMPORARY")
        return true;
    return Boolean(employeeNo);
}
export async function getUserAccountState(userId) {
    const rows = await query(`SELECT id, role, full_name, employee_no, department, division_id, section_id, team_id, employment_type, profile_completed, is_active
     FROM users
     WHERE id=$1`, [userId]);
    const user = rows[0];
    if (!user)
        throw notFound("User not found");
    return user;
}
export async function assertUserCanRequest(userId) {
    const user = await getUserAccountState(userId);
    if (!isProfileComplete(user)) {
        throw badRequest("Complete your profile before requesting an advance");
    }
    if (user.employment_type === "INTERN" || user.employment_type === "TEMPORARY") {
        throw forbidden("Interns and temporary employees cannot request advances");
    }
    return user;
}
export function isPermanentEmployee(user) {
    return String(user.employment_type || "PERMANENT").trim().toUpperCase() === "PERMANENT";
}
export function canCreateAdvanceOnBehalf(user) {
    const role = String(user.role || "").trim().toUpperCase();
    if (isPermanentEmployee(user))
        return true;
    return ["HOD", "MANAGER", "HR_MANAGER", "FINANCE", "ADMIN", "CEO", "EXCO"].includes(role);
}
