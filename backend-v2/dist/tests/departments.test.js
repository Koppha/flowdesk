import { describe, expect, it } from "vitest";
import { DEFAULT_DEPARTMENT_GROUPS, normalizeDepartmentName } from "../src/lib/departments.js";
describe("department groups", () => {
    it("normalizes whitespace in department names", () => {
        expect(normalizeDepartmentName("  Customer   Experience  ")).toBe("Customer Experience");
    });
    it("ships unique default department groups", () => {
        const normalized = DEFAULT_DEPARTMENT_GROUPS.map((department) => department.toLowerCase());
        expect(DEFAULT_DEPARTMENT_GROUPS).toContain("Finance");
        expect(DEFAULT_DEPARTMENT_GROUPS).toContain("Human Resources");
        expect(DEFAULT_DEPARTMENT_GROUPS).toContain("Information Technology");
        expect(new Set(normalized).size).toBe(DEFAULT_DEPARTMENT_GROUPS.length);
    });
});
