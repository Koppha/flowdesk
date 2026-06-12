import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { query } from "../src/lib/db.js";
import { signToken } from "../src/lib/auth.js";

const DEPARTMENT = "Travel Clearance E2E";
const TRAVEL_CODE = "TRAVEL_E2E";

const requesterId = "00000000-0000-0000-0000-0000000000a1";
const managerId = "00000000-0000-0000-0000-0000000000a2";
const chiefOfficerId = "00000000-0000-0000-0000-0000000000a3";
const authOfficerId = "00000000-0000-0000-0000-0000000000a4";
const hrManagerId = "00000000-0000-0000-0000-0000000000a5";
const financeId = "00000000-0000-0000-0000-0000000000a6";
const userIds = [requesterId, managerId, chiefOfficerId, authOfficerId, hrManagerId, financeId];

const departmentId = randomUUID();
const travelTypeId = randomUUID();
let advanceId = "";
let claimId = "";

const requesterToken = signToken({ userId: requesterId, role: "EMPLOYEE", department: DEPARTMENT });
const managerToken = signToken({ userId: managerId, role: "MANAGER", department: DEPARTMENT });
const chiefOfficerToken = signToken({ userId: chiefOfficerId, role: "EXCO", department: DEPARTMENT });
const authOfficerToken = signToken({ userId: authOfficerId, role: "MANAGER" });
const hrManagerToken = signToken({ userId: hrManagerId, role: "HR_MANAGER" });
const financeToken = signToken({ userId: financeId, role: "FINANCE" });

const app = createApp();
let dbAvailable = false;

