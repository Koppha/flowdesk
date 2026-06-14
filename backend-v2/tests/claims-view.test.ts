import { describe, expect, it } from "vitest";
import { canViewClaim } from "../src/modules/claims/claims.routes.js";

describe("claim view access", () => {
  it("allows the claimant to view their own claim", () => {
    expect(
      canViewClaim({
        role: "EMPLOYEE",
        claimantId: "claimant-1",
        userId: "claimant-1"
      })
    ).toBe(true);
  });

  it("allows ADMIN to view any claim", () => {
    expect(
      canViewClaim({
        role: "ADMIN",
        claimantId: "claimant-1",
        userId: "admin-1"
      })
    ).toBe(true);
  });

  it("allows an approver in the resolved workflow chain to view the claim", () => {
    expect(
      canViewClaim({
        role: "EXCO",
        claimantId: "claimant-1",
        userId: "exco-1",
        approvalChain: [
          { approver_id: "exco-1" } as any
        ]
      })
    ).toBe(true);
  });

  it("allows anyone in the claimant's management chain (org structure) to view the claim", () => {
    expect(
      canViewClaim({
        role: "MANAGER",
        claimantId: "claimant-1",
        userId: "manager-1",
        managerChainIds: ["manager-1", "hod-1"]
      })
    ).toBe(true);
  });

  it("denies a user with no relation to the claim", () => {
    expect(
      canViewClaim({
        role: "FINANCE",
        claimantId: "claimant-1",
        userId: "stranger-1",
        approvalChain: [{ approver_id: "exco-1" } as any],
        managerChainIds: ["manager-1", "hod-1"]
      })
    ).toBe(false);
  });
});
