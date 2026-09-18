import { describe, expect, it } from "vitest";
import { parseAiReport } from "./diagnosis";

const report = {
  summary: "429 限流",
  root_cause: "上游配额不足",
  confidence: "85%",
  severity: "high",
  fault_layer: "provider",
  confirmed_evidence: ["rule:http-429"],
  hypotheses: [],
  missing_evidence: [],
  next_actions: ["检查配额"],
  customer_message: "正在处理。",
};

describe("parseAiReport", () => {
  it("normalizes percentage confidence without weakening report validation", () => {
    expect(parseAiReport(JSON.stringify(report)).confidence).toBe(85);
  });

  it("rejects malformed JSON and missing required report fields", () => {
    expect(() => parseAiReport("not json")).toThrow();
    expect(() => parseAiReport(JSON.stringify({ summary: "only summary" }))).toThrow();
  });
});
