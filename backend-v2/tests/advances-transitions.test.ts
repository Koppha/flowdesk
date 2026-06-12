import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";

describe("advance transitions", () => {
  it("follows happy path", () => {
    const submitted        = nextStatusOrThrow("DRAFT",             "SUBMIT");
    const countersigned    = nextStatusOrThrow(submitted,           "APPROVE");
    const hrManagerReview  = nextStatusOrThrow(countersigned,       "APPROVE");
    const hrReview         = nextStatusOrThrow(hrManagerReview,     "APPROVE");
    const hrOfficer        = nextStatusOrThrow(hrReview,            "APPROVE");
    const paid             = nextStatusOrThrow(hrOfficer,           "MARK_PAID");

    expect(submitted).toBe("SUBMITTED");
    expect(countersigned).toBe("COUNTERSIGNED");
    expect(hrManagerReview).toBe("HR_MANAGER_REVIEW");
    expect(hrReview).toBe("HR_REVIEW");
    expect(hrOfficer).toBe("HR_OFFICER");
    expect(paid).toBe("PAID");
  });

  it("blocks invalid transition", () => {
    expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
  });
});
