import { describe, expect, it } from "vitest";
import { canViewAdvance } from "../src/modules/advances/advances.routes.js";
describe("advance view access", () => {
    it("allows the requester to view their own advance", async () => {
        expect(await canViewAdvance({
            role: "EMPLOYEE",
            requesterId: "requester-1",
            createdById: "requester-1",
            userId: "requester-1"
        })).toBe(true);
    });
    it("allows ADMIN to view any advance", async () => {
        expect(await canViewAdvance({
            role: "ADMIN",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "admin-1"
        })).toBe(true);
    });
    it("allows an approver in the resolved workflow chain to view the advance", async () => {
        expect(await canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "manager-1",
            approvalChain: [
                { approver_id: "manager-1" }
            ]
        })).toBe(true);
    });
    it("allows anyone in the requester's management chain (org structure) to view the advance", async () => {
        expect(await canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "manager-1",
            managerChainIds: ["manager-1", "hod-1"]
        })).toBe(true);
    });
    it("denies a user with no relation to the advance", async () => {
        expect(await canViewAdvance({
            role: "MANAGER",
            requesterId: "requester-1",
            createdById: "creator-2",
            userId: "stranger-1",
            approvalChain: [{ approver_id: "manager-1" }],
            managerChainIds: ["manager-1", "hod-1"]
        })).toBe(false);
    });
});
