/**
 * Seed script: "Digital Workflow" scenario for the travel advance & clearance chain
 *
 * Unlike seed-dt-scenario.mjs (which wires up fixed, named individuals), this
 * script randomly fills each position in the approval chain — reusing an
 * existing eligible user when one is found, or minting a fresh one (drawn
 * from a pool of candidate names) when it isn't. Re-running it reshuffles
 * the assignment, so each run can produce a different cast for the same
 * scenario.
 *
 * Creates / wires up:
 *   - One user per workflow position (2 requesters, manager, HOD,
 *     HR officer, finance, EXCO)
 *   - The "Digital Workflow" department row with manager/HOD/EXCO leadership
 *   - The Advance Request workflow (6 steps):
 *       Employee → Manager/Supervisor → HOD → HR Officer → Finance
 *   - The Clearance workflow (5 steps):
 *       Employee → HOD → EXCO Member → HR → Finance
 *
 * Run:  node scripts/seed-digital-workflow-scenario.mjs
 * Optionally override the department name:  DEPARTMENT_NAME="My Dept" node scripts/seed-digital-workflow-scenario.mjs
 */

import bcrypt from "bcrypt";
import pg from "pg";
import { randomUUID } from "crypto";

const { Client } = pg;

const DB_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:Admin%40ETL111%23%23@10.3.10.59:5432/advance_request";

const DEPARTMENT = process.env.DEPARTMENT_NAME || "Digital Workflow";
const DEFAULT_PASS = "Pass@2025!";
const EMP_PREFIX = "ETL-DW";

// ─── Candidate names drawn on when a fresh user must be minted ─────────────
const NAME_POOL = [
  { firstName: "Teboho", surname: "Mokoena", title: "Systems Analyst" },
  { firstName: "Lerato", surname: "Ntlatlapa", title: "Network Engineer" },
  { firstName: "Palesa", surname: "Lekhotsa", title: "Workflow Coordinator" },
  { firstName: "Mosihle", surname: "Mokhesi", title: "Software Developer" },
  { firstName: "Refiloe", surname: "Lehohla", title: "Business Analyst" },
  { firstName: "Thabo", surname: "Nthako", title: "Operations Officer" },
  { firstName: "Nthabiseng", surname: "Ramahlola", title: "Programme Officer" },
  { firstName: "Mpho", surname: "Mokhele", title: "Process Owner" },
  { firstName: "Mamello", surname: "Motlomelo", title: "Compliance Officer" },
  { firstName: "Limpho", surname: "Selebalo", title: "Project Coordinator" },
  { firstName: "Tsepiso", surname: "Ntsoaki", title: "Change Analyst" },
  { firstName: "Nthabi", surname: "Mabusetsa", title: "Service Delivery Lead" },
  { firstName: "Moleboheng", surname: "Malerato", title: "Administrative Officer" },
  { firstName: "Motlatsi", surname: "Tšeole", title: "Operations Manager" },
  { firstName: "Lineo", surname: "Mamosa", title: "Workflow Analyst" },
  { firstName: "Thabang", surname: "Mokoteli", title: "Systems Coordinator" },
  { firstName: "Puseletso", surname: "Molise", title: "Quality Officer" },
  { firstName: "Mamokete", surname: "Ramotseki", title: "Reporting Officer" },
  { firstName: "Ntsoaki", surname: "Sefako", title: "Support Specialist" },
  { firstName: "Selebalo", surname: "Phafoli", title: "Process Analyst" },
];

// ─── Positions that must be filled for the two workflows ───────────────────
// "leads" marks the leadership slots that the department row needs (manager/hod/exco)
const POSITIONS = [
  { key: "employee1", role: "EMPLOYEE", label: "Requester (Employee) #1", leads: null },
  { key: "employee2", role: "EMPLOYEE", label: "Requester (Employee) #2", leads: null },
  { key: "manager", role: "MANAGER", label: "Manager / Supervisor", leads: "manager_user_id" },
  { key: "hod", role: "HOD", label: "Head of Department", leads: "hod_user_id" },
  { key: "hrOfficer", role: "EMPLOYEE", label: "HR Officer", leads: null },
  { key: "finance", role: "FINANCE", label: "Finance", leads: null },
  { key: "exco", role: "EXCO", label: "EXCO Member", leads: "exco_user_id" },
];

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function emailFor(firstName, surname) {
  const local = `${firstName}.${surname}`.toLowerCase().replace(/[^a-z.]/g, "");
  return `${local}@etl.co.ls`;
}

