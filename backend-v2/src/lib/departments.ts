import { randomUUID } from "crypto";
import { badRequest } from "./errors.js";
import { query } from "./db.js";
import { notifyPositionAssigned } from "./notifications.js";

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
  return query<{ id: string; name: string; description: string | null; active: boolean; created_at: string }>(
    `SELECT id, name, description, active, created_at FROM divisions ORDER BY name`
  );
}

export async function createDivision(name: string, description?: string | null) {
  const n = normalizeDepartmentName(name);
  if (n.length < 2) throw badRequest("Company name is required");
  await ensureDivisionsTable();
  const rows = await query<{ id: string; name: string; description: string | null; active: boolean }>(
    `INSERT INTO divisions (id, name, description, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, description, active`,
    [randomUUID(), n, description ?? null]
  );
  return rows[0];
}

export async function updateDivision(id: string, name: string, description?: string | null, active?: boolean) {
  const n = normalizeDepartmentName(name);
  if (!n) throw badRequest("Company name is required");
  await ensureDivisionsTable();
  const existing = await query<{ id: string }>(`SELECT id FROM divisions WHERE id = $1 LIMIT 1`, [id]);
  if (!existing[0]) throw badRequest("Company not found");
  const conflict = await query<{ id: string }>(`SELECT id FROM divisions WHERE lower(trim(name)) = lower($1) AND id != $2 LIMIT 1`, [n, id]);
  if (conflict[0]) throw badRequest("Company name already exists");
  const rows = await query<{ id: string; name: string; description: string | null; active: boolean }>(
    `UPDATE divisions SET name = $2, description = COALESCE($3, description), active = COALESCE($4, active) WHERE id = $1 RETURNING id, name, description, active`,
    [id, n, description ?? null, active ?? null]
  );
  return rows[0];
}

