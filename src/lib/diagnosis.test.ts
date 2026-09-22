import { describe, expect, it } from "vitest";
import { knowledgeCitationIds, knowledgeQueries, parseAiReport } from "./diagnosis";
import { normalizeKnowledgeVendor } from "./knowledge";

const report = {
  summary: "429 限流",
  root_cause: "上游配额不足",
  severity: "high",
  fault_layer: "provider",
  confirmed_evidence: ["rule:http-429"],
  hypotheses: [],
  missing_evidence: [],
  next_actions: ["检查配额"],
  customer_message: "正在处理。",
  root_cause_evidence: ["rule:http-429"],
};

describe("parseAiReport", () => {
  it("accepts a report without a confidence field", () => {
    expect(parseAiReport(JSON.stringify(report)).summary).toBe(report.summary);
  });

  it("rejects malformed JSON and missing required report fields", () => {
    expect(() => parseAiReport("not json")).toThrow();
    expect(() => parseAiReport(JSON.stringify({ summary: "only summary" }))).toThrow();
  });
});

describe("knowledge vendor normalization", () => {
  it("normalizes provider names before filtering the knowledge base", () => {
    expect(normalizeKnowledgeVendor(" Anthropic ")).toBe("anthropic");
    expect(normalizeKnowledgeVendor("Gemini")).toBe("google gemini");
    expect(normalizeKnowledgeVendor("bedrock/claude")).toBe("aws");
  });
});

describe("knowledge citations", () => {
  it("persists a knowledge id even when the model appends an explanation", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect([...knowledgeCitationIds([`knowledge:${id} 官方文档明确要求数组。`, "rule:http-429"])]).toEqual([id]);
  });

  it("rejects malformed knowledge references instead of storing arbitrary text as an id", () => {
    expect([...knowledgeCitationIds(["knowledge:not-a-uuid 说明"])]).toEqual([]);
  });
});

describe("knowledge query extraction", () => {
  it("prioritizes diagnostic tokens while retaining Chinese phrases and excluding credentials", () => {
    const queries = knowledgeQueries(
      {
        customerQuestion: "调用超时，出现 ValidationException 和 context_length_exceeded",
        statusCode: 429,
        model: "gpt-4.1-mini",
        route: "/v1/chat/completions",
        logs: ["Authorization: Bearer secret-value", "event: message_start"],
      },
      [{ ruleId: "http-429", severity: "high", faultLayer: "provider", conclusion: "限流", evidence: [], needsMoreEvidence: false }],
      [],
    );
    expect(queries.map((item) => item.value)).toContain("429");
    expect(queries.map((item) => item.value)).toContain("ValidationException");
    expect(queries.map((item) => item.value)).toContain("context_length_exceeded");
    expect(queries.map((item) => item.value)).toContain("message_start");
    expect(queries.map((item) => item.value).join(" ")).not.toContain("secret-value");
  });
});
