import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { locateRequests } from "@/lib/request-location";
vi.mock("@/lib/request-location", () => ({ locateRequests: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const request = (body: unknown) =>
  new Request("http://localhost/api/integrations/new-api/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
describe("request location route", () => {
  it("rejects missing scope confirmation, wildcards and invalid hints before searching", async () => {
    for (const body of [
      { username: "alice", question: "429" },
      { username: "%", scopeConfirmed: true, question: "429" },
      { username: "alice", scopeConfirmed: true, question: "429", hints: { channel: -1 } },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(locateRequests).not.toHaveBeenCalled();
  });
  it("returns structured failure distinctly from no matches and prevents caching", async () => {
    vi.mocked(locateRequests).mockResolvedValue({
      status: "failed",
      error: { kind: "permission", message: "权限不足" },
    } as Awaited<ReturnType<typeof locateRequests>>);
    const response = await POST(
      request({ username: "alice", scopeConfirmed: true, question: "429" }),
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { kind: "permission" },
    });
    expect(locateRequests).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice" }),
      expect.any(AbortSignal),
    );
  });
  it("does not claim no matches after an unexpected timeout", async () => {
    vi.mocked(locateRequests).mockRejectedValue(new Error("timeout"));
    const response = await POST(
      request({ username: "alice", scopeConfirmed: true, question: "429" }),
    );
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("不代表没有匹配"),
    });
  });
});