export async function deleteDivision(id: string) {
  await ensureDivisionsTable();
  const existing = await query<{ id: string }>(`SELECT id FROM divisions WHERE id = $1 LIMIT 1`, [id]);
  if (!existing[0]) throw badRequest("Company not found");
  const hasDepts = await query<{ exists: boolean }>(`SELECT true AS exists FROM departments WHERE division_id = $1 LIMIT 1`, [id]);
  if (hasDepts[0]) throw badRequest("Cannot delete a company with assigned divisions");
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

export async function listTeams(sectionId?: string) {
  await ensureTeamsTable();
  if (sectionId) {
    return query<{ id: string; name: string; section_id: string | null; leader_user_id: string | null; leader_name: string | null; leader_email: string | null; active: boolean }>(
      `SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, u.email AS leader_email, t.active
         FROM teams t
         LEFT JOIN users u ON u.id = t.leader_user_id
        WHERE t.section_id = $1
        ORDER BY t.name`,
      [sectionId]
    );
  }
  return query<{ id: string; name: string; section_id: string | null; leader_user_id: string | null; leader_name: string | null; leader_email: string | null; active: boolean }>(
    `SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, u.email AS leader_email, t.active
       FROM teams t
       LEFT JOIN users u ON u.id = t.leader_user_id
      ORDER BY t.name`
  );
}

export async function createTeam(name: string, sectionId?: string | null, leaderUserId?: string | null) {
  const n = normalizeDepartmentName(name);
  if (n.length < 2) throw badRequest("Section name is required");
  await ensureTeamsTable();
  const rows = await query<{ id: string; name: string; section_id: string | null; leader_user_id: string | null; active: boolean }>(
    `INSERT INTO teams (id, name, section_id, leader_user_id, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, name, section_id, leader_user_id, active`,
    [randomUUID(), n, sectionId ?? null, leaderUserId ?? null]
  );
  return rows[0];
}

export async function updateTeam(id: string, name: string, sectionId?: string | null, leaderUserId?: string | null, active?: boolean) {
  const n = normalizeDepartmentName(name);
  if (!n) throw badRequest("Section name is required");
  await ensureTeamsTable();
  const existing = await query<{ id: string }>(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [id]);
  if (!existing[0]) throw badRequest("Section not found");
  const rows = await query<{ id: string; name: string; section_id: string | null; leader_user_id: string | null; active: boolean }>(
    `UPDATE teams
        SET name = $2,
            section_id = COALESCE($3, section_id),
            leader_user_id = $4,
            active = COALESCE($5, active)
      WHERE id = $1
      RETURNING id, name, section_id, leader_user_id, active`,
    [id, n, sectionId ?? null, leaderUserId ?? null, active ?? null]
  );
  return rows[0];
}

export async function deleteTeam(id: string) {
  await ensureTeamsTable();
  const existing = await query<{ id: string }>(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [id]);
  if (!existing[0]) throw badRequest("Section not found");
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

async function syncSectionDivisions(sectionId: string, divisionIds: string[]) {
  await query(`DELETE FROM section_division_links WHERE section_id = $1`, [sectionId]);
  for (const divId of divisionIds) {
    await query(
      `INSERT INTO section_division_links (section_id, division_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sectionId, divId]
    );
  }
}

export async function listSectionsForDepartment(departmentId: string) {
  await ensureSectionSchemaWithDeptId();
  return query<{ id: string; name: string; department_id: string | null; exco_user_id: string | null; active: boolean }>(
    `SELECT id, name, department_id, exco_user_id, active FROM sections WHERE department_id = $1 ORDER BY name`,
    [departmentId]
  );
}

// ---------------------------------------------------------------------------
// Ensure user org FK columns exist
// ---------------------------------------------------------------------------

export async function ensureUserOrgColumns() {
  await ensureDivisionsTable();
  await ensureDepartmentsTable();
  await ensureSectionSchemaWithDeptId();
  await ensureTeamsTable();
  await ensureManagerTypesTable();
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS division_id uuid REFERENCES divisions(id)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES sections(id)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_type_id uuid REFERENCES manager_types(id)`);
  // One-time backfill: a user's Company (division_id) used to only get set
  // when they were created/edited through the org picker. Assigning someone
  // as a department's manager/HOD elsewhere (e.g. Management page's "Add
  // division…" picker) set their department but left division_id untouched,
  // so managers placed that way silently showed up as "Unassigned" instead
  // of their department's actual company. Only fills blanks - never
  // overwrites a division_id someone deliberately set.
  await query(`
    UPDATE users u
       SET division_id = d.division_id
      FROM departments d
     WHERE u.division_id IS NULL
       AND d.division_id IS NOT NULL
       AND trim(u.department) = d.name
  `);
}

// Returns division/section/team names for a user's org IDs
export async function getUserOrgPath(userId: string) {
  await ensureUserOrgColumns();
  const rows = await query<{
    department: string | null;
    division_id: string | null;
    division_name: string | null;
    section_id: string | null;
    section_name: string | null;
    team_id: string | null;
    team_name: string | null;
  }>(
    `SELECT u.department, u.division_id, dv.name AS division_name,
            u.section_id, s.name AS section_name,
            u.team_id, t.name AS team_name
       FROM users u
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.id = $1 LIMIT 1`,
    [userId]
  );
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

  const divisions = await query<{ id: string; name: string; description: string | null; active: boolean }>(
    `SELECT id, name, description, active FROM divisions ORDER BY name`
  );

  const departments = await query<{ id: string; name: string; division_id: string | null; hod_user_id: string | null; hod_name: string | null; manager_user_id: string | null; manager_name: string | null; active: boolean; is_business_partner: boolean; division_ids: string[] }>(
    `SELECT d.id, d.name, d.division_id, d.hod_user_id, hod.full_name AS hod_name, d.manager_user_id, m.full_name AS manager_name, d.active, d.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM department_division_links WHERE department_id = d.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids
       FROM departments d
       LEFT JOIN users hod ON hod.id = d.hod_user_id
       LEFT JOIN users m ON m.id = d.manager_user_id
      ORDER BY d.name`
  );

  const sections = await query<{ id: string; name: string; department_id: string | null; active: boolean; is_business_partner: boolean; division_ids: string[]; hod_user_id: string | null; hod_name: string | null; hod_email: string | null; manager_user_id: string | null; manager_name: string | null; manager_email: string | null; exco_user_id: string | null; exco_name: string | null; exco_email: string | null }>(
    `SELECT s.id, s.name, s.department_id, s.active, s.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM section_division_links WHERE section_id = s.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids,
            s.hod_user_id, hod.full_name AS hod_name, hod.email AS hod_email,
            s.manager_user_id, m.full_name AS manager_name, m.email AS manager_email,
            s.exco_user_id, exco.full_name AS exco_name, exco.email AS exco_email
       FROM sections s
       LEFT JOIN users hod ON hod.id = s.hod_user_id
       LEFT JOIN users m ON m.id = s.manager_user_id
       LEFT JOIN users exco ON exco.id = s.exco_user_id
      ORDER BY s.name`
  );

  const teams = await query<{ id: string; name: string; section_id: string | null; leader_user_id: string | null; leader_name: string | null; active: boolean }>(
    `SELECT t.id, t.name, t.section_id, t.leader_user_id, u.full_name AS leader_name, t.active
       FROM teams t
       LEFT JOIN users u ON u.id = t.leader_user_id
      ORDER BY t.name`
  );

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

export function normalizeDepartmentName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

let departmentGroupsEnsured = false;

type DepartmentOwnerInput = {
  sectionId?: string | null;
  divisionId?: string | null;
  hodUserId?: string | null;
  managerUserId?: string | null;
  excoUserId?: string | null;
  active?: boolean;
  isBusinessPartner?: boolean;
  divisionIds?: string[];
};

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function assertEligibleOwner(userId: string | null | undefined, roles: string[], label: string) {
  if (!userId) return null;
  const rows = await query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE id = $1
        AND is_active = true
        AND role::text = ANY($2::text[])
      LIMIT 1`,
    [userId, roles]
  );
  if (!rows[0]) throw badRequest(`${label} must be an active ${roles.join(" or ").toLowerCase().replace(/_/g, " ")} user`);
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
  await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS hod_user_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id)`);
}

export async function setSectionOwner(sectionId: string, role: "HOD" | "MANAGER", userId: string | null) {
  await ensureSectionSchemaWithDeptId();
  const existing = await query<{ id: string }>(`SELECT id FROM sections WHERE id = $1 LIMIT 1`, [sectionId]);
  if (!existing[0]) throw badRequest("Department not found");

  const resolvedUserId = role === "HOD"
    ? await assertEligibleOwner(userId, ["HOD", "MANAGER"], "HOD")
    : await assertEligibleOwner(userId, ["MANAGER"], "Manager");

  const column = role === "HOD" ? "hod_user_id" : "manager_user_id";
  const rows = await query<{ id: string; name: string; hod_user_id: string | null; manager_user_id: string | null }>(
    `UPDATE sections SET ${column} = $2 WHERE id = $1 RETURNING id, name, hod_user_id, manager_user_id`,
    [sectionId, resolvedUserId]
  );
  return rows[0];
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

async function syncDepartmentDivisions(departmentId: string, divisionIds: string[]) {
  await query(`DELETE FROM department_division_links WHERE department_id = $1`, [departmentId]);
  for (const divId of divisionIds) {
    await query(
      `INSERT INTO department_division_links (department_id, division_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [departmentId, divId]
    );
  }
}

export async function ensureDepartmentGroups() {
  await ensureDepartmentsTable();
  departmentGroupsEnsured = true;
}

export async function listDepartmentGroups() {
  await ensureDepartmentGroups();
  const rows = await query<{ department: string }>(
    `SELECT department
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
      ORDER BY department`
  );
  return rows.map((row) => row.department);
}

const DEPARTMENT_ALIASES = new Map<string, string>([
  ["sefs finance", "SEFS Finance"],
  ["sefs department", "SEFS Finance"]
]);

export async function resolveDepartmentGroup(input: string) {
  const department = normalizeDepartmentName(input);
  if (!department) throw badRequest("Division is required");

  const alias = DEPARTMENT_ALIASES.get(department.toLowerCase()) || department;

  await ensureDepartmentGroups();
  const rows = await query<{ department: string }>(
    `SELECT department
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
      LIMIT 1`,
    [alias]
  );

  if (!rows[0]) throw badRequest("Choose a valid division from the division groups list");
  return rows[0].department;
}

export async function resolveSectionGroup(input: string) {
  const section = normalizeDepartmentName(input);
  if (!section) throw badRequest("Department is required");

  await ensureSectionSchema();
  const rows = await query<{ section: string }>(
    `SELECT trim(name) AS section
       FROM sections
      WHERE trim(name) <> ''
        AND lower(trim(name)) = lower($1)
      ORDER BY name
      LIMIT 1`,
    [section]
  );

  if (!rows[0]) throw badRequest("Choose a valid department from the departments list");
  return rows[0].section;
}

export async function createDepartmentGroup(input: string, sectionId?: string | DepartmentOwnerInput) {
  const options = typeof sectionId === "object" ? sectionId as DepartmentOwnerInput : { sectionId };
  const department = normalizeDepartmentName(input);
  if (department.length < 2) throw badRequest("Division name is required");

  await ensureDepartmentsTable();
  const hodUserId = await assertEligibleOwner(options.hodUserId, ["HOD", "MANAGER"], "HOD");
  const managerUserId = await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager");
  const excoUserId = await assertEligibleOwner(options.excoUserId, ["EXCO"], "EXCO member");
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (existing[0]) return existing[0];

  const bp = options.isBusinessPartner ?? false;
  const rows = await query<{ id: string; name: string; section_id: string | null; division_id: string | null; hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null; active: boolean; is_business_partner: boolean }>(
    `INSERT INTO departments (id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner)
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
     RETURNING id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner`,
    [randomUUID(), department, options.sectionId || null, options.divisionId || null, hodUserId, managerUserId, excoUserId, options.active ?? true, bp]
  );
  const created = rows[0];
  if (bp && options.divisionIds?.length) await syncDepartmentDivisions(created.id, options.divisionIds);
  return created;
}

export async function listDepartmentsWithSections() {
  await ensureDepartmentGroups();
  const rows = await query<{
    id: string;
    name: string;
    section_id: string | null;
    section_name: string | null;
    division_id: string | null;
    division_name: string | null;
    hod_user_id: string | null;
    hod_name: string | null;
    hod_email: string | null;
    manager_user_id: string | null;
    manager_name: string | null;
    manager_email: string | null;
    exco_user_id: string | null;
    exco_name: string | null;
    exco_email: string | null;
    section_exco_user_id: string | null;
    section_exco_name: string | null;
    section_exco_email: string | null;
    active: boolean;
  }>(
    `SELECT d.id,
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
      ORDER BY COALESCE(dv.name, s.name, 'zzz'), d.name`
  );
  return rows;
}

export async function updateDepartmentGroup(oldName: string, newName: string, options: DepartmentOwnerInput = {}) {
  const currentDepartment = normalizeDepartmentName(oldName);
  const updatedDepartment = normalizeDepartmentName(newName);
  if (!currentDepartment) throw badRequest("Current division is required");
  if (!updatedDepartment) throw badRequest("New division name is required");

  await ensureDepartmentsTable();
  const existing = await query<{ id: string; name: string; section_id: string | null; division_id: string | null; hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null; active: boolean }>(
    `SELECT id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [currentDepartment]
  );
  if (!existing[0]) throw badRequest("Division not found");

  const conflict = await query<{ id: string }>(
    `SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`,
    [updatedDepartment, existing[0].id]
  );
  if (conflict[0]) throw badRequest("Division name already exists");

  const sectionId = hasOwn(options, "sectionId") ? options.sectionId ?? null : existing[0].section_id;
  const divisionId = hasOwn(options, "divisionId") ? options.divisionId ?? null : existing[0].division_id;
  const hodUserId = hasOwn(options, "hodUserId")
    ? await assertEligibleOwner(options.hodUserId, ["HOD", "MANAGER"], "HOD")
    : existing[0].hod_user_id;
  const managerUserId = hasOwn(options, "managerUserId")
    ? await assertEligibleOwner(options.managerUserId, ["MANAGER"], "Manager")
    : existing[0].manager_user_id;
  const excoUserId = hasOwn(options, "excoUserId")
    ? await assertEligibleOwner(options.excoUserId, ["EXCO"], "EXCO member")
    : existing[0].exco_user_id;
  const active = hasOwn(options, "active") ? options.active ?? true : existing[0].active;
  const bp = hasOwn(options, "isBusinessPartner") ? (options.isBusinessPartner ?? false) : null;

  const rows = await query<{ id: string; name: string; section_id: string | null; division_id: string | null; hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null; active: boolean; is_business_partner: boolean }>(
    `UPDATE departments
        SET name = $2,
            section_id = $3,
            division_id = $4,
            hod_user_id = $5,
            manager_user_id = $6,
            exco_user_id = $7,
            active = $8,
            is_business_partner = COALESCE($9, is_business_partner)
      WHERE id = $1
      RETURNING id, name, section_id, division_id, hod_user_id, manager_user_id, exco_user_id, active, is_business_partner`,
    [existing[0].id, updatedDepartment, sectionId, divisionId, hodUserId, managerUserId, excoUserId, active, bp]
  );

  await query(
    `UPDATE users
        SET department = $1
      WHERE lower(trim(department)) = lower($2)`,
    [updatedDepartment, currentDepartment]
  );

  if (hasOwn(options, "divisionIds") && options.divisionIds !== undefined) {
    await syncDepartmentDivisions(existing[0].id, options.divisionIds);
  }

  await notifyNewPositionAssignees(updatedDepartment, "Division", [
    { label: "HOD", oldId: existing[0].hod_user_id, newId: hodUserId },
    { label: "Manager", oldId: existing[0].manager_user_id, newId: managerUserId },
    { label: "Exco Member", oldId: existing[0].exco_user_id, newId: excoUserId }
  ]);

  return rows[0];
}

// Fires an "invitation" notification for any leadership slot that was just
// filled with a different (or newly-assigned) user, so a vacant position
// created earlier can be filled later and the assignee is notified.
async function notifyNewPositionAssignees(
  groupLabel: string,
  groupType: "Division" | "Department",
  slots: { label: string; oldId: string | null; newId: string | null }[]
) {
  const changed = slots.filter((s) => s.newId && s.newId !== s.oldId);
  if (!changed.length) return;
  const users = await query<{ id: string; full_name: string | null; email: string | null }>(
    `SELECT id, full_name, email FROM users WHERE id = ANY($1)`,
    [changed.map((s) => s.newId)]
  );
  for (const slot of changed) {
    const user = users.find((u) => u.id === slot.newId);
    if (!user) continue;
    void notifyPositionAssigned({
      assigneeName: user.full_name,
      assigneeEmail: user.email,
      positionLabel: slot.label,
      groupLabel,
      groupType
    });
  }
}

export async function createSectionGroup(input: string, excoUserId?: string | null, departmentId?: string | null, isBusinessPartner?: boolean, divisionIds?: string[]) {
  const section = normalizeDepartmentName(input);
  if (section.length < 2) throw badRequest("Department name is required");

  await ensureSectionSchemaWithDeptId();
  const ownerId = await assertEligibleOwner(excoUserId, ["EXCO"], "Department EXCO member");
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM sections
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [section]
  );
  if (existing[0]) return existing[0];

  const bp = isBusinessPartner ?? false;
  const rows = await query<{ id: string; name: string; exco_user_id: string | null; department_id: string | null; is_business_partner: boolean }>(
    `INSERT INTO sections (id, name, exco_user_id, department_id, is_business_partner)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, exco_user_id, department_id, is_business_partner`,
    [randomUUID(), section, ownerId, departmentId ?? null, bp]
  );
  const created = rows[0];
  if (bp && divisionIds?.length) await syncSectionDivisions(created.id, divisionIds);
  return created;
}

export async function listSectionGroups() {
  await ensureSectionSchemaWithDeptId();
  const rows = await query<{
    id: string;
    name: string;
    department_id: string | null;
    department_name: string | null;
    exco_user_id: string | null;
    exco_name: string | null;
    exco_email: string | null;
    hod_user_id: string | null;
    hod_name: string | null;
    manager_user_id: string | null;
    manager_name: string | null;
    active: boolean;
    is_business_partner: boolean;
    division_ids: string[];
  }>(
    `SELECT s.id,
            s.name,
            s.department_id,
            d.name AS department_name,
            s.exco_user_id,
            exco.full_name AS exco_name,
            exco.email AS exco_email,
            s.hod_user_id,
            hod.full_name AS hod_name,
            s.manager_user_id,
            manager.full_name AS manager_name,
            s.active,
            s.is_business_partner,
            COALESCE(
              ARRAY(SELECT division_id FROM section_division_links WHERE section_id = s.id ORDER BY division_id),
              '{}'::uuid[]
            ) AS division_ids
       FROM sections s
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN users exco ON exco.id = s.exco_user_id
       LEFT JOIN users hod ON hod.id = s.hod_user_id
       LEFT JOIN users manager ON manager.id = s.manager_user_id
      ORDER BY s.name`
  );
  return rows;
}

export async function updateSectionGroup(id: string, name: string, excoUserId?: string | null, departmentId?: string | null, active?: boolean, isBusinessPartner?: boolean, divisionIds?: string[]) {
  const section = normalizeDepartmentName(name);
  if (!section) throw badRequest("Department name is required");

  await ensureSectionSchemaWithDeptId();
  const existing = await query<{ id: string; exco_user_id: string | null }>(
    `SELECT id, exco_user_id
       FROM sections
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
  if (!existing[0]) throw badRequest("Department not found");

  const conflict = await query<{ id: string }>(
    `SELECT id
       FROM sections
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`,
    [section, id]
  );
  if (conflict[0]) throw badRequest("Department name already exists");

  const ownerId = excoUserId === undefined ? undefined : await assertEligibleOwner(excoUserId, ["EXCO"], "Department EXCO member");
  const rows = await query<{ id: string; name: string; exco_user_id: string | null; department_id: string | null; active: boolean; is_business_partner: boolean }>(
    `UPDATE sections
        SET name = $2,
            exco_user_id = CASE WHEN $4::boolean = true THEN exco_user_id ELSE $3::uuid END,
            department_id = COALESCE($5::uuid, department_id),
            active = COALESCE($6, active),
            is_business_partner = COALESCE($7, is_business_partner)
      WHERE id = $1
      RETURNING id, name, exco_user_id, department_id, active, is_business_partner`,
    [id, section, ownerId ?? null, excoUserId === undefined, departmentId ?? null, active ?? null, isBusinessPartner ?? null]
  );
  if (divisionIds !== undefined) await syncSectionDivisions(id, divisionIds);

  await notifyNewPositionAssignees(section, "Department", [
    { label: "Exco Member", oldId: existing[0].exco_user_id, newId: ownerId ?? (excoUserId === undefined ? existing[0].exco_user_id : null) }
  ]);

  return rows[0];
}

export async function deleteSectionGroup(id: string) {
  await ensureSectionSchema();
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM sections
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
  if (!existing[0]) throw badRequest("Department not found");

  const assigned = await query<{ exists: boolean }>(
    `SELECT true AS exists
       FROM departments
      WHERE section_id = $1
      LIMIT 1`,
    [id]
  );
  if (assigned[0]) throw badRequest("Cannot delete a department with assigned divisions");

  await query(`DELETE FROM sections WHERE id = $1`, [id]);
  return { ok: true };
}

export async function deleteDepartmentGroup(name: string) {
  const department = normalizeDepartmentName(name);
  if (!department) throw badRequest("Division name is required");

  await ensureDepartmentsTable();
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (!existing[0]) throw badRequest("Division not found");

  const assigned = await query<{ exists: boolean }>(
    `SELECT true AS exists
       FROM users
      WHERE lower(trim(department)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (assigned[0]) throw badRequest("Cannot delete a division with assigned users");

  await query(`DELETE FROM departments WHERE id = $1`, [existing[0].id]);
  return { ok: true };
}

export async function listEligibleLeadershipUsers() {
  const rows = await query<{
    id: string;
    full_name: string | null;
    email: string;
    employee_no: string | null;
    department: string | null;
    role: string;
  }>(
    `SELECT id, full_name, email, employee_no, department, role::text AS role
       FROM users
      WHERE is_active = true
        AND role::text IN ('HOD', 'MANAGER', 'EXCO')
      ORDER BY role, full_name NULLS LAST, email`
  );
  return {
    hods: rows.filter((row) => row.role === "HOD" || row.role === "MANAGER"),
    managers: rows.filter((row) => row.role === "MANAGER"),
    exco: rows.filter((row) => row.role === "EXCO")
  };
}

export async function getDepartmentLeadership(departmentInput: string) {
  const department = normalizeDepartmentName(departmentInput);
  if (!department) {
    return {
      department: "",
      hod_user_id: null, hod_name: null, hod_title: null, hod_email: null,
      manager_user_id: null, manager_name: null, manager_title: null, manager_email: null,
      exco_user_id: null, exco_name: null, exco_title: null, exco_email: null
    };
  }

  await ensureDepartmentsTable();
  const rows = await query<{
    department: string;
    hod_user_id: string | null;
    hod_name: string | null;
    hod_title: string | null;
    hod_email: string | null;
    manager_user_id: string | null;
    manager_name: string | null;
    manager_title: string | null;
    manager_email: string | null;
    exco_user_id: string | null;
    exco_name: string | null;
    exco_title: string | null;
    exco_email: string | null;
  }>(
    `SELECT d.name AS department,
            CASE WHEN hod.id     IS NOT NULL THEN d.hod_user_id     ELSE NULL END AS hod_user_id,
            hod.full_name     AS hod_name,     hod.title     AS hod_title,     hod.email     AS hod_email,
            CASE WHEN manager.id IS NOT NULL THEN d.manager_user_id ELSE NULL END AS manager_user_id,
            manager.full_name AS manager_name, manager.title AS manager_title, manager.email AS manager_email,
            CASE WHEN exco.id    IS NOT NULL THEN d.exco_user_id    ELSE NULL END AS exco_user_id,
            exco.full_name    AS exco_name,
            exco.title        AS exco_title,
            exco.email        AS exco_email
       FROM departments d
       LEFT JOIN users hod     ON hod.id     = d.hod_user_id     AND hod.is_active     = true
       LEFT JOIN users manager ON manager.id = d.manager_user_id AND manager.is_active = true
       LEFT JOIN users exco    ON exco.id    = d.exco_user_id    AND exco.is_active    = true
      WHERE lower(trim(d.name)) = lower($1)
      LIMIT 1`,
    [department]
  );

  return rows[0] ?? {
    department,
    hod_user_id: null, hod_name: null, hod_title: null, hod_email: null,
    manager_user_id: null, manager_name: null, manager_title: null, manager_email: null,
    exco_user_id: null, exco_name: null, exco_title: null, exco_email: null
  };
}

// Section-level leadership, for the "closest fallback available" step in
// resolveRequesterManager (workflowEngine.ts) - a section is a strictly
// closer org unit than its parent department, so it should be tried first.
// Derived live from who currently holds each role *tagged to this section*
// (users.role + users.section_id) rather than sections.hod_user_id/
// manager_user_id/exco_user_id - those dedicated fields exist but are almost
// never populated in practice (same as the equivalent department fields
// above), while a real person holding the role is reliably findable this
// way - e.g. Technical's four sections each have a real HOD by role, even
// though sections.hod_user_id is blank for all of them.
export async function getSectionLeadership(sectionId: string) {
  if (!sectionId) {
    return {
      section_id: null,
      hod_user_id: null, hod_name: null, hod_title: null, hod_email: null,
      manager_user_id: null, manager_name: null, manager_title: null, manager_email: null,
      exco_user_id: null, exco_name: null, exco_title: null, exco_email: null
    };
  }
  const rows = await query<{
    hod_user_id: string | null; hod_name: string | null; hod_title: string | null; hod_email: string | null;
    manager_user_id: string | null; manager_name: string | null; manager_title: string | null; manager_email: string | null;
    exco_user_id: string | null; exco_name: string | null; exco_title: string | null; exco_email: string | null;
  }>(
    `SELECT hod.id AS hod_user_id, hod.full_name AS hod_name, hod.title AS hod_title, hod.email AS hod_email,
            mgr.id AS manager_user_id, mgr.full_name AS manager_name, mgr.title AS manager_title, mgr.email AS manager_email,
            exco.id AS exco_user_id, exco.full_name AS exco_name, exco.title AS exco_title, exco.email AS exco_email
       FROM (SELECT 1) placeholder
       LEFT JOIN LATERAL (
         SELECT id, full_name, title, email FROM users WHERE section_id=$1 AND role='HOD' AND is_active=true ORDER BY full_name LIMIT 1
       ) hod ON true
       LEFT JOIN LATERAL (
         SELECT id, full_name, title, email FROM users WHERE section_id=$1 AND role='MANAGER' AND is_active=true ORDER BY full_name LIMIT 1
       ) mgr ON true
       LEFT JOIN LATERAL (
         SELECT id, full_name, title, email FROM users WHERE section_id=$1 AND role='EXCO' AND is_active=true ORDER BY full_name LIMIT 1
       ) exco ON true`,
    [sectionId]
  );
  return rows[0]
    ? { section_id: sectionId, ...rows[0] }
    : {
        section_id: sectionId,
        hod_user_id: null, hod_name: null, hod_title: null, hod_email: null,
        manager_user_id: null, manager_name: null, manager_title: null, manager_email: null,
        exco_user_id: null, exco_name: null, exco_title: null, exco_email: null
      };
}

// ─── Manager Types ────────────────────────────────────────────────────────────

export type ManagerType = {
  id: string;
  name: string;
  role: string;
  description: string | null;
  active: boolean;
  sort_order: number;
};

export async function ensureManagerTypesTable(): Promise<void> {
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
      ('Team Leader',        'MANAGER', 'Leads a team within a section',    5),
      ('Exco Member',        'EXCO',    'Executive committee member',       6)
    ON CONFLICT (name) DO NOTHING
  `);
}

export async function listManagerTypes(): Promise<ManagerType[]> {
  await ensureManagerTypesTable();
  return query<ManagerType>(
    `SELECT id, name, role, description, active, sort_order
       FROM manager_types
      ORDER BY sort_order, name`
  );
}

export async function createManagerType(name: string, role: string, description?: string | null): Promise<ManagerType> {
  await ensureManagerTypesTable();
  const rows = await query<ManagerType>(
    `INSERT INTO manager_types (name, role, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, role, description, active, sort_order`,
    [name.trim(), role, description?.trim() || null]
  );
  return rows[0];
}

export async function updateManagerType(id: string, name: string, role: string, description?: string | null, active?: boolean): Promise<ManagerType> {
  await ensureManagerTypesTable();
  const rows = await query<ManagerType>(
    `UPDATE manager_types
        SET name=$2, role=$3, description=$4,
            active=COALESCE($5::boolean, active),
            updated_at=now()
      WHERE id=$1
      RETURNING id, name, role, description, active, sort_order`,
    [id, name.trim(), role, description?.trim() || null, active ?? null]
  );
  if (!rows[0]) throw new Error("Manager type not found");
  return rows[0];
}

export async function deleteManagerType(id: string): Promise<void> {
  await ensureManagerTypesTable();
  await query(`UPDATE manager_types SET active=false, updated_at=now() WHERE id=$1`, [id]);
}
