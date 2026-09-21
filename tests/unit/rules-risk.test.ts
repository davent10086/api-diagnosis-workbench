import { describe, expect, it } from "vitest";
import { runRules } from "@/lib/rules";

describe("deterministic high-risk rules", () => {
  it("does not attribute a Bedrock unsupported tool to the customer", () => {
    const finding = runRules({ route: "bedrock", statusCode: 400, clientRequest: { tools: [{ type: "web_search_20250305" }] }, upstreamResponse: { type: "ValidationException" } }).find(x => x.ruleId === "bedrock-tool-compatibility");
    expect(finding).toMatchObject({ faultLayer: "adapter", needsMoreEvidence: false });
  });
  it("marks a bare 5xx as evidence-incomplete", () => {
    expect(runRules({ statusCode: 502 }).find(x => x.ruleId === "http-5xx")?.needsMoreEvidence).toBe(true);
  });
  it("detects malformed Anthropic lifecycle sequences", () => {
    for (const sse of [["event: content_block_stop index: 1"], ["event: content_block_start index: 0", "event: content_block_stop index: 1"]])
      expect(runRules({ sse }).some(x => x.ruleId.startsWith("anthropic-sse"))).toBe(true);
  });
});
