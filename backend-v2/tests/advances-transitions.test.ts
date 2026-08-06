import { describe, expect, it } from "vitest";
import { nextStatusOrThrow } from "../src/modules/advances/advances.service.js";

describe("advance transitions", () => {
  it("blocks invalid transition", () => {
    expect(() => nextStatusOrThrow("DRAFT", "APPROVE")).toThrow("Invalid transition");
  });
});
