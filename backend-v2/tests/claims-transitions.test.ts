import { describe, expect, it } from "vitest";
import { nextClaimStatus } from "../src/modules/claims/claims.routes.js";

describe("claim transitions", () => {
  it("routes clearances through manager, EXCO, HR, and finance", () => {
    const managerApproved = nextClaimStatus("SUBMITTED", "MANAGER_APPROVE");
    const excoApproved = nextClaimStatus(managerApproved, "EXCO_APPROVE");
    const hrApproved = nextClaimStatus(excoApproved, "HR_OFFICER_APPROVE");
    const financeVerified = nextClaimStatus(hrApproved, "FINANCE_VERIFY");
    const settled = nextClaimStatus(financeVerified, "SETTLE");

    expect(managerApproved).toBe("MANAGER_APPROVED");
    expect(excoApproved).toBe("EXCO_APPROVED");
    expect(hrApproved).toBe("HR_OFFICER");
    expect(financeVerified).toBe("FINANCE_VERIFIED");
    expect(settled).toBe("SETTLED");
  });

  it("blocks finance before HR approval", () => {
    expect(() => nextClaimStatus("EXCO_APPROVED", "FINANCE_VERIFY")).toThrow("Invalid transition");
  });
});
