import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/lib/auth.js";

describe("auth lib", () => {
  it("signs and verifies JWT payload", () => {
    const token = signToken({ userId: "user-1", role: "EMPLOYEE" });
    const payload = verifyToken(token);

    expect(payload.userId).toBe("user-1");
    expect(payload.role).toBe("EMPLOYEE");
  });
});
