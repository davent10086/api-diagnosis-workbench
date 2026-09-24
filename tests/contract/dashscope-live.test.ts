import { describe, expect, it } from "vitest";

const live = process.env.RUN_LIVE_LLM_TESTS === "1" && Boolean(process.env.DASHSCOPE_API_KEY);
describe.skipIf(!live)("DashScope OpenAI-compatible live smoke (explicit opt-in only)", () => {
  it("uses a minimal non-sensitive prompt", async () => {
    const legacyBase = process.env.DASHSCOPE_BASE_URL?.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");
    const base = (process.env.OPENAI_COMPAT_BASE_URL || legacyBase || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, body: JSON.stringify({ model: process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus", messages: [{ role: "user", content: '请只返回 JSON 对象 {"ok":true}' }], response_format: { type: "json_object" }, reasoning_effort: "low", stream: false }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: unknown; message?: unknown } };
      const code = typeof body.error?.code === "string" ? ` / ${body.error.code}` : "";
      const message = typeof body.error?.message === "string" ? `: ${body.error.message.slice(0, 300)}` : "";
      throw new Error(`DashScope live smoke failed (HTTP ${response.status}${code})${message}`);
    }
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    expect(JSON.parse(body.choices?.[0]?.message?.content || "")).toMatchObject({ ok: true });
  });
  it("accepts an image_url data URI", async () => {
    const legacyBase = process.env.DASHSCOPE_BASE_URL?.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");
    const base = (process.env.OPENAI_COMPAT_BASE_URL || legacyBase || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAqSURBVFhH7c4xAQAADMOg+TedyegDCrjGBAQEBAQEBAQEBAQEBAQExoF6l/rw4lHYRKwAAAAASUVORK5CYII=";
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }, body: JSON.stringify({ model: process.env.QWEN_VISION_MODEL || "qwen-vl-max", messages: [{ role: "user", content: [{ type: "text", text: '请只返回 JSON 对象 {"visible":true}' }, { type: "image_url", image_url: { url: image } }] }], response_format: { type: "json_object" }, stream: false }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`Vision compatibility smoke failed (HTTP ${response.status}): ${body.error?.message?.slice(0, 300) || "request rejected"}`);
    }
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    expect(JSON.parse(body.choices?.[0]?.message?.content || "")).toHaveProperty("visible");
  });
});
