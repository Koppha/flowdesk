import { randomUUID } from "crypto";
import { badRequest } from "./errors.js";
import { query } from "./db.js";
// ---------------------------------------------------------------------------
// Divisions (top-level org unit below Company)
// ---------------------------------------------------------------------------
let divisionsEnsured = false;
export async function ensureDivisionsTable() {
    await query(`
    CREATE TABLE IF NOT EXISTS divisions (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      description text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    divisionsEnsured = true;
}
export async function listDivisions() {
    await ensureDivisionsTable();
    return query(`SELECT id, name, description, active, created_at FROM divisions ORDER BY name`);
}
export async function createDivision(name, description) {
    const n = normalizeDepartmentName(name);
    if (n.length < 2)
        throw badRequest("Division name is required");
    await ensureDivisionsTable();
    const rows = await query(`INSERT INTO divisions (id, name, description, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, description, active`, [randomUUID(), n, description ?? null]);
    return rows[0];
}
export async function updateDivision(id, name, description, active) {
    const n = normalizeDepartmentName(name);
    if (!n)
        throw badRequest("Division name is required");
    await ensureDivisionsTable();
    const existing = await query(`SELECT id FROM divisions WHERE id = $1 LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Division not found");
    const conflict = await query(`SELECT id FROM divisions WHERE lower(trim(name)) = lower($1) AND id != $2 LIMIT 1`, [n, id]);
    if (conflict[0])
        throw badRequest("Division name already exists");
    const rows = await query(`UPDATE divisions SET name = $2, description = COALESCE($3, description), active = COALESCE($4, active) WHERE id = $1 RETURNING id, name, description, active`, [id, n, description ?? null, active ?? null]);
    return rows[0];
}
export async function deleteDivision(id) {
    await ensureDivisionsTable();
    const existing = await query(`SELECT id FROM divisions WHERE id = $1 LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Division not found");
    const hasDepts = await query(`SELECT true AS exists FROM departments WHERE division_id = $1 LIMIT 1`, [id]);
    if (hasDepts[0])
        throw badRequest("Cannot delete a division with assigned departments");
    await query(`DELETE FROM divisions WHERE id = $1`, [id]);
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Teams (optional layer below Section)
// ---------------------------------------------------------------------------
export async function ensureTeamsTable() {
    await ensureSectionSchemaWithDeptId();
    await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      section_id uuid REFERENCES sections(id),
      leader_user_id uuid REFERENCES users(id),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (name, section_id)
    )
  `);
}
export async function listTeams(sectionId) {
    await ensureTeamsTable();
    if (sectionId) {
        return query(`SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, u.email AS leader_email, t.active
         FROM teams t
         LEFT JOIN users u ON u.id = t.leader_user_id
        WHERE t.section_id = $1
        ORDER BY t.name`, [sectionId]);
    }
    return query(`SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, u.email AS leader_email, t.active
       FROM teams t
       LEFT JOIN users u ON u.id = t.leader_user_id
      ORDER BY t.name`);
}
export async function createTeam(name, sectionId, leaderUserId) {
    const n = normalizeDepartmentName(name);
    if (n.length < 2)
        throw badRequest("Team name is required");
    await ensureTeamsTable();
    const rows = await query(`INSERT INTO teams (id, name, section_id, leader_user_id, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, name, section_id, leader_user_id, active`, [randomUUID(), n, sectionId ?? null, leaderUserId ?? null]);
    return rows[0];
}
export async function updateTeam(id, name, sectionId, leaderUserId, active) {
    const n = normalizeDepartmentName(name);
    if (!n)
        throw badRequest("Team name is required");
    await ensureTeamsTable();
    const existing = await query(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Team not found");
    const rows = await query(`UPDATE teams
        SET name = $2,
            section_id = COALESCE($3, section_id),
            leader_user_id = $4,
            active = COALESCE($5, active)
      WHERE id = $1
      RETURNING id, name, section_id, leader_user_id, active`, [id, n, sectionId ?? null, leaderUserId ?? null, active ?? null]);
    return rows[0];
}
export async function deleteTeam(id) {
    await ensureTeamsTable();
    const existing = await query(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [id]);
    if (!existing[0])
        throw badRequest("Team not found");
    await query(`DELETE FROM teams WHERE id = $1`, [id]);
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Sections with department_id support
// ---------------------------------------------------------------------------
async function ensureSectionSchemaWithDeptId() {
    await ensureSectionSchema();
    await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id)`);
    await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`);
    await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS is_business_partner boolean NOT NULL DEFAULT false`);
    await query(`
    CREATE TABLE IF NOT EXISTS section_division_links (
      section_id  uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      PRIMARY KEY (section_id, division_id)
    )
  `);
}
async function syncSectionDivisions(sectionId, divisionIds) {
    await query(`DELETE FROM section_division_links WHERE section_id = $1`, [sectionId]);
    for (const divId of divisionIds) {
        await query(`INSERT INTO section_division_links (section_id, division_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [sectionId, divId]);
    }
}
export async function listSectionsForDepartment(departmentId) {
    await ensureSectionSchemaWithDeptId();
    return query(`SELECT id, name, department_id, exco_user_id, active FROM sections WHERE department_id = $1 ORDER BY name`, [departmentId]);
}
// ---------------------------------------------------------------------------
// Ensure user org FK columns exist
// ---------------------------------------------------------------------------
export async function ensureUserOrgColumns() {
    await ensureDivisionsTable();
    await ensureDepartmentsTable();
    await ensureSectionSchemaWithDeptId();
    await ensureTeamsTable();
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS division_id uuid REFERENCES divisions(id)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES sections(id)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id)`);
}
// Returns division/section/team names for a user's org IDs
export async function getUserOrgPath(userId) {
    await ensureUserOrgColumns();
    const rows = await query(`SELECT u.department, u.division_id, dv.name AS division_name,
            u.section_id, s.name AS section_name,
            u.team_id, t.name AS team_name
       FROM users u
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = $1 LIMIT 1`, [userId]);
    return rows[0] ?? null;
}
// ---------------------------------------------------------------------------
// Full org structure tree
// ---------------------------------------------------------------------------
export async function listOrgStructure() {
    await ensureDivisionsTable();
    await ensureDepartmentsTable();
    await ensureSectionSchemaWithDeptId();
    await ensureTeamsTable();
    const divisions = await query(`SELECT id, name, description, active FROM divisions ORDER BY name`);
    const departments = await query(`SELECT d.id, d.name, d.division_id, d.hod_user_id, hod.full_name AS hod_name, d.manager_user_id, m.full_name AS manager_name, d.active, d.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM department_division_links WHERE department_id = d.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids
       FROM departments d
       LEFT JOIN users hod ON hod.id = d.hod_user_id
       LEFT JOIN users m ON m.id = d.manager_user_id
      ORDER BY d.name`);
    const sections = await query(`SELECT s.id, s.name, s.department_id, s.active, s.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM section_division_links WHERE section_id = s.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids
       FROM sections s ORDER BY s.name`);
    const teams = await query(`SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, t.active
       FROM teams t
       LEFT JOIN users u ON u.id = t.leader_user_id
      ORDER BY t.name`);
    return { divisions, departments, sections, teams };
}
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
    await ensureDivisionsTable();
    await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      section_id uuid REFERENCES sections(id),
      division_id uuid REFERENCES divisions(id),
      hod_user_id uuid REFERENCES users(id),
      manager_user_id uuid REFERENCES users(id),
      exco_user_id uuid REFERENCES users(id),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES sections(id)`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS division_id uuid REFERENCES divisions(id)`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS hod_user_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS exco_user_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`);
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_business_partner boolean NOT NULL DEFAULT false`);
    await query(`
    CREATE TABLE IF NOT EXISTS department_division_links (
      department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      division_id   uuid NOT NULL REFERENCES divisions(id)   ON DELETE CASCADE,
      PRIMARY KEY (department_id, division_id)
    )
  `);
}
async function syncDepartmentDivisions(departmentId, divisionIds) {
    await query(`DELETE FROM department_division_links WHERE department_id = $1`, [departmentId]);
    for (const divId of divisionIds) {
        await query(`INSERT INTO department_division_links (department_id, division_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [departmentId, divId]);
    }
}
export async function ensureDepartmentGroups() {
    await ensureDepartmentsTable();
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
    const hodUserId = await assertEligibleOwner(options.hodUserId, ["HOD", "MANAGER"], "HOD");
    const managerUserId = await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager");
    const excoUserId = await assertEligibleOwner(options.excoUserId, ["CHIEF_OFFICER", "EXCO"], "EXCO owner");
    const existing = await query(`SELECT id, name
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [department]);
    if (existing[0])
        return existing[0];
    const bp = options.isBusinessPartner ?? false;
    const rows = await query(`INSERT INTO departments (id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (name) DO UPDATE
       SET name = EXCLUDED.name,
           section_id = EXCLUDED.section_id,
           division_id = EXCLUDED.division_id,
           hod_user_id = EXCLUDED.hod_user_id,
           manager_user_id = EXCLUDED.manager_user_id,
           exco_user_id = EXCLUDED.exco_user_id,
           active = EXCLUDED.active,
           is_business_partner = EXCLUDED.is_business_partner
     RETURNING id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner`, [randomUUID(), department, options.sectionId || null, options.divisionId || null, hodUserId, managerUserId, excoUserId, options.active ?? true, bp]);
    const created = rows[0];
    if (bp && options.divisionIds?.length)
        await syncDepartmentDivisions(created.id, options.divisionIds);
    return created;
}
export async function listDepartmentsWithSections() {
    await ensureDepartmentGroups();
    const rows = await query(`SELECT d.id,
            d.name,
            d.section_id,
            s.name AS section_name,
            d.division_id,
            dv.name AS division_name,
            d.hod_user_id,
            hod.full_name AS hod_name,
            hod.email AS hod_email,
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
       LEFT JOIN divisions dv ON dv.id = d.division_id
       LEFT JOIN users hod ON hod.id = d.hod_user_id
       LEFT JOIN users manager ON manager.id = d.manager_user_id
       LEFT JOIN users exco ON exco.id = d.exco_user_id
       LEFT JOIN users section_exco ON section_exco.id = s.exco_user_id
      ORDER BY COALESCE(dv.name, s.name, 'zzz'), d.name`);
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
    const existing = await query(`SELECT id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active
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
    const divisionId = hasOwn(options, "divisionId") ? options.divisionId ?? null : existing[0].division_id;
    const hodUserId = hasOwn(options, "hodUserId")
        ? await assertEligibleOwner(options.hodUserId, ["HOD", "MANAGER"], "HOD")
        : existing[0].hod_user_id;
    const managerUserId = hasOwn(options, "managerUserId")
        ? await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager")
        : existing[0].manager_user_id;
    const excoUserId = hasOwn(options, "excoUserId")
        ? await assertEligibleOwner(options.excoUserId, ["CHIEF_OFFICER", "EXCO"], "EXCO owner")
        : existing[0].exco_user_id;
    const active = hasOwn(options, "active") ? options.active ?? true : existing[0].active;
    const bp = hasOwn(options, "isBusinessPartner") ? (options.isBusinessPartner ?? false) : null;
    const rows = await query(`UPDATE departments
        SET name = $2,
            section_id = $3,
            division_id = $4,
            hod_user_id = $5,
            manager_user_id = $6,
            exco_user_id = $7,
            active = $8,
            is_business_partner = COALESCE($9, is_business_partner)
      WHERE id = $1
      RETURNING id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner`, [existing[0].id, updatedDepartment, sectionId, divisionId, hodUserId, managerUserId, excoUserId, active, bp]);
    await query(`UPDATE users
        SET department = $1
      WHERE lower(trim(department)) = lower($2)`, [updatedDepartment, currentDepartment]);
    if (hasOwn(options, "divisionIds") && options.divisionIds !== undefined) {
        await syncDepartmentDivisions(existing[0].id, options.divisionIds);
    }
    return rows[0];
}
export async function createSectionGroup(input, excoUserId, departmentId, isBusinessPartner, divisionIds) {
    const section = normalizeDepartmentName(input);
    if (section.length < 2)
        throw badRequest("Section name is required");
    await ensureSectionSchemaWithDeptId();
    const ownerId = await assertEligibleOwner(excoUserId, ["CHIEF_OFFICER", "EXCO"], "Section EXCO owner");
    const existing = await query(`SELECT id, name
       FROM sections
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`, [section]);
    if (existing[0])
        return existing[0];
    const bp = isBusinessPartner ?? false;
    const rows = await query(`INSERT INTO sections (id, name, exco_user_id, department_id, is_business_partner)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, exco_user_id, department_id, is_business_partner`, [randomUUID(), section, ownerId, departmentId ?? null, bp]);
    const created = rows[0];
    if (bp && divisionIds?.length)
        await syncSectionDivisions(created.id, divisionIds);
    return created;
}
export async function listSectionGroups() {
    await ensureSectionSchemaWithDeptId();
    const rows = await query(`SELECT s.id,
            s.name,
            s.department_id,
            d.name AS department_name,
            s.exco_user_id,
            exco.full_name AS exco_name,
            exco.email AS exco_email,
            s.active,
            s.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM section_division_links WHERE section_id = s.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids
       FROM sections s
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN users exco ON exco.id = s.exco_user_id
      ORDER BY s.name`);
    return rows;
}
export async function updateSectionGroup(id, name, excoUserId, departmentId, active, isBusinessPartner, divisionIds) {
    const section = normalizeDepartmentName(name);
    if (!section)
        throw badRequest("Section name is required");
    await ensureSectionSchemaWithDeptId();
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
    const ownerId = excoUserId === undefined ? undefined : await assertEligibleOwner(excoUserId, ["CHIEF_OFFICER", "EXCO"], "Section EXCO owner");
    const rows = await query(`UPDATE sections
        SET name = $2,
            exco_user_id = CASE WHEN $4::boolean = true THEN exco_user_id ELSE $3::uuid END,
            department_id = COALESCE($5::uuid, department_id),
            active = COALESCE($6, active),
            is_business_partner = COALESCE($7, is_business_partner)
      WHERE id = $1
      RETURNING id, name, exco_user_id, department_id, active, is_business_partner`, [id, section, ownerId ?? null, excoUserId === undefined, departmentId ?? null, active ?? null, isBusinessPartner ?? null]);
    if (divisionIds !== undefined)
        await syncSectionDivisions(id, divisionIds);
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
        AND role::text IN ('HOD', 'MANAGER', 'CHIEF_OFFICER', 'EXCO')
      ORDER BY role, full_name NULLS LAST, email`);
    return {
        hods: rows.filter((row) => row.role === "HOD" || row.role === "MANAGER"),
        managers: rows.filter((row) => row.role === "MANAGER"),
        exco: rows.filter((row) => row.role === "CHIEF_OFFICER" || row.role === "EXCO")
    };
}
export async function getDepartmentLeadership(departmentInput) {
    const department = normalizeDepartmentName(departmentInput);
    if (!department) {
        return {
            department: "",
            hod_user_id: null, hod_name: null,
            manager_user_id: null, manager_name: null,
            exco_user_id: null, exco_name: null, exco_title: null
        };
    }
    await ensureDepartmentsTable();
    const rows = await query(`SELECT d.name AS department,
            d.hod_user_id,     hod.full_name     AS hod_name,
            d.manager_user_id, manager.full_name AS manager_name,
            d.exco_user_id,    exco.full_name    AS exco_name,
                               exco.title        AS exco_title
       FROM departments d
       LEFT JOIN users hod     ON hod.id     = d.hod_user_id
       LEFT JOIN users manager ON manager.id = d.manager_user_id
       LEFT JOIN users exco    ON exco.id    = d.exco_user_id
      WHERE lower(trim(d.name)) = lower($1)
      LIMIT 1`, [department]);
    return rows[0] ?? {
        department,
        hod_user_id: null, hod_name: null,
        manager_user_id: null, manager_name: null,
        exco_user_id: null, exco_name: null, exco_title: null
    };
}
export async function ensureManagerTypesTable() {
    await query(`
    CREATE TABLE IF NOT EXISTS manager_types (
      id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text        NOT NULL UNIQUE,
      role        text        NOT NULL DEFAULT 'MANAGER',
      description text,
      active      boolean     NOT NULL DEFAULT true,
      sort_order  integer     NOT NULL DEFAULT 0,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    INSERT INTO manager_types (name, role, description, sort_order) VALUES
      ('Head of Department', 'HOD',     'Overall department head',          1),
      ('Senior Manager',     'MANAGER', 'Senior-level department manager',  2),
      ('Manager',            'MANAGER', 'Department manager',               3),
      ('Section Manager',    'MANAGER', 'Manages a specific section',       4),
      ('Team Leader',        'MANAGER', 'Leads a team within a section',    5)
    ON CONFLICT (name) DO NOTHING
  `);
}
export async function listManagerTypes() {
    await ensureManagerTypesTable();
    return query(`SELECT id, name, role, description, active, sort_order
       FROM manager_types
      ORDER BY sort_order, name`);
}
export async function createManagerType(name, role, description) {
    await ensureManagerTypesTable();
    const rows = await query(`INSERT INTO manager_types (name, role, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, role, description, active, sort_order`, [name.trim(), role, description?.trim() || null]);
    return rows[0];
}
export async function updateManagerType(id, name, role, description, active) {
    await ensureManagerTypesTable();
    const rows = await query(`UPDATE manager_types
        SET name=$2, role=$3, description=$4,
            active=COALESCE($5::boolean, active),
            updated_at=now()
      WHERE id=$1
      RETURNING id, name, role, description, active, sort_order`, [id, name.trim(), role, description?.trim() || null, active ?? null]);
    if (!rows[0])
        throw new Error("Manager type not found");
    return rows[0];
}
export async function deleteManagerType(id) {
    await ensureManagerTypesTable();
    await query(`UPDATE manager_types SET active=false, updated_at=now() WHERE id=$1`, [id]);
}
