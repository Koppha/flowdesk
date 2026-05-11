import { describe, expect, it } from "vitest";
import { canViewAdvance } from "../src/modules/advances/advances.routes.js";

describe("advance view access", () => {
  it("allows countersign users to view submitted travel advances", () => {
    expect(
      canViewAdvance({
        role: "COUNTERSIGN",
        requesterId: "requester-1",
        createdById: "creator-2",
        userId: "countersign-1",
        status: "SUBMITTED",
        type: "TRAVEL_SUBSISTENCE"
      })
    ).toBe(true);
  });

  it("allows managers to view counter-signed travel advances", () => {
    expect(
      canViewAdvance({
        role: "MANAGER",
        requesterId: "requester-1",
        createdById: "creator-2",
        userId: "manager-1",
        status: "COUNTERSIGNED",
        type: "TRAVEL_SUBSISTENCE"
      })
    ).toBe(true);
  });

  it("allows HR managers to view travel advances awaiting HR Manager review", () => {
    expect(
      canViewAdvance({
        role: "HR_MANAGER",
        requesterId: "requester-1",
        createdById: "creator-2",
        userId: "hr-manager-1",
        status: "HR_MANAGER_REVIEW",
        type: "TRAVEL_SUBSISTENCE"
      })
    ).toBe(true);
  });

  it("does not allow managers to view counter-signed salary advances", () => {
    expect(
      canViewAdvance({
        role: "MANAGER",
        requesterId: "requester-1",
        createdById: "creator-2",
        userId: "manager-1",
        status: "COUNTERSIGNED",
        type: "SALARY"
      })
    ).toBe(false);
  });
});
