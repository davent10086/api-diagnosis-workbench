import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpenAICompatibleContent } from "@/lib/diagnosis";
import { openAICompatibleCompletion } from "@/lib/diagnosis-model";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible response adapter contract", () => {
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
