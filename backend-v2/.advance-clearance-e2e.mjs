import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const rawEnv = fs.readFileSync(".env", "utf8");
const parsedEnv = {};
for (const line of rawEnv.split(/\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx < 0) continue;
  parsedEnv[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
}

process.env.NODE_ENV = "test";
process.env.PORT = "4111";
process.env.DATABASE_URL = parsedEnv.DATABASE_URL;
process.env.JWT_SECRET = parsedEnv.JWT_SECRET || "v2-super-secret-token-123456";
process.env.CORS_ORIGIN = "http://localhost:5174";
process.env.AD_AUTH_ENABLED = "false";
process.env.AD_FALLBACK_LOCAL = "true";
process.env.EMAIL_API_ENABLED = "false";
process.env.TEAMS_ENABLED = "false";

const supertest = (await import("supertest")).default;
const { createApp } = await import("./dist/src/app.js");
const { bootstrapSystem } = await import("./dist/src/bootstrap/system.js");
const { query } = await import("./dist/src/lib/db.js");
const { hashPassword } = await import("./dist/src/lib/auth.js");

await bootstrapSystem();

const app = createApp();
const request = supertest(app);
const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`.toLowerCase();
const department = `E2E Advance Clearance ${runId}`;
const travelCode = `E2E_${runId.toUpperCase()}`.replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
const password = `E2E-${runId}-Pass123`;
const passwordHash = await hashPassword(password);

const ids = {
  employee: randomUUID(),
  manager: randomUUID(),
  exco: randomUUID(),
  hr: randomUUID(),
  finance: randomUUID(),
  department: randomUUID(),
  travelType: randomUUID()
};

const users = {
  employee: {
    id: ids.employee,
    email: `e2e-employee-${runId}@example.invalid`,
    fullName: `E2E Employee ${runId}`,
    employeeNo: `E2E-EMP-${runId}`,
    role: "EMPLOYEE",
    department
  },
  manager: {
    id: ids.manager,
    email: `e2e-manager-${runId}@example.invalid`,
    fullName: `E2E Manager ${runId}`,
    employeeNo: `E2E-MGR-${runId}`,
    role: "MANAGER",
    department
  },
  exco: {
    id: ids.exco,
    email: `e2e-exco-${runId}@example.invalid`,
    fullName: `E2E EXCO ${runId}`,
    employeeNo: `E2E-EXCO-${runId}`,
    role: "EXCO",
    department
  },
  hr: {
    id: ids.hr,
    email: `e2e-hr-${runId}@example.invalid`,
    fullName: `E2E HR Officer ${runId}`,
    employeeNo: `E2E-HR-${runId}`,
    role: "EMPLOYEE",
    department: "HR"
  },
  finance: {
    id: ids.finance,
    email: `e2e-finance-${runId}@example.invalid`,
    fullName: `E2E Finance ${runId}`,
    employeeNo: `E2E-FIN-${runId}`,
    role: "FINANCE",
    department: "Finance"
  }
};

for (const user of Object.values(users)) {
  await query(
    `INSERT INTO users
       (id, employee_no, full_name, title, department, email, role, password_hash, is_active, employment_type, profile_completed, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'PERMANENT',true,now(),now())`,
    [user.id, user.employeeNo, user.fullName, user.role.replace(/_/g, " "), user.department, user.email, user.role, passwordHash]
  );
}

await query(
  `INSERT INTO departments
     (id, name, manager_user_id, exco_user_id, active, is_business_partner, created_at)
   VALUES ($1,$2,$3,$4,true,false,now())
   ON CONFLICT (name) DO UPDATE
     SET manager_user_id=EXCLUDED.manager_user_id,
         exco_user_id=EXCLUDED.exco_user_id,
         active=true`,
  [ids.department, department, ids.manager, ids.chief]
);

await query(
  `INSERT INTO travel_types
     (id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation, created_by_id, created_at, updated_at)
   VALUES ($1,$2,$3,'DISTRICT','MEAL',150,150,150,'LSL',true,false,$4,now(),now())`,
  [ids.travelType, travelCode, `E2E Travel ${runId}`, ids.auth]
);

await query(
  `INSERT INTO travel_locations
     (id, travel_type_id, district, active, created_by_id, created_at, updated_at)
   VALUES ($1,$2,'Maseru',true,$3,now(),now())`,
  [randomUUID(), ids.travelType, ids.auth]
);

async function login(user) {
  const res = await request
    .post("/auth/login")
    .send({ email: user.email, password })
    .expect(200);
  assert.equal(res.body.user.id, user.id);
  assert.equal(res.body.user.role, user.role);
  assert.equal(res.body.user.profile_completed, true);
  return res.body.token;
}

const tokens = {
  employee: await login(users.employee),
  manager: await login(users.manager),
  chief: await login(users.chief),
  auth: await login(users.auth),
  hr: await login(users.hr),
  finance: await login(users.finance)
};

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

function expectInboxItem(body, docType, id, status) {
  assert.ok(Array.isArray(body.items), "inbox response should include items");
  assert.ok(
    body.items.some((item) => item.doc_type === docType && item.id === id && item.status === status),
    `expected inbox item ${docType} ${id} at ${status}`
  );
}

const advanceStatuses = [];
const claimStatuses = [];
const lineDate = "2026-06-06";

const createAdvance = await request
  .post("/advances")
  .set(authed(tokens.employee))
  .send({
    type: travelCode,
    purpose: `E2E travel advance ${runId}`,
    project_number: `E2E-${runId}`,
    payment_method: "ECOCASH",
    ecocash_number: "+26650123456",
    requested_total: 300
  })
  .expect(201);
const advanceId = createAdvance.body.id;
assert.ok(advanceId, "advance id should be returned");
advanceStatuses.push("DRAFT");

const lines = await request
  .put(`/advances/${advanceId}/lines`)
  .set(authed(tokens.employee))
  .send({
    lines: [
      {
        line_date: lineDate,
        location: "Maseru",
        travel_meta: { district: "Maseru" },
        meals_count: 2
      }
    ]
  })
  .expect(200);
assert.equal(lines.body.requested_total, 300);

const submitted = await request
  .post(`/advances/${advanceId}/submit`)
  .set(authed(tokens.employee))
  .send({})
  .expect(200);
assert.equal(submitted.body.status, "SUBMITTED");
advanceStatuses.push(submitted.body.status);

const managerInboxAdvance = await request.get("/inbox").set(authed(tokens.manager)).expect(200);
expectInboxItem(managerInboxAdvance.body, "ADVANCE", advanceId, "SUBMITTED");

const managerApproved = await request
  .post(`/advances/${advanceId}/approve`)
  .set(authed(tokens.manager))
  .send({ approved_total: 300 })
  .expect(200);
assert.equal(managerApproved.body.status, "COUNTERSIGNED");
advanceStatuses.push(managerApproved.body.status);

const chiefInboxAdvance = await request.get("/inbox").set(authed(tokens.chief)).expect(200);
expectInboxItem(chiefInboxAdvance.body, "ADVANCE", advanceId, "COUNTERSIGNED");

const chiefApproved = await request
  .post(`/advances/${advanceId}/approve`)
  .set(authed(tokens.chief))
  .send({ approved_total: 300 })
  .expect(200);
assert.equal(chiefApproved.body.status, "HR_OFFICER");
advanceStatuses.push(chiefApproved.body.status);

const financeInboxAdvance = await request.get("/inbox").set(authed(tokens.finance)).expect(200);
expectInboxItem(financeInboxAdvance.body, "ADVANCE", advanceId, "HR_OFFICER");

const paid = await request
  .post(`/advances/${advanceId}/mark-paid`)
  .set(authed(tokens.finance))
  .send({ paid_reference: `E2E-PAY-${runId}` })
  .expect(200);
assert.equal(paid.body.status, "PAID");
advanceStatuses.push(paid.body.status);

const advanceDetail = await request.get(`/advances/${advanceId}`).set(authed(tokens.employee)).expect(200);
assert.equal(advanceDetail.body.status, "PAID");
assert.equal(Number(advanceDetail.body.requested_total), 300);
assert.equal(Number(advanceDetail.body.approved_total), 300);
assert.equal(advanceDetail.body.lines.length, 1);

const advanceHistory = await request.get(`/advances/${advanceId}/history`).set(authed(tokens.employee)).expect(200);
assert.ok(advanceHistory.body.length >= 5, "advance audit history should include workflow actions");

const createClaim = await request
  .post("/claims")
  .set(authed(tokens.employee))
  .send({
    month: "2026-06",
    duty_station: "Maseru",
    project_number: `E2E-${runId}`,
    vehicle_reg: "E2E-001",
    vehicle_type: "Test Vehicle",
    engine_cc: "1600",
    linked_advance_id: advanceId
  })
  .expect(201);
const claimId = createClaim.body.id;
assert.ok(claimId, "claim id should be returned");
claimStatuses.push("DRAFT");

const draftClaim = await request.get(`/claims/${claimId}`).set(authed(tokens.employee)).expect(200);
assert.equal(Number(draftClaim.body.advance_amount), 300);
assert.equal(Number(draftClaim.body.claim_total), 300);
assert.equal(Number(draftClaim.body.balance_amount), 0);
assert.equal(draftClaim.body.trips.length, 1);

const claimSubmitted = await request
  .post(`/claims/${claimId}/submit`)
  .set(authed(tokens.employee))
  .send({})
  .expect(200);
assert.equal(claimSubmitted.body.status, "SUBMITTED");
claimStatuses.push(claimSubmitted.body.status);

const managerInboxClaim = await request.get("/inbox").set(authed(tokens.manager)).expect(200);
expectInboxItem(managerInboxClaim.body, "CLAIM", claimId, "SUBMITTED");

const claimManagerApproved = await request
  .post(`/claims/${claimId}/manager-approve`)
  .set(authed(tokens.manager))
  .send({})
  .expect(200);
assert.equal(claimManagerApproved.body.status, "MANAGER_APPROVED");
claimStatuses.push(claimManagerApproved.body.status);

const claimExcoApproved = await request
  .post(`/claims/${claimId}/approve`)
  .set(authed(tokens.exco))
  .send({})
  .expect(200);
assert.equal(claimExcoApproved.body.status, "EXCO_APPROVED");
claimStatuses.push(claimExcoApproved.body.status);

const claimHrApproved = await request
  .post(`/claims/${claimId}/approve`)
  .set(authed(tokens.hr))
  .send({})
  .expect(200);
assert.equal(claimHrApproved.body.status, "HR_OFFICER");
claimStatuses.push(claimHrApproved.body.status);

const claimFinanceVerified = await request
  .post(`/claims/${claimId}/finance-verify`)
  .set(authed(tokens.finance))
  .send({})
  .expect(200);
assert.equal(claimFinanceVerified.body.status, "FINANCE_VERIFIED");
claimStatuses.push(claimFinanceVerified.body.status);

const claimSettled = await request
  .post(`/claims/${claimId}/settle`)
  .set(authed(tokens.finance))
  .send({ settled_method: "ECOCASH", settled_reference: `E2E-SETTLE-${runId}` })
  .expect(200);
assert.equal(claimSettled.body.status, "SETTLED");
claimStatuses.push(claimSettled.body.status);

const settledClaim = await request.get(`/claims/${claimId}`).set(authed(tokens.employee)).expect(200);
assert.equal(settledClaim.body.status, "SETTLED");
assert.equal(settledClaim.body.settled_reference, `E2E-SETTLE-${runId}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      runId,
      department,
      travelCode,
      advanceId,
      advanceStatuses,
      advanceAuditEvents: advanceHistory.body.length,
      claimId,
      claimStatuses
    },
    null,
    2
  )
);
