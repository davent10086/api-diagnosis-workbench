import { describe, expect, it } from "vitest";
import { parseAiReport, parseOpenAICompatibleContent, validateEvidence, workflowSummary } from "@/lib/diagnosis";
import { traceReferenceSet } from "@/lib/diagnosis-retrieval";
import { isChineseReport } from "@/lib/diagnosis-model";

const report = {
  summary: "上游返回限流", root_cause: "配额不足", severity: "high", fault_layer: "provider",
  confirmed_evidence: ["rule:http-429"], hypotheses: ["可能存在突发流量"], missing_evidence: ["补充重试记录"], next_actions: ["检查配额"], customer_message: "请确认上游配额。",
};

describe("diagnosis boundary validation", () => {
  it("accepts Chinese reports containing bare evidence references while rejecting English explanations", () => {
    const parsed = parseAiReport(JSON.stringify(report));
    expect(isChineseReport(parsed)).toBe(true);
    expect(isChineseReport({ ...parsed, confirmed_evidence: ["trace:upstreamResponse", "image:asset[0]"] })).toBe(true);
    expect(isChineseReport({ ...parsed, root_cause: "Rate limit reached" })).toBe(false);
    expect(isChineseReport({ ...parsed, confirmed_evidence: ["rule:http-429 The request was rate limited"] })).toBe(false);
  });
  it("accepts fenced JSON but returns actionable parse errors", () => {
    expect(parseAiReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``).summary).toBe(report.summary);
    expect(() => parseAiReport("not json")).toThrow("Invalid AI diagnosis report");
  });
  it("rejects invented evidence IDs and unknown source prefixes", () => {
    const parsed = parseAiReport(JSON.stringify({ ...report, confirmed_evidence: ["knowledge:invented"] }));
    expect(() => validateEvidence(parsed, { ruleIds: new Set(["http-429"]), knowledgeIds: new Set(), imageIds: new Set(), textEvidenceIds: new Set(), traceReferences: new Set() })).toThrow("Invalid evidence reference");
  });
  it("accepts a real reference with explanation but rejects lookalike IDs", () => {
    const context = { ruleIds: new Set(["http-429"]), knowledgeIds: new Set<string>(), imageIds: new Set<string>(), textEvidenceIds: new Set<string>(), traceReferences: traceReferenceSet({ statusCode: 429 }) };
    const supported = parseAiReport(JSON.stringify({ ...report, confirmed_evidence: ["rule:http-429：观察到限流。"], root_cause_evidence: ["trace:statusCode"] }));
    expect(() => validateEvidence(supported, context)).not.toThrow();
    expect(() => validateEvidence({ ...supported, confirmed_evidence: ["rule:http-429-spoof"] }, context)).toThrow("Invalid evidence reference");
    expect(() => validateEvidence({ ...supported, root_cause_evidence: ["trace:upstreamResponse"] }, context)).toThrow("Invalid evidence reference");
  });
  it("normalizes supported DashScope content shapes without accepting empty choices", () => {
    expect(parseOpenAICompatibleContent({ choices: [{ message: { content: [{ text: "报告" }, { text: "正文" }] } }] })).toBe("报告正文");
    expect(() => parseOpenAICompatibleContent({ choices: [] })).toThrow("未返回正文");
  });
  it("classifies rate limits, cancellation and network failures", () => {
    expect(workflowSummary(new Error("HTTP 429"))).toBe("upstream rate limited");
    expect(workflowSummary(new Error("timeout"))).toBe("upstream timeout or cancellation");
    expect(workflowSummary(new Error("fetch failed"))).toBe("upstream connection failed");
  });
});
