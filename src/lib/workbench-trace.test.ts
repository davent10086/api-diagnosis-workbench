import { describe, expect, it } from "vitest";
import { buildWorkbenchTrace } from "./workbench-trace";

const metadata = {
  provider: "",
  model: "",
  route: "",
  statusCode: "",
  requestId: "",
  upstreamRequestId: "",
  occurredAt: "",
};

describe("buildWorkbenchTrace", () => {
  it("keeps the structured trace and lets explicit metadata override it", () => {
    const trace = buildWorkbenchTrace({
      question: "客户超时",
      metadata: { ...metadata, provider: "anthropic", statusCode: "502", occurredAt: "2026-09-20" },
      advanced: {
        trace: JSON.stringify({ provider: "old", clientRequest: { Authorization: "Bearer secret" }, logs: ["timeout"] }),
        requestHeaders: "x-request-id: abc",
        response: "upstream timeout",
        sse: "event: error",
        context: "gateway timeout",
      },
    });
    expect(trace.provider).toBe("anthropic");
    expect(trace.statusCode).toBe(502);
    expect(trace.clientRequest).toMatchObject({ Authorization: "[已遮蔽]", raw_headers: "x-request-id: abc" });
    expect(trace.logs).toContain("gateway timeout");
    expect(trace.sse).toContain("event: error");
  });

  it("rejects malformed traces and invalid manual status codes", () => {
    expect(() => buildWorkbenchTrace({ question: "", metadata, advanced: { trace: "{" } })).toThrow("Trace JSON");
    expect(() => buildWorkbenchTrace({ question: "", metadata: { ...metadata, statusCode: "99" }, advanced: {} })).toThrow("100–599");
  });
});
