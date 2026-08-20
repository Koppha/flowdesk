import { describe, expect, it } from "vitest";
import { canViewClaim } from "../src/modules/claims/claims.routes.js";

describe("claim view access", () => {
  it("allows the claimant to view their own claim", async () => {
    expect(
      await canViewClaim({
        role: "EMPLOYEE",
        claimantId: "claimant-1",
        userId: "claimant-1"
      })
    ).toBe(true);
  });

  it("allows ADMIN to view any claim", async () => {
    expect(
      await canViewClaim({
        role: "ADMIN",
        claimantId: "claimant-1",
        userId: "admin-1"
      })
    ).toBe(true);
  });

  it("allows an approver in the resolved workflow chain to view the claim", async () => {
    expect(
      await canViewClaim({
        role: "EXCO",
        claimantId: "claimant-1",
        userId: "exco-1",
        approvalChain: [
          { approver_id: "exco-1" } as any
        ]
      })
    ).toBe(true);
  });

  it("does not allow someone in the claimant's management chain to view the claim before it reaches them in the workflow", async () => {
    expect(
      await canViewClaim({
        role: "MANAGER",
        claimantId: "claimant-1",
        userId: "manager-1",
        managerChainIds: ["manager-1", "hod-1"]
      })
    ).toBe(false);
  });

  it("denies a user with no relation to the claim", async () => {
    expect(
      await canViewClaim({
        role: "FINANCE",
        claimantId: "claimant-1",
        userId: "stranger-1",
        approvalChain: [{ approver_id: "exco-1" } as any],
        managerChainIds: ["manager-1", "hod-1"]
      })
    ).toBe(false);
  });
});
