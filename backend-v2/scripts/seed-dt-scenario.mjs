/**
 * Seed script: Digital Transformation department scenario
 *
 * Creates:
 *   - 8 dummy users covering every approval role for DT
 *   - Ensures the "Digital Transformation" department row exists and has
 *     manager_user_id, hod_user_id, and exco_user_id set
 *   - (Re)creates the DT Advance Request workflow with the 6-step chain:
 *       Employee → Manager/Supervisor → HOD → HR Manager → HR → Finance
 *   - Creates the DT Clearance workflow with the 5-step chain:
 *       Employee → HOD → EXCO Member → HR → Finance
 *
 * Run once:  node scripts/seed-dt-scenario.mjs
 */

import bcrypt from "bcrypt";
import pg from "pg";
import { randomUUID } from "crypto";

const { Client } = pg;

const DB_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:Admin%40ETL111%23%23@10.3.10.59:5432/advance_request";

const DEPARTMENT = "Digital Transformation";
const DEFAULT_PASS = "Pass@2025!";

// ─── User definitions ──────────────────────────────────────────────────────
const USERS = [
  {
    employeeNo: "ETL-DT001",
    fullName:   "Lerato Molapo",
    title:      "Digital Transformation Officer",
    email:      "lerato.molapo@etl.co.ls",
    role:       "EMPLOYEE",
    dtPosition: "Requester (Employee)",
  },
  {
    employeeNo: "ETL-DT002",
    fullName:   "Thabang Sehloho",
    title:      "IT Systems Analyst",
    email:      "thabang.sehloho@etl.co.ls",
    role:       "EMPLOYEE",
    dtPosition: "Requester (Employee)",
  },
  {
    employeeNo: "ETL-DT003",
    fullName:   "Limakatso Sekake",
    title:      "Manager: Digital Transformation",
    email:      "limakatso.sekake@etl.co.ls",
    role:       "MANAGER",
    dtPosition: "Manager / Supervisor  ← set as department manager",
  },
  {
    employeeNo: "ETL-DT004",
    fullName:   "Thabo Nthako",
    title:      "Head: Digital Transformation",
    email:      "thabo.nthako@etl.co.ls",
    role:       "HOD",
    dtPosition: "Head of Department  ← set as department HOD",
  },
  {
    employeeNo: "ETL-DT005",
    fullName:   "Mpho Sefako",
    title:      "HR Manager",
    email:      "mpho.sefako@etl.co.ls",
    role:       "HR_MANAGER",
    dtPosition: "HR Manager  (step 4 of advance flow)",
  },
  {
    employeeNo: "ETL-DT006",
    fullName:   "Palesa Letsie",
    title:      "HR Officer",
    email:      "palesa.letsie@etl.co.ls",
    role:       "AUTH_OFFICER",
    dtPosition: "HR  (step 5 of advance flow / step 4 of clearance flow)",
  },
  {
    employeeNo: "ETL-DT007",
    fullName:   "Retselisitsoe Nkhasi",
    title:      "Finance Officer",
    email:      "retselisitsoe.nkhasi@etl.co.ls",
    role:       "FINANCE",
    dtPosition: "Finance  (final step)",
  },
  {
    employeeNo: "ETL-DT008",
    fullName:   "Nthabiseng Ramoholi",
    title:      "Executive Committee Member",
    email:      "nthabiseng.ramoholi@etl.co.ls",
    role:       "EXCO",
    dtPosition: "EXCO  ← set as department EXCO / step 3 of clearance flow",
  },
];

// ─── Helper ────────────────────────────────────────────────────────────────
async function upsertUser(client, hash, u) {
  const existing = await client.query(
    "SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1",
    [u.email]
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await client.query(
      `UPDATE users
          SET full_name=$2, title=$3, department=$4, role=$5,
              employee_no=COALESCE(NULLIF(employee_no,''), $6),
              is_active=true, profile_completed=true, updated_at=now()
        WHERE id=$1`,
      [id, u.fullName, u.title, DEPARTMENT, u.role, u.employeeNo]
    );
    console.log(`  UPDATE  ${u.employeeNo}  ${u.fullName} <${u.email}> [${u.role}]`);
    return id;
  }

  const rows = await client.query(
    `INSERT INTO users
       (id, employee_no, full_name, title, department, email, role,
        password_hash, is_active, employment_type, profile_completed,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'PERMANENT',true,now(),now())
     RETURNING id`,
    [randomUUID(), u.employeeNo, u.fullName, u.title, DEPARTMENT, u.email, u.role, hash]
  );
  console.log(`  CREATE  ${u.employeeNo}  ${u.fullName} <${u.email}> [${u.role}]`);
  return rows.rows[0].id;
}

