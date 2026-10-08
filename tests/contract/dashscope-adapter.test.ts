import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpenAICompatibleContent } from "@/lib/diagnosis";
import { generateDiagnosisReport, openAICompatibleCompletion } from "@/lib/diagnosis-model";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible response adapter contract", () => {
  const validReport = { summary: "请求限流", root_cause: "可能发生限流", severity: "medium", fault_layer: "provider", confirmed_evidence: ["trace:statusCode 返回429"], hypotheses: ["可能是配额不足"], missing_evidence: ["需要配额日志"], next_actions: ["核对配额"], customer_message: "正在核查", root_cause_evidence: ["trace:statusCode"] };
  const input = { traceInput: { statusCode: 429 }, allFindings: [], successfulImages: [], textEvidence: [], knowledge: [], reasoningEffort: "low" as const, model: "qwen3.7-plus" };
  it("enables thinking and retains only the separate provider reasoning field", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...validReport, model_reasoning: "正文伪造内容" }), reasoning_content: "先核对429，再查看配额。" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateDiagnosisReport(input);
    expect(result.model_reasoning).toBe("先核对429，再查看配额。");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ enable_thinking: true, stream: false });
  });
  it("uses reasoning from the accepted repair response and handles a provider without reasoning", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "invalid json", reasoning_content: "被拒绝的分析" } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReport), reasoning_content: "修正后的分析" } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReport) } }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await generateDiagnosisReport(input)).model_reasoning).toBe("修正后的分析");
    expect((await generateDiagnosisReport(input)).model_reasoning).toBeUndefined();
  });
  it("preserves saved reasoning when resuming a completed model checkpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateDiagnosisReport({ ...input, checkpoint: { ...validReport, severity: "medium", fault_layer: "provider", model_reasoning: "保存的分析" } });
    expect(result.model_reasoning).toBe("保存的分析");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends the selected evidence excerpt rather than the beginning of its document", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const report = { summary: "兼容问题", root_cause: "工具不兼容", severity: "high", fault_layer: "provider", confirmed_evidence: ["knowledge:doc 工具不兼容"], hypotheses: ["可能存在转换问题"], missing_evidence: ["补充请求"], next_actions: ["核查工具"], customer_message: "正在核查", root_cause_evidence: ["knowledge:doc"] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(report) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateDiagnosisReport({ traceInput: {}, allFindings: [], successfulImages: [], textEvidence: [], knowledge: [{ id: "doc", title: "Tool compatibility", sourceUrl: "https://example.com", body: "irrelevant preamble ".repeat(100), excerpt: "web_search_20250305 is unsupported" }], reasoningEffort: "high", model: "test-model" });
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(options.body as string);
    const prompt = JSON.parse(payload.messages[1].content);
    expect(prompt.knowledge[0].excerpt).toBe("web_search_20250305 is unsupported");
  });
  it.each([
    [{ choices: [{ message: { content: "结构化报告" } }] }, "结构化报告"],
    [{ choices: [{ message: { content: [{ text: "结构化" }, { text: "报告" }] } }] }, "结构化报告"],
  ])("parses supported response shape", (body, expected) => expect(parseOpenAICompatibleContent(body)).toBe(expected));
  it("rejects empty or non-text responses", () => {
    expect(() => parseOpenAICompatibleContent({})).toThrow();
    expect(() => parseOpenAICompatibleContent({ choices: [{ message: { content: [] } }] })).toThrow();
  });

  it("sends standard chat completions with the existing DashScope key", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    vi.stubEnv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1");
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{\"summary\":\"正常\"}" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const messages = [{ role: "user", content: [{ type: "text", text: "检查截图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }];
    await expect(openAICompatibleCompletion("qwen-vl-max", messages, { response_format: { type: "json_object" } })).resolves.toContain("正常");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(options.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(JSON.parse(options.body as string)).toEqual({ model: "qwen-vl-max", messages, stream: false, response_format: { type: "json_object" } });
  });
});
