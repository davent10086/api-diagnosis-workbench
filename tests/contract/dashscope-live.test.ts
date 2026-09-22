import { describe, expect, it } from "vitest";

const live = process.env.RUN_LIVE_LLM_TESTS === "1" && Boolean(process.env.DASHSCOPE_API_KEY);
describe.skipIf(!live)("DashScope live smoke (explicit opt-in only)", () => {
  it("uses a minimal non-sensitive prompt", async () => {
    const response = await fetch(`${process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1"}/services/aigc/multimodal-generation/generation`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, body: JSON.stringify({ model: process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus", input: { messages: [{ role: "user", content: "请只回复 OK" }] }, parameters: { result_format: "message" } }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: unknown; message?: unknown };
      const code = typeof body.code === "string" ? ` / ${body.code}` : "";
      const message = typeof body.message === "string" ? `: ${body.message.slice(0, 300)}` : "";
      throw new Error(`DashScope live smoke failed (HTTP ${response.status}${code})${message}`);
    }
    expect(response.ok).toBe(true);
  });
});