async function ensureDepartment(client, managerId, hodId, excoId) {
  const existing = await client.query(
    "SELECT id FROM departments WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1",
    [DEPARTMENT]
  );
  if (existing.rows.length > 0) {
    const deptId = existing.rows[0].id;
    await client.query(
      `UPDATE departments
          SET manager_user_id=$2, hod_user_id=$3, exco_user_id=$4, active=true
        WHERE id=$1`,
      [deptId, managerId, hodId, excoId]
    );
    console.log(`\n  DEPT  updated "${DEPARTMENT}" (manager/HOD/EXCO assigned)`);
    return deptId;
  }
  const rows = await client.query(
    `INSERT INTO departments (id, name, manager_user_id, hod_user_id, exco_user_id, active, created_at)
     VALUES ($1,$2,$3,$4,$5,true,now())
     RETURNING id`,
    [randomUUID(), DEPARTMENT, managerId, hodId, excoId]
  );
  console.log(`\n  DEPT  created "${DEPARTMENT}" (manager/HOD/EXCO assigned)`);
  return rows.rows[0].id;
}

async function getPositionTypeId(client, code) {
  const r = await client.query(
    "SELECT id FROM position_types WHERE code=$1 LIMIT 1",
    [code]
  );
  return r.rows[0]?.id ?? null;
}

