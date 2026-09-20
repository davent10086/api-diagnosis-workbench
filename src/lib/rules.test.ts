import { describe, it, expect } from "vitest";
import { runRules } from "./rules";
import type { Trace } from "./types";
describe("P0 规则", () => {
  it("识别 Bedrock 工具不兼容", () => {
    const r = runRules({
      route: "bedrock",
      statusCode: 400,
      clientRequest: { tools: [{ type: "web_search_20250305" }] },
      upstreamResponse: { type: "ValidationException" },
    });
    expect(r.some((x) => x.ruleId === "bedrock-tool-compatibility")).toBe(true);
  });
  it("5xx 缺上游响应时不归因", () => {
    const r = runRules({ statusCode: 502 });
    expect(r.find((x) => x.ruleId === "http-5xx")?.needsMoreEvidence).toBe(true);
  });
  it("检测 SSE stop 缺少 start", () => {
    expect(
      runRules({ sse: ["event: content_block_stop index: 1"] }).some(
        (x) => x.ruleId === "anthropic-sse-lifecycle",
      ),
    ).toBe(true);
  });
});

describe("供应商回归案例", () => {
  const cases: [string, Trace, string][] = [
    ["OpenAI 不支持参数", { provider: "OpenAI", upstreamResponse: { code: "unsupported_parameter" } }, "openai-parameter-compatibility"],
    ["Gemini 安全拦截", { provider: "Gemini", statusCode: 200, upstreamResponse: { candidates: [{ finishReason: "SAFETY" }] } }, "gemini-safety-block"],
    ["DeepSeek 上下文超限", { provider: "DeepSeek", upstreamResponse: { code: "context_length_exceeded" } }, "context-window-exceeded"],
    ["OpenRouter 缺少上游证据", { provider: "OpenRouter", statusCode: 502 }, "http-5xx"],
    ["智谱取消", { provider: "Zhipu", logs: ["context canceled"] }, "cancellation"],
    ["MiniMax 请求转换", { provider: "MiniMax", clientRequest: { model: "a" }, transformedRequest: { model: "b" } }, "protocol-diff"],
    ["Moonshot 工具生命周期", { provider: "Moonshot", clientRequest: { type: "tool_result" } }, "tool-lifecycle"],
    ["火山引擎限流缺重试", { provider: "Volcengine", statusCode: 429 }, "http-429"],
  ];

  it.each(cases)("%s", (_name, trace, expectedRule) => {
    const finding = runRules(trace).find((item) => item.ruleId === expectedRule);
    expect(finding).toBeDefined();
    if (expectedRule === "http-5xx" || expectedRule === "http-429")
      expect(finding?.needsMoreEvidence).toBe(true);
    else expect(finding?.needsMoreEvidence).toBe(false);
  });
});
