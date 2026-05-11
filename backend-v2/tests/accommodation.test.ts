import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { query } from "../src/lib/db.js";
import { signToken } from "../src/lib/auth.js";

const requesterId = "00000000-0000-0000-0000-000000000001";
const hrId = "00000000-0000-0000-0000-000000000002";
const financeId = "00000000-0000-0000-0000-000000000003";
const advanceId = "00000000-0000-0000-0000-000000000010";
let accommodationId = "";

const hrToken = signToken({ userId: hrId, role: "AUTH_OFFICER" });
const financeToken = signToken({ userId: financeId, role: "FINANCE" });

const app = createApp();
let dbAvailable = false;

describe("accommodation workflow", () => {
  beforeAll(async () => {
    try {
      await query("SELECT 1");
      dbAvailable = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("Skipping accommodation workflow test because test database is unavailable:", reason);
      return;
    }

    await query(`DELETE FROM accommodation_quotations WHERE accommodation_request_id IN (SELECT id FROM accommodation_requests WHERE advance_request_id=$1)`, [advanceId]);
    await query(`DELETE FROM accommodation_requests WHERE advance_request_id=$1`, [advanceId]);
    await query(`DELETE FROM advance_requests WHERE id=$1`, [advanceId]);
    await query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [requesterId, hrId, financeId]);

    await query(
      `INSERT INTO users (id, employee_no, full_name, email, password_hash, role)
       VALUES ($1, 'EMP001', 'Requester User', 'requester@example.com', 'x', 'EMPLOYEE'),
              ($2, 'EMP002', 'HR User', 'hr@example.com', 'x', 'AUTH_OFFICER'),
              ($3, 'EMP003', 'Finance User', 'finance@example.com', 'x', 'FINANCE')`,
      [requesterId, hrId, financeId]
    );

    await query(
      `INSERT INTO advance_requests
         (id, requester_id, created_by_id, type, purpose, requested_total, approved_total, status)
       VALUES ($1, $2, $3, 'TRAVEL_SUBSISTENCE', 'Travel advance for accommodation', 100, 100, 'APPROVED')`,
      [advanceId, requesterId, requesterId]
    );
  });

  afterAll(async () => {
    if (!dbAvailable) {
      return;
    }

    if (accommodationId) {
      await query(`DELETE FROM accommodation_quotations WHERE accommodation_request_id=$1`, [accommodationId]);
      await query(`DELETE FROM accommodation_requests WHERE id=$1`, [accommodationId]);
    }
    await query(`DELETE FROM advance_requests WHERE id=$1`, [advanceId]);
    await query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [requesterId, hrId, financeId]);
  });

  it("allows HR to create a draft accommodation request and upload multiple quotations before sending to finance", async () => {
    if (!dbAvailable) {
      return;
    }

    const createResp = await request(app)
      .post("/accommodation-requests")
      .set("Authorization", `Bearer ${hrToken}`)
      .send({
        advance_request_id: advanceId,
        location: "Test Hotel",
        provider: "Test Provider",
        check_in: "2026-05-10",
        check_out: "2026-05-12",
        amount: 300,
        notes: "Test booking"
      });

    expect(createResp.status).toBe(201);
    expect(createResp.body.status).toBe("DRAFT");
    accommodationId = createResp.body.id;

    const upload1 = await request(app)
      .post(`/accommodation-requests/${accommodationId}/upload-quotation`)
      .set("Authorization", `Bearer ${hrToken}`)
      .attach("file", Buffer.from("quotation 1"), "quote-1.pdf");
    expect(upload1.status).toBe(200);
    expect(upload1.body.ok).toBe(true);

    const upload2 = await request(app)
      .post(`/accommodation-requests/${accommodationId}/upload-quotation`)
      .set("Authorization", `Bearer ${hrToken}`)
      .attach("file", Buffer.from("quotation 2"), "quote-2.pdf");
    expect(upload2.status).toBe(200);
    expect(upload2.body.ok).toBe(true);

    const detailResp = await request(app)
      .get(`/accommodation-requests/${accommodationId}`)
      .set("Authorization", `Bearer ${hrToken}`);
    expect(detailResp.status).toBe(200);
    expect(Array.isArray(detailResp.body.quotations)).toBe(true);
    expect(detailResp.body.quotations.length).toBe(2);
    expect(detailResp.body.status).toBe("DRAFT");

    const sendResp = await request(app)
      .post(`/accommodation-requests/${accommodationId}/send-to-finance`)
      .set("Authorization", `Bearer ${hrToken}`)
      .send({});
    expect(sendResp.status).toBe(200);
    expect(sendResp.body.status).toBe("SUBMITTED");

    const secondSendResp = await request(app)
      .post(`/accommodation-requests/${accommodationId}/send-to-finance`)
      .set("Authorization", `Bearer ${hrToken}`)
      .send({});
    expect(secondSendResp.status).toBe(400);
    expect(secondSendResp.body.error).toContain("Only draft accommodation requests can be sent to finance");

    const uploadAfterSend = await request(app)
      .post(`/accommodation-requests/${accommodationId}/upload-quotation`)
      .set("Authorization", `Bearer ${hrToken}`)
      .attach("file", Buffer.from("quotation 3"), "quote-3.pdf");
    expect(uploadAfterSend.status).toBe(400);
    expect(uploadAfterSend.body.error).toContain("Quotations can only be uploaded while the accommodation request is in draft");
  });
});
