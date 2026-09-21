import { describe, expect, it } from "vitest";

const live = process.env.RUN_LIVE_LLM_TESTS === "1" && Boolean(process.env.DASHSCOPE_API_KEY);
describe.skipIf(!live)("DashScope live smoke (explicit opt-in only)", () => {
  it("uses a minimal non-sensitive prompt", async () => {
    const response = await fetch(`${process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1"}/services/aigc/text-generation/generation`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, body: JSON.stringify({ model: process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus", input: { messages: [{ role: "user", content: "请只回复 OK" }] }, parameters: { result_format: "message" } }) });
    expect(response.ok).toBe(true);
  });
});
