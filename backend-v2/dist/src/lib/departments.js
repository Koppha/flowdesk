import { randomUUID } from "crypto";
import { badRequest } from "./errors.js";
import { query } from "./db.js";
export const DEFAULT_DEPARTMENT_GROUPS = Object.freeze([
    "Business Intelligence",
    "Business Solutions",
    "Call Centre",
    "CEO Office",
    "Commercial",
    "Consumer Sales",
    "Contact Centre",
    "Corporate Sales",
    "Customer Experience",
    "Customer Operations",
    "Customer Service",
    "Digital Transformation",
    "Enterprise Business",
    "Facilities",
    "Finance",
    "MNO Finance",
    "SEFS Finance",
    "Fixed Network",
    "Human Resources",
    "Internal Audit",
    "Legal and Regulatory",
    "Marketing",
    "Mobile Money",
    "Network Infrastructure",
    "Network Operations",
    "Operations",
    "Procurement",
    "Product Development",
    "Project Management Office",
    "Radio Network",
    "Regional Operations",
    "Regulatory Affairs",
    "Revenue Assurance",
    "Risk and Compliance",
    "Sales",
    "Sales and Distribution",
    "Security",
    "Service Delivery",
    "Strategy",
    "Technology",
    "Transmission",
    "Wholesale"
]);
export function normalizeDepartmentName(value) {
    return value.trim().replace(/\s+/g, " ");
}
let departmentGroupsEnsured = false;
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
async function assertEligibleOwner(userId, roles, label) {
    if (!userId)
        return null;
    const rows = await query(`SELECT id
       FROM users
      WHERE id = $1
        AND is_active = true
        AND role::text = ANY($2::text[])
      LIMIT 1`, [userId, roles]);
    if (!rows[0])
        throw badRequest(`${label} must be an active ${roles.join(" or ").toLowerCase().replace(/_/g, " ")} user`);
    return rows[0].id;
}
export async function ensureSectionSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS sections (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      exco_user_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    ALTER TABLE sections
    ADD COLUMN IF NOT EXISTS exco_user_id uuid REFERENCES users(id)
  `);
}
export async function ensureDepartmentsTable() {
    await ensureSectionSchema();
    await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      section_id uuid REFERENCES sections(id),
      manager_user_id uuid REFERENCES users(id),
      exco_user_id uuid REFERENCES users(id),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES sections(id)
  `);
    await query(`
    ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id)
  `);
    await query(`
    ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS exco_user_id uuid REFERENCES users(id)
  `);
    await query(`
    ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true
  `);
}
export async function ensureDepartmentGroups() {
    await ensureDepartmentsTable();
    if (departmentGroupsEnsured)
        return;
    for (const department of DEFAULT_DEPARTMENT_GROUPS) {
        await query(`INSERT INTO departments (id, name)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1
           FROM departments
          WHERE lower(trim(name)) = lower($2)
       )
       ON CONFLICT (name) DO NOTHING`, [randomUUID(), department]);
    }
    departmentGroupsEnsured = true;
}
export async function listDepartmentGroups() {
    await ensureDepartmentGroups();
    const rows = await query(`SELECT department
       FROM (
         SELECT DISTINCT trim(department) AS department
           FROM users
          WHERE department IS NOT NULL
            AND trim(department) <> ''
            AND lower(trim(department)) NOT IN ('administration', 'administrator')
         UNION
         SELECT trim(name) AS department
           FROM departments
          WHERE trim(name) <> ''
            AND active = true
       ) departments
      ORDER BY department`);
    return rows.map((row) => row.department);
}
const DEPARTMENT_ALIASES = new Map([
    ["sefs finance", "SEFS Finance"],
    ["sefs department", "SEFS Finance"]
]);
export async function resolveDepartmentGroup(input) {
    const department = normalizeDepartmentName(input);
    if (!department)
        throw badRequest("Department is required");
    const alias = DEPARTMENT_ALIASES.get(department.toLowerCase()) || department;
    await ensureDepartmentGroups();
    const rows = await query(`SELECT department
       FROM (
         SELECT trim(name) AS department
           FROM departments
         WHERE trim(name) <> ''
           AND active = true
         UNION
         SELECT DISTINCT trim(department) AS department
           FROM users
          WHERE department IS NOT NULL
            AND trim(department) <> ''
            AND lower(trim(department)) NOT IN ('administration', 'administrator')
       ) departments
      WHERE lower(department) = lower($1)
      ORDER BY department
      LIMIT 1`, [alias]);
    if (!rows[0])
        throw badRequest("Choose a valid department from the department groups list");
    return rows[0].department;
}
export async function resolveSectionGroup(input) {
    const section = normalizeDepartmentName(input);
    if (!section)
        throw badRequest("Section is required");
    await ensureSectionSchema();
    const rows = await query(`SELECT trim(name) AS section
       FROM sections
      WHERE trim(name) <> ''
        AND lower(trim(name)) = lower($1)
      ORDER BY name
      LIMIT 1`, [section]);
    if (!rows[0])
        throw badRequest("Choose a valid section from the sections list");
    return rows[0].section;
}
export async function createDepartmentGroup(input, sectionId) {
    const options = typeof sectionId === "object" ? sectionId : { sectionId };
    const department = normalizeDepartmentName(input);
    if (department.length < 2)
        throw badRequest("Department name is required");
    await ensureDepartmentsTable();
    const managerUserId = await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager");
    const excoUserId = await assertEligibleOwner(options.excoUserId, ["CHIEF_OFFICER"], "EXCO owner");
    const existing = await query(`SELECT id, name
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [department]);
    if (existing[0])
        return existing[0];
    const rows = await query(`INSERT INTO departments (id, name, section_id, manager_user_id, exco_user_id, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE
       SET name = EXCLUDED.name,
           section_id = EXCLUDED.section_id,
           manager_user_id = EXCLUDED.manager_user_id,
           exco_user_id = EXCLUDED.exco_user_id,
           active = EXCLUDED.active
     RETURNING id, name, section_id, manager_user_id, exco_user_id, active`, [randomUUID(), department, options.sectionId || null, managerUserId, excoUserId, options.active ?? true]);
    return rows[0];
}
export async function listDepartmentsWithSections() {
    await ensureDepartmentGroups();
    const rows = await query(`SELECT d.id,
            d.name,
            d.section_id,
            s.name AS section_name,
            d.manager_user_id,
            manager.full_name AS manager_name,
            manager.email AS manager_email,
            d.exco_user_id,
            exco.full_name AS exco_name,
            exco.email AS exco_email,
            s.exco_user_id AS section_exco_user_id,
            section_exco.full_name AS section_exco_name,
            section_exco.email AS section_exco_email,
            d.active
       FROM departments d
       LEFT JOIN sections s ON s.id = d.section_id
       LEFT JOIN users manager ON manager.id = d.manager_user_id
       LEFT JOIN users exco ON exco.id = d.exco_user_id
       LEFT JOIN users section_exco ON section_exco.id = s.exco_user_id
      ORDER BY COALESCE(s.name, 'zzz'), d.name`);
    return rows;
}
export async function updateDepartmentGroup(oldName, newName, options = {}) {
    const currentDepartment = normalizeDepartmentName(oldName);
    const updatedDepartment = normalizeDepartmentName(newName);
    if (!currentDepartment)
        throw badRequest("Current department is required");
    if (!updatedDepartment)
        throw badRequest("New department name is required");
    await ensureDepartmentsTable();
    const existing = await query(`SELECT id, name, section_id, manager_user_id, exco_user_id, active
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [currentDepartment]);
    if (!existing[0])
        throw badRequest("Department not found");
    const conflict = await query(`SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`, [updatedDepartment, existing[0].id]);
    if (conflict[0])
        throw badRequest("Department name already exists");
    const sectionId = hasOwn(options, "sectionId") ? options.sectionId ?? null : existing[0].section_id;
    const managerUserId = hasOwn(options, "managerUserId")
        ? await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager")
        : existing[0].manager_user_id;
    const excoUserId = hasOwn(options, "excoUserId")
        ? await assertEligibleOwner(options.excoUserId, ["CHIEF_OFFICER"], "EXCO owner")
        : existing[0].exco_user_id;
    const active = hasOwn(options, "active") ? options.active ?? true : existing[0].active;
    const rows = await query(`UPDATE departments
        SET name = $2,
            section_id = $3,
            manager_user_id = $4,
            exco_user_id = $5,
            active = $6
      WHERE id = $1
      RETURNING id, name, section_id, manager_user_id, exco_user_id, active`, [existing[0].id, updatedDepartment, sectionId, managerUserId, excoUserId, active]);
    await query(`UPDATE users
        SET department = $1
      WHERE lower(trim(department)) = lower($2)`, [updatedDepartment, currentDepartment]);
    return rows[0];
}
export async function createSectionGroup(input, excoUserId) {
    const section = normalizeDepartmentName(input);
    if (section.length < 2)
        throw badRequest("Section name is required");
    await ensureSectionSchema();
    const ownerId = await assertEligibleOwner(excoUserId, ["CHIEF_OFFICER"], "Section EXCO owner");
    const existing = await query(`SELECT id, name
       FROM sections
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [section]);
    if (existing[0])
        return existing[0];
    const rows = await query(`INSERT INTO sections (id, name, exco_user_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, exco_user_id`, [randomUUID(), section, ownerId]);
    return rows[0];
}
export async function listSectionGroups() {
    await ensureSectionSchema();
    const rows = await query(`SELECT s.id,
            s.name,
            s.exco_user_id,
            exco.full_name AS exco_name,
            exco.email AS exco_email
       FROM sections s
       LEFT JOIN users exco ON exco.id = s.exco_user_id
      ORDER BY name`);
    return rows;
}
export async function updateSectionGroup(id, name, excoUserId) {
    const section = normalizeDepartmentName(name);
    if (!section)
        throw badRequest("Section name is required");
    await ensureSectionSchema();
    const existing = await query(`SELECT id
       FROM sections
      WHERE id = $1
      LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Section not found");
    const conflict = await query(`SELECT id
       FROM sections
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`, [section, id]);
    if (conflict[0])
        throw badRequest("Section name already exists");
    const ownerId = excoUserId === undefined ? undefined : await assertEligibleOwner(excoUserId, ["CHIEF_OFFICER"], "Section EXCO owner");
    const rows = await query(`UPDATE sections
        SET name = $2,
            exco_user_id = CASE WHEN $4::boolean = true THEN exco_user_id ELSE $3::uuid END
      WHERE id = $1
      RETURNING id, name, exco_user_id`, [id, section, ownerId ?? null, excoUserId === undefined]);
    return rows[0];
}
export async function deleteSectionGroup(id) {
    await ensureSectionSchema();
    const existing = await query(`SELECT id
       FROM sections
      WHERE id = $1
      LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Section not found");
    const assigned = await query(`SELECT true AS exists
       FROM departments
      WHERE section_id = $1
      LIMIT 1`, [id]);
    if (assigned[0])
        throw badRequest("Cannot delete a section with assigned departments");
    await query(`DELETE FROM sections WHERE id = $1`, [id]);
    return { ok: true };
}
export async function deleteDepartmentGroup(name) {
    const department = normalizeDepartmentName(name);
    if (!department)
        throw badRequest("Department name is required");
    await ensureDepartmentsTable();
    const existing = await query(`SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [department]);
    if (!existing[0])
        throw badRequest("Department not found");
    const assigned = await query(`SELECT true AS exists
       FROM users
      WHERE lower(trim(department)) = lower($1)
      LIMIT 1`, [department]);
    if (assigned[0])
        throw badRequest("Cannot delete a department with assigned users");
    await query(`DELETE FROM departments WHERE id = $1`, [existing[0].id]);
    return { ok: true };
}
export async function listEligibleLeadershipUsers() {
    const rows = await query(`SELECT id, full_name, email, employee_no, department, role::text AS role
       FROM users
      WHERE is_active = true
        AND role::text IN ('MANAGER', 'CHIEF_OFFICER')
      ORDER BY role, full_name NULLS LAST, email`);
    return {
        managers: rows.filter((row) => row.role === "MANAGER"),
        exco: rows.filter((row) => row.role === "CHIEF_OFFICER")
    };
}
export async function getDepartmentLeadership(departmentInput) {
    const department = normalizeDepartmentName(departmentInput);
    if (!department) {
        return {
            department: "",
            manager_user_id: null,
            exco_user_id: null
        };
    }
    await ensureDepartmentsTable();
    const rows = await query(`SELECT d.name AS department,
            d.manager_user_id,
            d.exco_user_id
       FROM departments d
      WHERE lower(trim(d.name)) = lower($1)
      LIMIT 1`, [department]);
    return rows[0] ?? {
        department,
        manager_user_id: null,
        exco_user_id: null
    };
}
