import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locationInputSchema, type LocationInput } from "./request-location-types";
import { parseCustomerTime, planTimeWindows, extractLocationClues } from "./request-location-clues";
import { createRequestLogTool } from "./request-log-tool";
import {
  locateRequests,
  rankRequestCandidates,
  groupRelatedRequests,
  chooseFollowUp,
} from "./request-location";
import { openAICompatibleCompletion } from "./diagnosis-model";
import { buildLocationImport } from "./request-location-review";

vi.mock("./diagnosis-model", async (original) => ({
  ...(await original<typeof import("./diagnosis-model")>()),
  openAICompatibleCompletion: vi.fn(),
}));
const now = Date.parse("2026-10-23T12:00:00Z");
const input = (overrides: Partial<LocationInput> = {}): LocationInput =>
  locationInputSchema.parse({
    username: "alice",
    scopeConfirmed: true,
    question: "claude 返回 429",
    occurredAt: "2026-10-22 18:30",
    ...overrides,
  });
const log = (overrides: Record<string, unknown> = {}) => ({
  request_id: "req-a",
  username: "alice",
  model_name: "claude-sonnet",
  created_at: Date.parse("2026-10-22T10:30:00Z") / 1000,
  channel: 2,
  type: 5,
  content: "HTTP 429",
  is_stream: true,
  ...overrides,
});
function page(items: ReturnType<typeof log>[] = [], total = items.length) {
  return Response.json({ success: true, data: { items, total } });
}
beforeEach(() => {
  vi.stubEnv("DASHSCOPE_API_KEY", "");
  vi.stubEnv("NEW_API_BASE_URL", "http://127.0.0.1:3000");
  vi.stubEnv("NEW_API_ACCESS_TOKEN", "test-private-token");
  vi.mocked(openAICompatibleCompletion).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps mixed historical pages queryable without inventing IDs for legacy rows", async () => {
  const { request_id: omittedId, ...legacy } = log();
  expect(omittedId).toBe("req-a");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    success: true, data: { items: [legacy, log()], total: 2 },
  })));
  const response = await createRequestLogTool({ username: "alice", confirmed: {} })
    .invoke({ page: 1, pageSize: 100 });
  expect(response.items).toHaveLength(2);
  expect(response.items[0].request_id).toBe("");
  const candidates = rankRequestCandidates(response.items, input(), null);
  expect(candidates.map((candidate) => candidate.requestId)).toEqual(["req-a"]);
});

describe("customer time hypotheses", () => {
  it("interprets local time with the selected offset and honors an explicit ISO timezone", () => {
    expect(parseCustomerTime(input(), now).timestamp).toBe(
      Date.parse("2026-10-22T10:30:00Z") / 1000,
    );
    expect(parseCustomerTime(input({ occurredAt: "2026-10-22T18:30:00Z" }), now).timestamp).toBe(
      Date.parse("2026-10-22T18:30:00Z") / 1000,
    );
  });
  it("anchors relative dates in the customer's timezone rather than the host timezone", () => {
    const time = parseCustomerTime(
      input({ occurredAt: "", question: "昨天下午3点返回429" }),
      Date.parse("2026-10-23T01:00:00Z"),
    );
    expect(time.timestamp).toBe(Date.parse("2026-10-22T07:00:00Z") / 1000);
    expect(time.original).toContain("昨天下午");
  });
  it("rejects impossible dates and hours instead of rolling them into another date", () => {
    expect(parseCustomerTime(input({ occurredAt: "2026-02-30 18:00" }), now).timestamp).toBeNull();
    expect(parseCustomerTime(input({ occurredAt: "2026-10-22 25:00" }), now).timestamp).toBeNull();
  });
  it("plans bounded, distinct timezone, AM/PM and adjacent-date hypotheses without querying the future", () => {
    const i = input();
    const windows = planTimeWindows(parseCustomerTime(i, now), i, now);
    expect(windows).toHaveLength(6);
    expect(windows.map((item) => item.label).join(" ")).toMatch(/UTC.*上午.*提前一天.*推后一天/);
    expect(windows.every((item) => item.end <= now / 1000 && item.start <= item.end)).toBe(true);
    const recent = planTimeWindows(
      parseCustomerTime(input({ occurredAt: "未知" }), now),
      input({ occurredAt: "未知" }),
      now,
    );
    expect(recent).toHaveLength(3);
  });
  it("uses an exact copied ID independently of an incorrect date", () => {
    const i = input({ confirmed: { requestId: "req-a" }, occurredAt: "2040-01-01 10:00" });
    expect(planTimeWindows(parseCustomerTime(i, now), i, now)).toEqual([
      { start: 0, end: now / 1000, label: expect.stringContaining("不限制时间") },
    ]);
  });
});

