import { describe, expect, it } from "vitest";
import { canViewClaim } from "../src/modules/claims/claims.routes.js";

describe("claim view access", () => {
  it("allows managers to view claims after they were submitted", () => {
    expect(
      canViewClaim({
        role: "MANAGER",
        claimantId: "claimant-1",
        userId: "manager-1",
        status: "MANAGER_APPROVED"
      })
    ).toBe(true);
  });

  it("allows EXCO to view claims after manager approval", () => {
    expect(
      canViewClaim({
        role: "EXCO",
        claimantId: "claimant-1",
        userId: "exco-1",
        status: "CHIEF_OFFICER_APPROVED"
      })
    ).toBe(true);
  });

  it("allows auth officers to view claims after chief officer approval", () => {
    expect(
      canViewClaim({
        role: "AUTH_OFFICER",
        claimantId: "claimant-1",
        userId: "hr-1",
        status: "HR_OFFICER"
      })
    ).toBe(true);
  });

  it("allows HR managers to view claims during HR manager review", () => {
    expect(
      canViewClaim({
        role: "HR_MANAGER",
        claimantId: "claimant-1",
        userId: "hr-manager-1",
        status: "HR_MANAGER_REVIEW"
      })
    ).toBe(true);
  });

  it("allows finance to view claims after HR officer review", () => {
    expect(
      canViewClaim({
        role: "FINANCE",
        claimantId: "claimant-1",
        userId: "finance-1",
        status: "FINANCE_VERIFIED"
      })
    ).toBe(true);
  });
});
