import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("new-api log bridge", () => {
  it("queries the exact request ID with server-side authentication", async () => {
    vi.stubEnv("NEW_API_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NEW_API_ACCESS_TOKEN", "test-private-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { total: 1, items: [{ request_id: "req-1", model_name: "model-a", content: "failed" }] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new NextRequest("http://127.0.0.1:3002/api/integrations/new-api/log?request_id=req-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ metadata: { requestId: "req-1", model: "model-a" } });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.searchParams.get("request_id")).toBe("req-1");
    expect(options.headers.Authorization).toBe("Bearer test-private-token");
    expect(options.redirect).toBe("error");
  });

  it("rejects a mismatched result", async () => {
    vi.stubEnv("NEW_API_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NEW_API_ACCESS_TOKEN", "test-private-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { total: 1, items: [{ request_id: "another-request" }] },
    }), { status: 200 })));
    const response = await GET(new NextRequest("http://127.0.0.1:3002/api/integrations/new-api/log?request_id=req-1"));
    expect(response.status).toBe(404);
  });
});
