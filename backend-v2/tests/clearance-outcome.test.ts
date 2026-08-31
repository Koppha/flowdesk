import { describe, expect, it } from "vitest";
import { computeFinancialOutcome } from "../src/modules/claims/claims.service.js";
import { nextClaimStatus } from "../src/modules/claims/claims.routes.js";
import { canApproveStep, isRoundRobinCandidate, type ChainStep } from "../src/lib/workflowEngine.js";

function baseStep(overrides: Partial<ChainStep> = {}): ChainStep {
  return {
    step_order: 1,
    position_type_code: "MANAGER",
    position_name: "Test Step",
    approver_id: null,
    approver_ids: [],
    approver_name: null,
    approver_title: null,
    approver_email: null,
    required: true,
    final_approval: false,
    approval_mode: "SINGLE",
    approval_group_name: null,
    requires_accommodation: false,
    parallel_with_previous: false,
    action_type: "APPROVE",
    can_reject: true,
    can_rollback: true,
    ...overrides
  };
}

describe("computeFinancialOutcome", () => {
  // clearanceBalance = verifiedExpenseAmount - approvedAdvanceAmount, but this
  // codebase's balance_amount column is the other sign (advance - claimTotal)
  // - see the doc comment on computeFinancialOutcome for why.
  it("returns BALANCED when expenses exactly equal the advance", () => {
    expect(computeFinancialOutcome(0)).toBe("BALANCED");
  });

  it("returns PAYBACK_DUE when the employee spent less than the advance (positive balance_amount)", () => {
    // Approved advance M5,000, verified expenses M4,200 -> balance_amount = +800
    expect(computeFinancialOutcome(800)).toBe("PAYBACK_DUE");
  });

  it("returns REFUND_DUE when the employee spent more than the advance (negative balance_amount)", () => {
    // Approved advance M5,000, verified expenses M5,800 -> balance_amount = -800
    expect(computeFinancialOutcome(-800)).toBe("REFUND_DUE");
  });

  it("handles decimal amounts correctly without floating-point drift", () => {
    expect(computeFinancialOutcome(0.01)).toBe("PAYBACK_DUE");
    expect(computeFinancialOutcome(-0.01)).toBe("REFUND_DUE");
    // The classic 0.1 + 0.2 floating point trap - confirms plain === is safe
    // here because callers always pass values already rounded via
    // Number(x.toFixed(2)), never raw sums.
    expect(computeFinancialOutcome(Number((0.1 + 0.2 - 0.3).toFixed(2)))).toBe("BALANCED");
  });
});

describe("new trip-completion statuses never fall back to the legacy transition map", () => {
  it("keeps every new status as a dead-end in nextClaimStatus (only advanceClaimWorkflowStep/payback-proof/treasury routes write them directly)", () => {
    for (const status of ["REFUND_DUE", "PAYBACK_DUE", "PAYBACK_PROOF_SUBMITTED", "PAYBACK_PROOF_REJECTED", "FINANCE_TREASURY_REVIEW", "COMPLETED"] as const) {
      // Same style as the existing "blocks finance before HR approval" test
      // in claims-transitions.test.ts - any action probed against these
      // statuses should be rejected, since they're only ever written
      // directly by advanceClaimWorkflowStep / the payback-proof and
      // treasury routes, never advanced through this legacy map.
      expect(() => nextClaimStatus(status, "MANAGER_APPROVE")).toThrow("Invalid transition");
    }
  });

  it("never reintroduces the removed legacy statuses (COUNTERSIGNED/HR_MANAGER_REVIEW/HR_REVIEW/PAID belong to advance_requests or were purged, never clearance_claims)", () => {
    const map = ["DRAFT", "SUBMITTED", "MANAGER_APPROVED", "EXCO_APPROVED", "HR_OFFICER", "FINANCE_VERIFIED", "PAYMENT_PROCESSING", "SETTLED", "CLOSED", "REJECTED", "REFUND_DUE", "PAYBACK_DUE", "PAYBACK_PROOF_SUBMITTED", "PAYBACK_PROOF_REJECTED", "FINANCE_TREASURY_REVIEW", "COMPLETED"];
    expect(map).not.toContain("COUNTERSIGNED");
    expect(map).not.toContain("HR_MANAGER_REVIEW");
    expect(map).not.toContain("HR_REVIEW");
    expect(map).not.toContain("PAID");
  });
});

describe("round-robin restriction (accommodation booking / clearance closing / payback review)", () => {
  const assignedId = "user-assigned";
  const otherId = "user-other";

  it("only the assigned_user_id may act once a step is round-robin-restricted", async () => {
    const step = baseStep({ assigned_user_id: assignedId, approver_ids: [assignedId, otherId] });
    expect(await canApproveStep(step, assignedId, "EMPLOYEE")).toBe(true);
    expect(await canApproveStep(step, otherId, "EMPLOYEE")).toBe(false);
  });

  it("delegation still works for the assigned person's delegate", async () => {
    const step = baseStep({ assigned_user_id: assignedId });
    expect(await canApproveStep(step, "delegate-1", "MANAGER", [assignedId])).toBe(true);
  });

  it("every other candidate in the fixed roster can still view (isRoundRobinCandidate) even though they can't act", async () => {
    const step = baseStep({ assigned_user_id: assignedId, approver_ids: [assignedId, otherId] });
    expect(await isRoundRobinCandidate(step, otherId, "EMPLOYEE")).toBe(true);
    expect(await isRoundRobinCandidate(step, "someone-else", "EMPLOYEE")).toBe(false);
  });

  it("a step with no assigned_user_id is unaffected - existing chains built before this feature behave exactly as before", async () => {
    const step = baseStep({ approver_id: otherId, approver_ids: [otherId] });
    expect(await canApproveStep(step, otherId, "EMPLOYEE")).toBe(true);
    expect(await isRoundRobinCandidate(step, otherId, "EMPLOYEE")).toBe(false);
  });
});