describe("travel advance and clearance end-to-end workflow", () => {
  beforeAll(async () => {
    try {
      await query("SELECT 1");
      dbAvailable = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("Skipping travel advance/clearance e2e test because test database is unavailable:", reason);
      return;
    }

    await query(`DELETE FROM claim_trips WHERE clearance_claim_id IN (SELECT id FROM clearance_claims WHERE claimant_id=$1)`, [requesterId]);
    await query(`DELETE FROM clearance_claims WHERE claimant_id=$1`, [requesterId]);
    await query(`DELETE FROM advance_lines WHERE advance_request_id IN (SELECT id FROM advance_requests WHERE requester_id=$1)`, [requesterId]);
    await query(`DELETE FROM advance_requests WHERE requester_id=$1`, [requesterId]);
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    await query(`DELETE FROM travel_types WHERE code=$1`, [TRAVEL_CODE]);
    await query(`DELETE FROM departments WHERE name=$1`, [DEPARTMENT]);

    await query(
      `INSERT INTO users (id, employee_no, full_name, email, password_hash, role, department, employment_type, profile_completed, is_active)
       VALUES
        ($1, 'TAC001', 'Requester User', 'tac-requester@example.com', 'x', 'EMPLOYEE', $7, 'PERMANENT', true, true),
        ($2, 'TAC002', 'Manager User', 'tac-manager@example.com', 'x', 'MANAGER', $7, 'PERMANENT', true, true),
        ($3, 'TAC003', 'EXCO User', 'tac-chief@example.com', 'x', 'EXCO', $7, 'PERMANENT', true, true),
        ($4, 'TAC004', 'Auth Officer User', 'tac-auth@example.com', 'x', 'MANAGER', $7, 'PERMANENT', true, true),
        ($5, 'TAC005', 'HR Manager User', 'tac-hrmanager@example.com', 'x', 'HR_MANAGER', $7, 'PERMANENT', true, true),
        ($6, 'TAC006', 'Finance User', 'tac-finance@example.com', 'x', 'FINANCE', $7, 'PERMANENT', true, true)`,
      [requesterId, managerId, chiefOfficerId, authOfficerId, hrManagerId, financeId, DEPARTMENT]
    );

    await query(
      `INSERT INTO departments (id, name, manager_user_id, exco_user_id, active)
       VALUES ($1, $2, $3, $4, true)`,
      [departmentId, DEPARTMENT, managerId, chiefOfficerId]
    );

    await query(
      `INSERT INTO travel_types (id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, active, created_by_id)
       VALUES ($1, $2, 'Travel E2E', 'DISTRICT', 'MEAL', 50, 50, 50, true, $3)`,
      [travelTypeId, TRAVEL_CODE, requesterId]
    );
  });

  afterAll(async () => {
    if (!dbAvailable) {
      return;
    }

    if (claimId) {
      await query(`DELETE FROM claim_trips WHERE clearance_claim_id=$1`, [claimId]);
      await query(`DELETE FROM clearance_claims WHERE id=$1`, [claimId]);
    }
    if (advanceId) {
      await query(`DELETE FROM advance_lines WHERE advance_request_id=$1`, [advanceId]);
      await query(`DELETE FROM advance_requests WHERE id=$1`, [advanceId]);
    }
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    await query(`DELETE FROM travel_types WHERE id=$1`, [travelTypeId]);
    await query(`DELETE FROM departments WHERE id=$1`, [departmentId]);
  });

  it("carries a travel advance from request through payment, then through clearance settlement", async () => {
    if (!dbAvailable) {
      return;
    }

    // 1. Requester drafts a travel advance
    const createResp = await request(app)
      .post("/advances")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({
        type: TRAVEL_CODE,
        purpose: "Site visit to district office",
        payment_method: "ECOCASH",
        ecocash_number: "0771234567",
        requested_total: 0
      });
    expect(createResp.status).toBe(201);
    advanceId = createResp.body.id;

    // 2. Requester captures the travel table; the meal rate from the travel type drives the requested total
    const linesResp = await request(app)
      .put(`/advances/${advanceId}/lines`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({
        lines: [
          { line_date: "2026-07-01", location: "Maseru", meals_count: 2 },
          { line_date: "2026-07-02", location: "Maseru", meals_count: 2 }
        ]
      });
    expect(linesResp.status).toBe(200);
    expect(linesResp.body.requested_total).toBe(200);

    // 3. Requester submits for approval
    const submitResp = await request(app)
      .post(`/advances/${advanceId}/submit`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({});
    expect(submitResp.status).toBe(200);
    expect(submitResp.body.status).toBe("SUBMITTED");

    // 4. Department manager approves; an EXCO member is assigned, so it escalates to Chief Officer review
    const managerApprove = await request(app)
      .post(`/advances/${advanceId}/approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ approved_total: 200 });
    expect(managerApprove.status).toBe(200);
    expect(managerApprove.body.status).toBe("CHIEF_OFFICER_REVIEW");

    // 5. Chief Officer (EXCO member) approves; advance moves into the HR officer payment queue
    const chiefApprove = await request(app)
      .post(`/advances/${advanceId}/approve`)
      .set("Authorization", `Bearer ${chiefOfficerToken}`)
      .send({ approved_total: 200 });
    expect(chiefApprove.status).toBe(200);
    expect(chiefApprove.body.status).toBe("HR_OFFICER");

    // 6. Finance disburses the advance
    const markPaid = await request(app)
      .post(`/advances/${advanceId}/mark-paid`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({});
    expect(markPaid.status).toBe(200);
    expect(markPaid.body.status).toBe("PAID");

    const historyResp = await request(app)
      .get(`/advances/${advanceId}/history`)
      .set("Authorization", `Bearer ${requesterToken}`);
    expect(historyResp.status).toBe(200);
    expect(historyResp.body.map((entry: { action: string }) => entry.action)).toEqual(
      expect.arrayContaining(["ADVANCE_CREATE", "ADVANCE_LINES_UPDATE", "ADVANCE_SUBMIT", "ADVANCE_APPROVE", "ADVANCE_MARK_PAID"])
    );

    // 7. Requester opens a clearance claim against the now-paid advance; trips and totals sync from the advance lines
    const claimCreate = await request(app)
      .post("/claims")
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({
        month: "2026-07",
        duty_station: "Maseru",
        linked_advance_id: advanceId
      });
    expect(claimCreate.status).toBe(201);
    claimId = claimCreate.body.id;

    const claimDetail = await request(app)
      .get(`/claims/${claimId}`)
      .set("Authorization", `Bearer ${requesterToken}`);
    expect(claimDetail.status).toBe(200);
    expect(Number(claimDetail.body.advance_amount)).toBe(200);
    expect(Number(claimDetail.body.claim_total)).toBe(200);
    expect(Number(claimDetail.body.balance_amount)).toBe(0);
    expect(claimDetail.body.trips.length).toBe(2);

    // 8. Requester submits the clearance for approval
    const claimSubmit = await request(app)
      .post(`/claims/${claimId}/submit`)
      .set("Authorization", `Bearer ${requesterToken}`)
      .send({});
    expect(claimSubmit.status).toBe(200);
    expect(claimSubmit.body.status).toBe("SUBMITTED");

    // 9. Clearance routes through manager, Chief Officer, HR (auth officer), HR manager, then finance verification and settlement
    const managerApproveClaim = await request(app)
      .post(`/claims/${claimId}/manager-approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(managerApproveClaim.status).toBe(200);
    expect(managerApproveClaim.body.status).toBe("MANAGER_APPROVED");

    const chiefApproveClaim = await request(app)
      .post(`/claims/${claimId}/chief-officer-approve`)
      .set("Authorization", `Bearer ${chiefOfficerToken}`)
      .send({});
    expect(chiefApproveClaim.status).toBe(200);
    expect(chiefApproveClaim.body.status).toBe("CHIEF_OFFICER_APPROVED");

    const authOfficerApproveClaim = await request(app)
      .post(`/claims/${claimId}/auth-officer-approve`)
      .set("Authorization", `Bearer ${authOfficerToken}`)
      .send({});
    expect(authOfficerApproveClaim.status).toBe(200);
    expect(authOfficerApproveClaim.body.status).toBe("HR_OFFICER");

    const hrManagerApproveClaim = await request(app)
      .post(`/claims/${claimId}/hr-manager-approve`)
      .set("Authorization", `Bearer ${hrManagerToken}`)
      .send({});
    expect(hrManagerApproveClaim.status).toBe(200);
    expect(hrManagerApproveClaim.body.status).toBe("HR_MANAGER_REVIEW");

    const financeVerify = await request(app)
      .post(`/claims/${claimId}/finance-verify`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({});
    expect(financeVerify.status).toBe(200);
    expect(financeVerify.body.status).toBe("FINANCE_VERIFIED");

    const settle = await request(app)
      .post(`/claims/${claimId}/settle`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({ settled_method: "ECOCASH", settled_reference: "SETTLE-REF-001" });
    expect(settle.status).toBe(200);
    expect(settle.body.status).toBe("SETTLED");

    const finalClaim = await request(app)
      .get(`/claims/${claimId}`)
      .set("Authorization", `Bearer ${requesterToken}`);
    expect(finalClaim.status).toBe(200);
    expect(finalClaim.body.status).toBe("SETTLED");
    expect(finalClaim.body.settled_reference).toBe("SETTLE-REF-001");
  });
});
