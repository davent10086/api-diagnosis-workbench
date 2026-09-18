import { describe, expect, it } from "vitest";
import { canCompleteCase } from "./case-status";

describe("case status transitions", () => {
  it("only completes an uploading case", () => {
    expect(canCompleteCase("uploading")).toBe(true);
    expect(canCompleteCase("completed")).toBe(false);
    expect(canCompleteCase("analyzing")).toBe(false);
  });
});
