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

export function normalizeDepartmentName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

let departmentGroupsEnsured = false;

export async function ensureSectionSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS sections (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function ensureDepartmentsTable() {
  await ensureSectionSchema();
  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      section_id uuid REFERENCES sections(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES sections(id)
  `);
}

export async function ensureDepartmentGroups() {
  await ensureDepartmentsTable();
  if (departmentGroupsEnsured) return;

  for (const department of DEFAULT_DEPARTMENT_GROUPS) {
    await query(
      `INSERT INTO departments (id, name)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1
           FROM departments
          WHERE lower(trim(name)) = lower($2)
       )
       ON CONFLICT (name) DO NOTHING`,
      [randomUUID(), department]
    );
  }
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
  if (!department) throw badRequest("Department is required");

  const alias = DEPARTMENT_ALIASES.get(department.toLowerCase()) || department;

  await ensureDepartmentGroups();
  const rows = await query<{ department: string }>(
    `SELECT department
       FROM (
         SELECT trim(name) AS department
           FROM departments
          WHERE trim(name) <> ''
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

  if (!rows[0]) throw badRequest("Choose a valid department from the department groups list");
  return rows[0].department;
}

export async function createDepartmentGroup(input: string, sectionId?: string) {
  const department = normalizeDepartmentName(input);
  if (department.length < 2) throw badRequest("Department name is required");

  await ensureDepartmentsTable();
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (existing[0]) return existing[0];

  const rows = await query<{ id: string; name: string }>(
    `INSERT INTO departments (id, name, section_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name, section_id = EXCLUDED.section_id
     RETURNING id, name`,
    [randomUUID(), department, sectionId || null]
  );
  return rows[0];
}

export async function listDepartmentsWithSections() {
  await ensureDepartmentGroups();
  const rows = await query<{ id: string; name: string; section_id: string | null; section_name: string | null }>(
    `SELECT d.id, d.name, d.section_id, s.name AS section_name
       FROM departments d
       LEFT JOIN sections s ON s.id = d.section_id
      ORDER BY COALESCE(s.name, 'zzz'), d.name`
  );
  return rows;
}

export async function updateDepartmentGroup(oldName: string, newName: string, sectionId?: string | null) {
  const currentDepartment = normalizeDepartmentName(oldName);
  const updatedDepartment = normalizeDepartmentName(newName);
  if (!currentDepartment) throw badRequest("Current department is required");
  if (!updatedDepartment) throw badRequest("New department name is required");

  await ensureDepartmentsTable();
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [currentDepartment]
  );
  if (!existing[0]) throw badRequest("Department not found");

  const conflict = await query<{ id: string }>(
    `SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`,
    [updatedDepartment, existing[0].id]
  );
  if (conflict[0]) throw badRequest("Department name already exists");

  const rows = await query<{ id: string; name: string }>(
    `UPDATE departments
        SET name = $2,
            section_id = $3
      WHERE id = $1
      RETURNING id, name`,
    [existing[0].id, updatedDepartment, sectionId || null]
  );

  await query(
    `UPDATE users
        SET department = $1
      WHERE lower(trim(department)) = lower($2)`,
    [updatedDepartment, currentDepartment]
  );

  return rows[0];
}

export async function createSectionGroup(input: string) {
  const section = normalizeDepartmentName(input);
  if (section.length < 2) throw badRequest("Section name is required");

  await ensureSectionSchema();
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM sections
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [section]
  );
  if (existing[0]) return existing[0];

  const rows = await query<{ id: string; name: string }>(
    `INSERT INTO sections (id, name)
     VALUES ($1, $2)
     RETURNING id, name`,
    [randomUUID(), section]
  );
  return rows[0];
}

export async function listSectionGroups() {
  await ensureSectionSchema();
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name
       FROM sections
      ORDER BY name`
  );
  return rows;
}

export async function updateSectionGroup(id: string, name: string) {
  const section = normalizeDepartmentName(name);
  if (!section) throw badRequest("Section name is required");

  await ensureSectionSchema();
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM sections
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
  if (!existing[0]) throw badRequest("Section not found");

  const conflict = await query<{ id: string }>(
    `SELECT id
       FROM sections
      WHERE lower(trim(name)) = lower($1)
        AND id != $2
      LIMIT 1`,
    [section, id]
  );
  if (conflict[0]) throw badRequest("Section name already exists");

  const rows = await query<{ id: string; name: string }>(
    `UPDATE sections
        SET name = $2
      WHERE id = $1
      RETURNING id, name`,
    [id, section]
  );
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
  if (!existing[0]) throw badRequest("Section not found");

  const assigned = await query<{ exists: boolean }>(
    `SELECT true AS exists
       FROM departments
      WHERE section_id = $1
      LIMIT 1`,
    [id]
  );
  if (assigned[0]) throw badRequest("Cannot delete a section with assigned departments");

  await query(`DELETE FROM sections WHERE id = $1`, [id]);
  return { ok: true };
}

export async function deleteDepartmentGroup(name: string) {
  const department = normalizeDepartmentName(name);
  if (!department) throw badRequest("Department name is required");

  await ensureDepartmentsTable();
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM departments
      WHERE lower(trim(name)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (!existing[0]) throw badRequest("Department not found");

  const assigned = await query<{ exists: boolean }>(
    `SELECT true AS exists
       FROM users
      WHERE lower(trim(department)) = lower($1)
      LIMIT 1`,
    [department]
  );
  if (assigned[0]) throw badRequest("Cannot delete a department with assigned users");

  await query(`DELETE FROM departments WHERE id = $1`, [existing[0].id]);
  return { ok: true };
}
