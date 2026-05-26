import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";
describe("advance transitions", () => {
    it("follows happy path", () => {
        const submitted = nextStatusOrThrow("DRAFT", "SUBMIT");
        const hrManagerReview = nextStatusOrThrow(submitted, "APPROVE");
        const hrReview = nextStatusOrThrow(hrManagerReview, "APPROVE");
        const hrApproved = nextStatusOrThrow(hrReview, "APPROVE");
        const paid = nextStatusOrThrow(hrApproved, "MARK_PAID");
        expect(submitted).toBe("SUBMITTED");
        expect(hrManagerReview).toBe("HR_MANAGER_REVIEW");
        expect(hrReview).toBe("HR_REVIEW");
        expect(hrApproved).toBe("HR_OFFICER");
        expect(paid).toBe("PAID");
    });
    it("blocks invalid transition", () => {
        expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
    });
    it("uses chief officer review before HR manager review", () => {
        const next = nextStatusOrThrow("CHIEF_OFFICER_REVIEW", "APPROVE");
        expect(next).toBe("HR_MANAGER_REVIEW");
    });
});
