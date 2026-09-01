import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../src/lib/db.js", () => ({
  query: queryMock,
  withTransaction: vi.fn()
}));

import { getUnapprovedStepIndices, resolveRequesterHod } from "../src/lib/workflowEngine.js";

describe("HOD workflow resolution", () => {
  beforeEach(() => queryMock.mockReset());

  it("walks past a direct MANAGER to the actual HOD", async () => {
    queryMock
      .mockResolvedValueOnce([{ manager_id: "manager-1" }])
      .mockResolvedValueOnce([{ id: "manager-1", full_name: "Direct Manager", title: "Manager", email: "manager@example.com", role: "MANAGER" }])
      .mockResolvedValueOnce([{ manager_id: "hod-1" }])
      .mockResolvedValueOnce([{ id: "hod-1", full_name: "Department HOD", title: "HOD", email: "hod@example.com", role: "HOD" }]);

    await expect(resolveRequesterHod("employee-1")).resolves.toMatchObject({
      id: "hod-1",
      role: "HOD"
    });
  });

  it("includes future unapproved steps when a pending workflow is swept", () => {
    const chain = [
      { approved: true },
      { approved: false, position_type_code: "MANAGER" },
      { position_type_code: "EXCO" },
      { position_type_code: "MANAGER", approval_group_name: "HR Operations" }
    ] as any;

    expect(getUnapprovedStepIndices(chain, 1)).toEqual([1, 2, 3]);
  });

  it("keeps a direct manager who is already the HOD", async () => {
    queryMock
      .mockResolvedValueOnce([{ manager_id: "hod-1" }])
      .mockResolvedValueOnce([{ id: "hod-1", full_name: "Department HOD", title: "HOD", email: "hod@example.com", role: "HOD" }]);

    await expect(resolveRequesterHod("employee-1")).resolves.toMatchObject({
      id: "hod-1",
      role: "HOD"
    });
  });
});