describe("feature extraction and ranking", () => {
  it("works without an AI key and keeps original customer clues soft", async () => {
    const extracted = await extractLocationClues(input());
    expect(extracted.hints).toMatchObject({ model: "claude", keywords: ["429"] });
    expect(extracted.clues.find((item) => item.field === "username")?.reliability).toBe(
      "confirmed",
    );
    expect(extracted.clues.find((item) => item.field === "model")?.reliability).toBe("recalled");
    expect(openAICompatibleCompletion).not.toHaveBeenCalled();
  });
  it("rejects invented model hints and never lets extraction replace the customer scope", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-model-key");
    vi.mocked(openAICompatibleCompletion).mockResolvedValue(
      JSON.stringify({
        username: "mallory",
        model: "invented-model",
        requestId: "invented-id",
        keywords: ["429", "not-in-question"],
      }),
    );
    const extracted = await extractLocationClues(input());
    expect(extracted.hints.model).toBe("claude");
    expect(extracted.hints.requestId).toBeUndefined();
    expect(extracted.hints.keywords).toEqual(["429"]);
    expect(extracted.clues.find((item) => item.field === "username")?.value).toBe("alice");
  });
  it("falls back after extraction failure but propagates cancellation", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-model-key");
    vi.mocked(openAICompatibleCompletion).mockRejectedValue(new Error("model unavailable"));
    expect((await extractLocationClues(input())).notices).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(extractLocationClues(input(), controller.signal)).rejects.toThrow();
  });
  it("keeps an upstream request ID separate from the gateway request ID", async () => {
    const extracted = await extractLocationClues(
      input({ question: "上游请求ID: upstream-abc，request_id: gateway-xyz" }),
    );
    expect(extracted.hints.upstreamRequestId).toBe("upstream-abc");
    expect(extracted.hints.requestId).toBe("gateway-xyz");
  });
  it("ranks feature agreement above time proximity, deduplicates overlap and explains time conflicts", () => {
    const i = input({ hints: { model: "claude", keywords: ["429"] } });
    const target = log({
      request_id: "real",
      created_at: Date.parse("2026-10-22T22:30:00Z") / 1000,
    });
    const wrong = log({ request_id: "other", model_name: "gpt-test", content: "unrelated" });
    const candidates = rankRequestCandidates(
      [wrong, target, target],
      i,
      parseCustomerTime(i, now).timestamp,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0].requestId).toBe("real");
    expect(candidates[0].timeDifferenceMinutes).toBe(720);
    expect(candidates[0].matches).toContain("错误内容包含：429");
    expect(candidates[0].conflicts.join(" ")).toContain("720");
  });
  it("groups related attempts while never inventing retry counts or treating consumption as success", () => {
    const logs = [
      log({ request_id: "a" }),
      log({ request_id: "b", created_at: Number(log().created_at) + 40, type: 2 }),
      log({ request_id: "c", model_name: "gpt-test", created_at: Number(log().created_at) + 50 }),
    ];
    const candidates = rankRequestCandidates(logs, input(), null);
    expect(groupRelatedRequests(candidates)).toEqual([
      { requestIds: ["a", "b"], reason: expect.stringContaining("不能据此认定为重试") },
    ]);
    expect(chooseFollowUp(candidates)).toContain("哪个模型");
    expect(chooseFollowUp(candidates.slice(0, 1))).toContain("不等于根因确认");
  });
});

describe("scoped request log tool", () => {
  it("binds credentials and confirmed scope on the server and redacts returned logs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(page([log({ content: "Authorization: Bearer secret-private" })]));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createRequestLogTool({
      username: "alice",
      confirmed: { model: "claude-sonnet", channel: 2 },
    });
    const result = await tool.invoke({ page: 1, pageSize: 100 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.searchParams.get("username")).toBe("alice");
    expect(url.searchParams.get("model_name")).toBe("claude-sonnet");
    expect(options.headers.Authorization).toBe("Bearer test-private-token");
    expect(options.redirect).toBe("error");
    expect(result.items[0].content).not.toContain("secret-private");
    await expect(
      tool.invoke({ page: 1, pageSize: 100, username: "mallory" } as never),
    ).rejects.toThrow();
    expect(() => createRequestLogTool({ username: "%", confirmed: {} })).toThrow();
  });
  it("stops on foreign customer results instead of displaying them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(page([log({ username: "mallory", content: "private content" })])),
    );
    await expect(
      createRequestLogTool({ username: "alice", confirmed: {} }).invoke({ page: 1, pageSize: 100 }),
    ).rejects.toThrow("客户范围");
  });
  it("rejects ignored confirmed filters and out-of-window timestamps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => page([log()])),
    );
    await expect(
      createRequestLogTool({ username: "alice", confirmed: { requestId: "different" } }).invoke({
        page: 1,
        pageSize: 100,
      }),
    ).rejects.toThrow("已确认");
    await expect(
      createRequestLogTool({ username: "alice", confirmed: {} }).invoke({
        start: 1,
        end: 2,
        page: 1,
        pageSize: 100,
      }),
    ).rejects.toThrow("时间范围");
  });
});

