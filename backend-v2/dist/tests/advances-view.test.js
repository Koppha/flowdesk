import { describe, expect, it } from "vitest";
import { canViewAdvance } from "../src/modules/advances/advances.routes.js";
describe("advance view access", () => {
    it("allows managers to view submitted advances", () => {
        expect(canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "manager-1",
            status: "SUBMITTED",
            type: "TRAVEL_SUBSISTENCE"
        })).toBe(true);
    });
    it("allows managers to view submitted salary advances", () => {
        expect(canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "manager-1",
            status: "SUBMITTED",
            type: "SALARY"
        })).toBe(true);
    });
    it("allows HR managers to view advances awaiting HR Manager review", () => {
        expect(canViewAdvance({
            role: "HR_MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "hr-manager-1",
            status: "HR_MANAGER_REVIEW",
            type: "TRAVEL_SUBSISTENCE"
        })).toBe(true);
    });
    it("allows managers to view advances that have moved on after submission", () => {
        expect(canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "manager-1",
            status: "HR_REVIEW",
            type: "TRAVEL_SUBSISTENCE"
        })).toBe(true);
    });
    it("allows HR managers to view advances already at HR review", () => {
        expect(canViewAdvance({
            role: "HR_MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "hr-manager-1",
            status: "HR_REVIEW",
            type: "TRAVEL_SUBSISTENCE"
        })).toBe(true);
    });
    it("allows EXCO to view advances awaiting EXCO review", () => {
        expect(canViewAdvance({
            role: "EXCO",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "exco-1",
            status: "CHIEF_OFFICER_REVIEW",
            type: "TRAVEL_SUBSISTENCE"
        })).toBe(true);
    });
    it("allows HR to view company-wide advances awaiting HR review", () => {
        expect(canViewAdvance({
            role: "AUTH_OFFICER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "hr-1",
            status: "HR_REVIEW",
            type: "SALARY"
        })).toBe(true);
    });
});