async function ensurePositionType(client, code, name, description) {
  const existing = await client.query(
    "SELECT id FROM position_types WHERE code=$1 LIMIT 1",
    [code]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const r = await client.query(
    `INSERT INTO position_types (id, name, code, description, applies_to, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,
       ARRAY['ADVANCE_REQUEST','TRAVEL_REQUEST','ACCOMMODATION_REQUEST','OVERTIME_REQUEST',
             'PROCUREMENT_REQUEST','CLEARANCE_REQUEST','PETTY_CASH_REQUEST','CLAIM_REQUEST']::workflow_request_type[],
       true, now(), now())
     RETURNING id`,
    [randomUUID(), name, code, description]
  );
  console.log(`  POSTYPE  added "${code}"`);
  return r.rows[0].id;
}

async function recreateWorkflow(client, { name, requestType, description, department, adminUserId, steps }) {
  // Deactivate any existing active workflows for same type+department
  await client.query(
    `UPDATE workflows SET status='INACTIVE', updated_at=now()
      WHERE lower(trim(department)) = lower(trim($1))
        AND request_type = $2::workflow_request_type
        AND status = 'ACTIVE'`,
    [department, requestType]
  );

  const wfId = randomUUID();
  await client.query(
    `INSERT INTO workflows (id, name, request_type, department, status, description, created_by_id, created_at, updated_at)
     VALUES ($1,$2,$3::workflow_request_type,$4,'ACTIVE',$5,$6,now(),now())`,
    [wfId, name, requestType, department, description, adminUserId]
  );

  for (const step of steps) {
    await client.query(
      `INSERT INTO workflow_steps
         (id, workflow_id, step_order, position_type_id, position_name, description,
          is_required, skip_if_unassigned, allow_delegation, comments_required,
          escalation_days, is_final_approval, is_system_step, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,now(),now())`,
      [
        randomUUID(), wfId, step.order, step.positionTypeId, step.name, step.description,
        step.required ?? true,
        step.skipIfUnassigned ?? false,
        step.allowDelegation ?? false,
        step.commentsRequired ?? false,
        step.escalationDays ?? 2,
        step.isFinal ?? false,
        step.isSystem ?? false,
      ]
    );
  }

  console.log(`  WORKFLOW  "${name}" created (${steps.length} steps, ACTIVE, dept: ${department})`);
  return wfId;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Connected to database.\n");

  const hash = await bcrypt.hash(DEFAULT_PASS, 10);

  // 1. Create / update users
  console.log("── Users ─────────────────────────────────────────────");
  const userMap = {};
  for (const u of USERS) {
    userMap[u.role] = await upsertUser(client, hash, u);
    // store by employee no too for lookup
    userMap[u.employeeNo] = userMap[u.role];
  }

  const managerId = userMap["ETL-DT003"];
  const hodId     = userMap["ETL-DT004"];
  const excoId    = userMap["ETL-DT008"];

  // 2. Ensure department row with leadership
  console.log("\n── Department ────────────────────────────────────────");
  await ensureDepartment(client, managerId, hodId, excoId);

  // 3. Resolve / add position types
  console.log("\n── Position Types ────────────────────────────────────");
  const ptEmployee    = await getPositionTypeId(client, "EMPLOYEE");
  const ptManager     = await getPositionTypeId(client, "MANAGER");
  const ptHod         = await getPositionTypeId(client, "HOD");
  const ptExco        = await getPositionTypeId(client, "EXCO_OWNER");
  const ptHrReview    = await getPositionTypeId(client, "HR_REVIEW");
  const ptFinance     = await getPositionTypeId(client, "FINANCE");
  // Ensure HR_MANAGER_REVIEW exists (used as the HR Manager approval step)
  const ptHrManager   = await ensurePositionType(
    client,
    "HR_MANAGER_REVIEW",
    "HR Manager",
    "HR Manager review and approval"
  );
  console.log("  Position types resolved.");

  // Find any admin user to set as created_by (fall back to hodId)
  const adminRow = await client.query(
    "SELECT id FROM users WHERE role='ADMIN' LIMIT 1"
  );
  const adminUserId = adminRow.rows[0]?.id ?? hodId;

  // 4. Workflows
  console.log("\n── Workflows ─────────────────────────────────────────");

  // 4a. Advance Request (DT) — 6 steps
  await recreateWorkflow(client, {
    name:        "Advance Request Workflow – Digital Transformation",
    requestType: "ADVANCE_REQUEST",
    description: "Standard advance request approval chain for the Digital Transformation department.",
    department:  DEPARTMENT,
    adminUserId,
    steps: [
      { order: 1, positionTypeId: ptEmployee,  name: "Employee",             description: "Request Initiator",                 isSystem: true,  required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 0, isFinal: false },
      { order: 2, positionTypeId: ptManager,   name: "Manager / Supervisor", description: "Department Manager review",          isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: true,  escalationDays: 2, isFinal: false },
      { order: 3, positionTypeId: ptHod,       name: "Head of Department",   description: "HOD approval",                      isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: true,  escalationDays: 2, isFinal: false },
      { order: 4, positionTypeId: ptHrManager, name: "HR Manager",           description: "HR Manager endorsement",            isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 3, isFinal: false },
      { order: 5, positionTypeId: ptHrReview,  name: "HR",                   description: "HR Officer final HR clearance",     isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 2, isFinal: false },
      { order: 6, positionTypeId: ptFinance,   name: "Finance",              description: "Finance authorisation and payment", isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 3, isFinal: true  },
    ],
  });

  // 4b. Clearance (DT) — 5 steps
  await recreateWorkflow(client, {
    name:        "Clearance Workflow – Digital Transformation",
    requestType: "CLEARANCE_REQUEST",
    description: "Clearance approval chain for the Digital Transformation department.",
    department:  DEPARTMENT,
    adminUserId,
    steps: [
      { order: 1, positionTypeId: ptEmployee, name: "Employee",           description: "Clearance Initiator",               isSystem: true,  required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 0, isFinal: false },
      { order: 2, positionTypeId: ptHod,      name: "Head of Department", description: "HOD clearance approval",            isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: true,  escalationDays: 2, isFinal: false },
      { order: 3, positionTypeId: ptExco,     name: "EXCO",               description: "Executive Committee approval",      isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 3, isFinal: false },
      { order: 4, positionTypeId: ptHrReview, name: "HR",                 description: "HR Officer clearance sign-off",     isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 2, isFinal: false },
      { order: 5, positionTypeId: ptFinance,  name: "Finance",            description: "Finance final clearance sign-off",  isSystem: false, required: true,  skipIfUnassigned: false, allowDelegation: false, escalationDays: 3, isFinal: true  },
    ],
  });

  await client.end();

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║       Digital Transformation – Scenario User Accounts                       ║
╠═══════════════════╦══════════════════╦════════════════════╦═════════════════╣
║ Name              ║ Employee No      ║ Email              ║ Password        ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Lerato Molapo     ║ ETL-DT001        ║ lerato.molapo      ║ Pass@2025!      ║
║   (Employee)      ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Thabang Sehloho   ║ ETL-DT002        ║ thabang.sehloho    ║ Pass@2025!      ║
║   (Employee)      ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Limakatso Sekake  ║ ETL-DT003        ║ limakatso.sekake   ║ Pass@2025!      ║
║   (Manager)       ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Thabo Nthako      ║ ETL-DT004        ║ thabo.nthako       ║ Pass@2025!      ║
║   (HOD)           ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Mpho Sefako       ║ ETL-DT005        ║ mpho.sefako        ║ Pass@2025!      ║
║   (HR Manager)    ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Palesa Letsie     ║ ETL-DT006        ║ palesa.letsie      ║ Pass@2025!      ║
║   (HR)            ║                  ║   @etl.co.ls       ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Retselisitsoe     ║ ETL-DT007        ║ retselisitsoe      ║ Pass@2025!      ║
║ Nkhasi (Finance)  ║                  ║ .nkhasi@etl.co.ls  ║                 ║
╠═══════════════════╬══════════════════╬════════════════════╬═════════════════╣
║ Nthabiseng        ║ ETL-DT008        ║ nthabiseng         ║ Pass@2025!      ║
║ Ramoholi (EXCO)   ║                  ║ .ramoholi@etl.co.ls║                 ║
╚═══════════════════╩══════════════════╩════════════════════╩═════════════════╝

  Approval flows created:

  ADVANCE REQUEST
    Employee → Manager/Supervisor → HOD → HR Manager → HR → Finance

  CLEARANCE
    Employee → HOD → EXCO → HR → Finance
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