// Reuse an existing active user with this role who isn't already cast in this run,
// or mint a fresh one from the name pool — moving them into the scenario department.
async function castPosition(client, hash, role, alreadyUsedIds, namePool, nextSeq) {
  const reuse = await client.query(
    `SELECT id, employee_no, full_name, email
       FROM users
      WHERE role = $1
        AND is_active = true
        AND NOT (id = ANY($2::uuid[]))
      ORDER BY random()
      LIMIT 1`,
    [role, alreadyUsedIds]
  );

  if (reuse.rows.length > 0) {
    const u = reuse.rows[0];
    await client.query(
      `UPDATE users
          SET department=$2, profile_completed=true, is_active=true, updated_at=now()
        WHERE id=$1`,
      [u.id, DEPARTMENT]
    );
    console.log(`  ASSIGN  ${u.employee_no || "(no #)"}  ${u.full_name} <${u.email}> [${role}] — reused existing user`);
    return { id: u.id, fullName: u.full_name, email: u.email, reused: true };
  }

  const pick = namePool.pop();
  const fullName = `${pick.firstName} ${pick.surname}`;
  const email = emailFor(pick.firstName, pick.surname);
  const employeeNo = `${EMP_PREFIX}${String(nextSeq).padStart(3, "0")}`;

  const inserted = await client.query(
    `INSERT INTO users
       (id, employee_no, full_name, title, department, email, role,
        password_hash, is_active, employment_type, profile_completed,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'PERMANENT',true,now(),now())
     ON CONFLICT (email) DO UPDATE
       SET full_name=EXCLUDED.full_name, department=EXCLUDED.department,
           role=EXCLUDED.role, is_active=true, profile_completed=true, updated_at=now()
     RETURNING id, full_name, email`,
    [randomUUID(), employeeNo, fullName, pick.title, DEPARTMENT, email, role, hash]
  );
  const u = inserted.rows[0];
  console.log(`  CREATE  ${employeeNo}  ${u.full_name} <${u.email}> [${role}] — minted new user`);
  return { id: u.id, fullName: u.full_name, email: u.email, reused: false };
}

async function ensureDepartment(client, leadership) {
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
      [deptId, leadership.manager_user_id, leadership.hod_user_id, leadership.exco_user_id]
    );
    console.log(`\n  DEPT  updated "${DEPARTMENT}" (manager/HOD/EXCO assigned)`);
    return deptId;
  }
  const rows = await client.query(
    `INSERT INTO departments (id, name, manager_user_id, hod_user_id, exco_user_id, active, created_at)
     VALUES ($1,$2,$3,$4,$5,true,now())
     RETURNING id`,
    [randomUUID(), DEPARTMENT, leadership.manager_user_id, leadership.hod_user_id, leadership.exco_user_id]
  );
  console.log(`\n  DEPT  created "${DEPARTMENT}" (manager/HOD/EXCO assigned)`);
  return rows.rows[0].id;
}

