import { describe, expect, it } from "vitest";
import { hasDiagnosticEvidence, imageRuleFindings, parseImageExtraction } from "./image-evidence";
import { buildEvidenceLedger } from "./diagnosis-quality";
import { parseAiReport, validateEvidence } from "./diagnosis-model";

describe("image evidence boundaries", () => {
  it("accepts detailed long screenshots with more than 30 readable fields", () => {
    const fields = Array.from({ length: 40 }, (_, index) => ({ name: `parameter_${index}`, value: `visible_${index}`, quote: `parameter_${index}: visible_${index}` }));
    const result = parseImageExtraction(JSON.stringify({ summary: "多段请求参数", fields }));
    expect(result.status).toBe("completed");
    expect(result.fields).toHaveLength(40);
  });
  it("does not accept an empty extraction or a summary alone as readable evidence", () => {
    for (const fields of [[], [" "], { request_id: null }]) {
      expect(parseImageExtraction(JSON.stringify({ summary: "图片看不清", fields })).status).toBe("unreadable");
    }
  });
  it("preserves field values, original quotes and locations in fenced JSON", () => {
    const result = parseImageExtraction('```json\n' + JSON.stringify({ summary: "缓存日志", fields: [{ name: "cache_read_tokens", value: 26749, quote: "缓存读取 26,749", location: "Token 明细" }] }) + '\n```');
    expect(result.fields).toEqual(["cache_read_tokens=26749"]);
    expect(result.observations?.[0]).toMatchObject({ quote: "缓存读取 26,749", location: "Token 明细" });
    expect(buildEvidenceLedger({}, [], [], [{ id: "image-a", ...result }]).find((item) => item.id === "image:image-a[0]")?.statement).toContain("缓存读取 26,749");
  });
  it("does not turn null or unreadable fields into reported values", () => {
    const result = parseImageExtraction(JSON.stringify({ summary: "部分可读", fields: [{ name: "request_id", value: null, quote: "", readable: false }, { name: "http_status_code", value: 429, quote: "HTTP 429" }] }));
    expect(result.fields).toEqual(["http_status_code=429"]);
    expect(result.warnings?.join(" ")).toContain("request_id");
  });
  it("generates candidate rules for explicit screenshot errors without confirming them", () => {
    const findings = imageRuleFindings({}, [{ id: "image-a", status: "completed", fields: ["http_status_code=429", "error_code=ThrottlingException"] }], []);
    expect(findings.find((finding) => finding.ruleId.endsWith("http-429"))).toMatchObject({ needsMoreEvidence: true, evidence: expect.arrayContaining(["image:image-a"]) });
  });
  it("does not mistake consumption counters or a retry channel for HTTP status or retries", () => {
    const findings = imageRuleFindings({}, [{ id: "image-a", status: "completed", fields: ["重试链路=78", "缓存读取=26749", "响应时间=4.0s", "输入Token=429"] }], []);
    expect(findings).toEqual([]);
  });
  it("validates exact image field references and rejects nonexistent indexes", () => {
    const report = parseAiReport(JSON.stringify({ summary: "限流", root_cause: "可能限流", severity: "medium", fault_layer: "unknown", confirmed_evidence: ["image:image-a[0] HTTP 429"], hypotheses: [], missing_evidence: [], next_actions: ["核对原图"], customer_message: "正在核查" }));
    const context = { imageIds: new Set(["image-a", "image-a[0]"]), ruleIds: new Set<string>(), knowledgeIds: new Set<string>(), textEvidenceIds: new Set<string>(), traceReferences: new Set<string>() };
    expect(() => validateEvidence(report, context)).not.toThrow();
    expect(() => validateEvidence({ ...report, confirmed_evidence: ["image:image-a[999] HTTP 429"] }, context)).toThrow("Invalid evidence reference");
  });
  it("does not count customer prose, model names or timestamps as recovered image evidence", () => {
    expect(hasDiagnosticEvidence({ customerQuestion: "返回错误", model: "claude", logs: ["occurred_at=today"] }, [])).toBe(false);
    expect(hasDiagnosticEvidence({ clientRequest: {}, upstreamResponse: { error: {} }, sse: [""] }, [])).toBe(false);
    expect(hasDiagnosticEvidence({ statusCode: 502 }, [])).toBe(true);
  });
});
