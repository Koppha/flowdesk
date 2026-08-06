import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";

// Test state transitions that don't require hardcoded HR_REVIEW/HR_OFFICER states
describe("advance transitions", () => {
  it("blocks invalid transition", () => {
    expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
  });
});