describe("request location graph", () => {
  it("finds an AM/PM-mismatched request using stable features and reports the actual offset", async () => {
    const target = log({ created_at: Date.parse("2026-10-21T22:30:00Z") / 1000 });
    const fetchMock = vi.fn().mockImplementation(async (url: URL) => {
      const start = Number(url.searchParams.get("start_timestamp")),
        end = Number(url.searchParams.get("end_timestamp"));
      return page(
        Number(target.created_at) >= start && Number(target.created_at) <= end ? [target] : [],
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(input(), undefined, now);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].timeDifferenceMinutes).toBe(-720);
    expect(result.candidates[0].matches).toContain("模型匹配：claude");
    expect(result.clues.find((clue) => clue.field === "model")?.reliability).toBe("recalled");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(
      fetchMock.mock.calls.every(([url]) => url.searchParams.get("username") === "alice"),
    ).toBe(true);
    expect(result.status).toBe("candidates");
    const imported = buildLocationImport(
      {
        ...result.candidates[0],
        imported: { ...result.candidates[0].imported, context: "x".repeat(12000) },
      },
      result,
    );
    expect(imported.context.length).toBeLessThanOrEqual(10000);
    expect(JSON.parse(imported.context.split("request_location_review=")[1])).toMatchObject({
      locationStatus: "human_confirmed",
      rootCauseConfirmed: false,
      originalTime: input().occurredAt,
    });
    expect(() =>
      buildLocationImport(result.candidates[0], {
        ...result,
        clues: [
          {
            field: "oversize",
            value: "x".repeat(10000),
            source: "customer",
            reliability: "recalled",
          },
        ],
      }),
    ).toThrow("定位依据过长");
  });
  it("does not send a wrong timestamp when an exact request ID is confirmed", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page([log()]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(
      input({ confirmed: { requestId: "req-a" }, occurredAt: "2030-01-01" }),
      undefined,
      now,
    );
    expect(result.stopReason).toBe("exact_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url.searchParams.has("start_timestamp")).toBe(false);
    expect(url.searchParams.get("request_id")).toBe("req-a");
  });
  it.each([
    [403, "permission"],
    [429, "rate_limit"],
    [500, "upstream"],
  ])(
    "distinguishes HTTP %s failures from an empty result and does not expand time",
    async (status, kind) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("error", { status: Number(status) }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await locateRequests(input(), undefined, now);
      expect(result.status).toBe("failed");
      expect(result.error?.kind).toBe(kind);
      expect(result.stopReason).toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("marks pagination truncation as incomplete and obeys fixed page size and row budget", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: URL) => {
      const p = Number(url.searchParams.get("p"));
      return page(
        Array.from({ length: 100 }, (_, index) => log({ request_id: `req-${p}-${index}` })),
        1000,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(input(), undefined, now);
    expect(result.status).toBe("incomplete");
    expect(result.stopReason).toBe("budget");
    expect(result.scanned).toBe(500);
    expect(result.requests).toBe(5);
    expect(fetchMock.mock.calls.every(([url]) => url.searchParams.get("page_size") === "100")).toBe(
      true,
    );
    expect(result.rounds.every((round) => !round.complete)).toBe(true);
  });
  it("retains partial candidates when a later query fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([log()]))
      .mockResolvedValueOnce(new Response("error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(input(), undefined, now);
    expect(result.status).toBe("incomplete");
    expect(result.candidates).toHaveLength(1);
    expect(result.error?.kind).toBe("upstream");
  });
  it("asks for more useful clues instead of scanning an account without evidence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(
      input({ occurredAt: "", question: "有问题" }),
      undefined,
      now,
    );
    expect(result.status).toBe("needs_clues");
    expect(result.followUp).toContain("Request ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not turn cancellation into a no-match result", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(locateRequests(input(), controller.signal, now)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports no matches only after completing all planned windows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => page()),
    );
    const result = await locateRequests(input(), undefined, now);
    expect(result.status).toBe("not_found");
    expect(result.rounds).toHaveLength(6);
    expect(result.rounds.every((round) => round.complete)).toBe(true);
  });
  it("treats a backend query rejection as a failure rather than an empty interval", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ success: false, message: "range rejected" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateRequests(input(), undefined, now);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("query_rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
