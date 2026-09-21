import { describe, expect, it } from "vitest";
import { parseAiReport, parseDashScopeContent, validateEvidence, workflowSummary } from "@/lib/diagnosis";

const report = {
  summary: "上游返回限流", root_cause: "配额不足", confidence: "85%", severity: "high", fault_layer: "provider",
  confirmed_evidence: ["rule:http-429"], hypotheses: ["可能存在突发流量"], missing_evidence: ["补充重试记录"], next_actions: ["检查配额"], customer_message: "请确认上游配额。",
};

describe("diagnosis boundary validation", () => {
  it("accepts fenced JSON but returns actionable parse errors", () => {
    expect(parseAiReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``).confidence).toBe(85);
    expect(() => parseAiReport("not json")).toThrow("Invalid AI diagnosis report");
  });
  it("rejects invented evidence IDs and unknown source prefixes", () => {
    const parsed = parseAiReport(JSON.stringify({ ...report, confirmed_evidence: ["knowledge:invented"] }));
    expect(() => validateEvidence(parsed, { ruleIds: new Set(["http-429"]), knowledgeIds: new Set(), imageIds: new Set(), textEvidenceIds: new Set(), traceReferences: new Set() })).toThrow("Invalid evidence reference");
  });
  it("normalizes supported DashScope content shapes without accepting empty choices", () => {
    expect(parseDashScopeContent({ output: { choices: [{ message: { content: [{ text: "报告" }, { text: "正文" }] } }] } })).toBe("报告正文");
    expect(() => parseDashScopeContent({ output: { choices: [] } })).toThrow("did not return content");
  });
  it("classifies rate limits, cancellation and network failures", () => {
    expect(workflowSummary(new Error("HTTP 429"))).toBe("upstream rate limited");
    expect(workflowSummary(new Error("timeout"))).toBe("upstream timeout or cancellation");
    expect(workflowSummary(new Error("fetch failed"))).toBe("upstream connection failed");
  });
});
