import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { query } from "../src/lib/db.js";
import { signToken } from "../src/lib/auth.js";

const chiefId = "00000000-0000-0000-0000-000000000011";
const proxyId = "00000000-0000-0000-0000-000000000012";
const otherDeptId = "00000000-0000-0000-0000-000000000013";
let dbAvailable = false;
const app = createApp();

const chiefToken = signToken({ userId: chiefId, role: "EXCO" });

describe("auth proxy role assignment", () => {
  beforeAll(async () => {
    try {
      await query("SELECT 1");
      dbAvailable = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("Skipping auth proxy tests because test database is unavailable:", reason);
      return;
    }

    await query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [chiefId, proxyId, otherDeptId]);
    await query(
      `INSERT INTO users (id, employee_no, full_name, email, password_hash, role, department)
       VALUES ($1, 'CHIEF001', 'EXCO User', 'chief@example.com', 'x', 'EXCO', 'Operations'),
              ($2, 'EMP001', 'Proxy Candidate', 'proxy@example.com', 'x', 'EMPLOYEE', 'Operations'),
              ($3, 'EMP002', 'Other Department User', 'other@example.com', 'x', 'EMPLOYEE', 'Finance')`,
      [chiefId, proxyId, otherDeptId]
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [chiefId, proxyId, otherDeptId]);
  });

  it("allows a chief officer to view department users and assign proxy roles", async () => {
    if (!dbAvailable) return;

    const listResp = await request(app)
      .get("/auth/users")
      .set("Authorization", `Bearer ${chiefToken}`)
      .send();

    expect(listResp.status).toBe(200);
    expect(Array.isArray(listResp.body)).toBe(true);
    expect(listResp.body.some((user: any) => user.id === proxyId)).toBe(true);

    const assignResp = await request(app)
      .post(`/auth/users/${proxyId}/role`)
      .set("Authorization", `Bearer ${chiefToken}`)
      .send({ role: "EXCO" });

    expect(assignResp.status).toBe(200);
    expect(assignResp.body.role).toBe("EXCO");
  });
});