async function ensurePositionType(client, code, name, description) {
  const existing = await client.query("SELECT id FROM position_types WHERE code=$1 LIMIT 1", [code]);
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

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log(`Connected to database. Casting "${DEPARTMENT}" scenario at random...\n`);

  const hash = await bcrypt.hash(DEFAULT_PASS, 10);
  const namePool = shuffle(NAME_POOL);

  // 1. Cast each position — reusing eligible users where possible, minting the rest
  console.log("── Casting positions ─────────────────────────────────");
  const cast = {};
  const usedIds = [];
  let seq = 1;
  for (const position of shuffle(POSITIONS)) {
    const actor = await castPosition(client, hash, position.role, usedIds, namePool, seq++);
    cast[position.key] = { ...actor, ...position };
    usedIds.push(actor.id);
  }

  // 2. Department leadership — derived from whichever random users landed the lead roles
  console.log("\n── Department ────────────────────────────────────────");
  const leadership = { manager_user_id: null, hod_user_id: null, exco_user_id: null };
  for (const position of POSITIONS) {
    if (position.leads) leadership[position.leads] = cast[position.key].id;
  }
  await ensureDepartment(client, leadership);

  // 3. Position types referenced by the workflow steps
  console.log("\n── Position Types ────────────────────────────────────");
  const ptEmployee = await ensurePositionType(client, "EMPLOYEE", "Employee", "Request initiator");
  const ptManager = await ensurePositionType(client, "MANAGER", "Manager", "Department manager review");
  const ptHod = await ensurePositionType(client, "HOD", "Head of Department", "HOD approval");
  const ptExco = await ensurePositionType(client, "EXCO_OWNER", "EXCO Member", "Executive committee approval");
  const ptHrReview = await ensurePositionType(client, "HR_REVIEW", "HR", "HR officer review");
  const ptFinance = await ensurePositionType(client, "FINANCE", "Finance", "Finance authorisation and payment");
  console.log("  Position types resolved.");

  const adminRow = await client.query("SELECT id FROM users WHERE role='ADMIN' LIMIT 1");
  const adminUserId = adminRow.rows[0]?.id ?? cast.hod.id;

  // 4. Workflows
  console.log("\n── Workflows ─────────────────────────────────────────");

  await recreateWorkflow(client, {
    name: `Advance Request Workflow – ${DEPARTMENT}`,
    requestType: "ADVANCE_REQUEST",
    description: `Standard advance request approval chain for the ${DEPARTMENT} department.`,
    department: DEPARTMENT,
    adminUserId,
    steps: [
      { order: 1, positionTypeId: ptEmployee, name: "Employee", description: "Request initiator", isSystem: true, escalationDays: 0 },
      { order: 2, positionTypeId: ptManager, name: "Manager / Supervisor", description: "Department manager review", allowDelegation: true, escalationDays: 2 },
      { order: 3, positionTypeId: ptHod, name: "Head of Department", description: "HOD approval", allowDelegation: true, escalationDays: 2 },
      { order: 4, positionTypeId: ptHrReview, name: "HR Officer", description: "HR clearance", escalationDays: 2 },
      { order: 5, positionTypeId: ptFinance, name: "Finance", description: "Finance authorisation and payment", escalationDays: 3, isFinal: true },
    ],
  });

  await recreateWorkflow(client, {
    name: `Clearance Workflow – ${DEPARTMENT}`,
    requestType: "CLEARANCE_REQUEST",
    description: `Clearance approval chain for the ${DEPARTMENT} department.`,
    department: DEPARTMENT,
    adminUserId,
    steps: [
      { order: 1, positionTypeId: ptEmployee, name: "Employee", description: "Clearance initiator", isSystem: true, escalationDays: 0 },
      { order: 2, positionTypeId: ptHod, name: "Head of Department", description: "HOD clearance approval", allowDelegation: true, escalationDays: 2 },
      { order: 3, positionTypeId: ptExco, name: "EXCO", description: "Executive committee approval", escalationDays: 3 },
      { order: 4, positionTypeId: ptHrReview, name: "HR", description: "HR Officer clearance sign-off", escalationDays: 2 },
      { order: 5, positionTypeId: ptFinance, name: "Finance", description: "Finance final clearance sign-off", escalationDays: 3, isFinal: true },
    ],
  });

  await client.end();

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  "${DEPARTMENT}" scenario cast (random)`.padEnd(80) + "║");
  console.log(`╠═══════════════════╦════════════════════════════╦══════════════════╦══════════╣`);
  console.log(`║ Position          ║ Name                       ║ Email            ║ Password ║`);
  console.log(`╠═══════════════════╬════════════════════════════╬══════════════════╬══════════╣`);
  for (const position of POSITIONS) {
    const actor = cast[position.key];
    console.log(
      `║ ${position.label.padEnd(17)} ║ ${actor.fullName.padEnd(26)} ║ ${actor.email.slice(0, 16).padEnd(16)} ║ ${DEFAULT_PASS.padEnd(8)} ║`
    );
  }
  console.log(`╚═══════════════════╩════════════════════════════╩══════════════════╩══════════╝`);
  console.log(`
  Approval flows wired up:

  ADVANCE REQUEST
    ${cast.employee1.fullName} / ${cast.employee2.fullName} → ${cast.manager.fullName} → ${cast.hod.fullName} → ${cast.hrOfficer.fullName} → ${cast.finance.fullName}

  CLEARANCE
    Employee → ${cast.hod.fullName} → ${cast.exco.fullName} → ${cast.hrOfficer.fullName} → ${cast.finance.fullName}

  All accounts use password: ${DEFAULT_PASS}
  Re-run this script to reshuffle the cast (existing eligible users may be reassigned, gaps are filled with freshly minted ones).
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
