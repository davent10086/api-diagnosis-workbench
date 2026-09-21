import { describe, expect, it } from "vitest";
import { parseDashScopeContent } from "@/lib/diagnosis";

describe("DashScope response adapter contract", () => {
  it.each([
    [{ output: { choices: [{ message: { content: "结构化报告" } }] } }, "结构化报告"],
    [{ output: { choices: [{ message: { content: [{ text: "结构化" }, { text: "报告" }] } }] } }, "结构化报告"],
  ])("parses supported response shape", (body, expected) => expect(parseDashScopeContent(body)).toBe(expected));
  it("rejects empty or non-text responses", () => {
    expect(() => parseDashScopeContent({})).toThrow();
    expect(() => parseDashScopeContent({ output: { choices: [{ message: { content: [] } }] } })).toThrow();
  });
});
