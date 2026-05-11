import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";
describe("advance transitions", () => {
    it("follows happy path", () => {
        const submitted = nextStatusOrThrow("DRAFT", "SUBMIT");
        const countersigned = nextStatusOrThrow(submitted, "COUNTERSIGN");
        const hrManagerReview = nextStatusOrThrow(countersigned, "APPROVE");
        const approved = nextStatusOrThrow(hrManagerReview, "APPROVE");
        const paid = nextStatusOrThrow(approved, "MARK_PAID");
        expect(submitted).toBe("SUBMITTED");
        expect(countersigned).toBe("COUNTERSIGNED");
        expect(hrManagerReview).toBe("HR_MANAGER_REVIEW");
        expect(approved).toBe("APPROVED");
        expect(paid).toBe("PAID");
    });
    it("routes salary advances through HR then finance approval", () => {
        const hrApproved = nextStatusOrThrow("AUTH_OFFICER_APPROVED", "APPROVE");
        const paid = nextStatusOrThrow(hrApproved, "MARK_PAID");
        expect(hrApproved).toBe("APPROVED");
        expect(paid).toBe("PAID");
    });
    it("blocks invalid transition", () => {
        expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
    });
});
