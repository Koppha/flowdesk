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
  "Digital Services",
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
  "Network Planning",
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

export async function ensureDepartmentsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
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

export async function createDepartmentGroup(input: string) {
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
    `INSERT INTO departments (id, name)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [randomUUID(), department]
  );
  return rows[0];
}
