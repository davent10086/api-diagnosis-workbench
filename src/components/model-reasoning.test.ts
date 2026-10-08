import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelReasoning } from "./model-reasoning";

describe("model reasoning display", () => {
  it("renders provider text as escaped text in a collapsed disclosure", () => {
    const html = renderToStaticMarkup(createElement(ModelReasoning, { reasoning: "核对证据\n<script>alert(1)</script>", status: "completed" }));
    expect(html).toMatch(/<details\b[^>]*>/);
    expect(html).not.toMatch(/<details\b[^>]*\bopen(?:=|\s|>)/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("尚未核实");
  });
  it("explains old or missing reasoning without displaying malformed data", () => {
    const html = renderToStaticMarkup(createElement(ModelReasoning, { reasoning: { unexpected: true }, status: "completed" }));
    expect(html).toContain("没有保存思考内容");
    expect(html).not.toContain("[object Object]");
  });
  it("shows a pending message while the model is running", () => {
    expect(renderToStaticMarkup(createElement(ModelReasoning, { reasoning: undefined, status: "running" }))).toContain("模型正在分析");
  });
});
