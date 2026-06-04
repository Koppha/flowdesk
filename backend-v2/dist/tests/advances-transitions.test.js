import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";
describe("advance transitions", () => {
    it("follows happy path", () => {
        const submitted = nextStatusOrThrow("DRAFT", "SUBMIT");
        const chiefOfficerReview = nextStatusOrThrow(submitted, "APPROVE");
        const financeReview = nextStatusOrThrow(chiefOfficerReview, "APPROVE");
        const paid = nextStatusOrThrow(financeReview, "MARK_PAID");
        expect(submitted).toBe("SUBMITTED");
        expect(chiefOfficerReview).toBe("CHIEF_OFFICER_REVIEW");
        expect(financeReview).toBe("HR_OFFICER");
        expect(paid).toBe("PAID");
    });
    it("blocks invalid transition", () => {
        expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
    });
    it("routes chief officer review to finance review", () => {
        const next = nextStatusOrThrow("CHIEF_OFFICER_REVIEW", "APPROVE");
        expect(next).toBe("HR_OFFICER");
    });
});
