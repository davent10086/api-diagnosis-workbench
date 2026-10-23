import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { z } from "zod";
import { logSchema, toWorkbenchLog } from "./new-api-log";
import { createRequestLogTool, LogSearchError } from "./request-log-tool";
import { extractLocationClues, parseCustomerTime, planTimeWindows } from "./request-location-clues";
import {
  locationInputSchema,
  type LocatedCandidate,
  type LocationInput,
  type LocationResult,
  type TimeWindow,
} from "./request-location-types";
import { assertNotAborted } from "./diagnosis-model";

type Log = z.infer<typeof logSchema>;
const MAX_REQUESTS = 6,
  MAX_ROWS = 500;

export function rankRequestCandidates(
  logs: Log[],
  input: LocationInput,
  timestamp: number | null,
): LocatedCandidate[] {
  const unique = new Map<string, Log>();
  for (const log of logs) {
    if (!log.request_id) continue;
    // One request can have multiple gateway log events. Keep each event's
    // content available when ranking, while deduplicating paginated overlap.
    unique.set(
      `${log.request_id}:${log.created_at}:${log.type}:${log.channel}:${log.content}`,
      log,
    );
  }
  const candidates = [...unique.values()].map((log): LocatedCandidate => {
    let score = 0;
    const matches: string[] = [],
      conflicts: string[] = [];
    const compare = (
      name: string,
      expected: string | number | boolean | undefined,
      actual: unknown,
      weight: number,
      partial = false,
    ) => {
      if (expected === undefined) return;
      if (actual === null || actual === undefined || actual === "") {
        conflicts.push(`${name}：日志未记录`);
        return;
      }
      const equal =
        typeof expected === "string"
          ? partial
            ? String(actual).toLowerCase().includes(expected.toLowerCase())
            : String(actual) === expected
          : expected === actual;
      if (equal) {
        score += weight;
        matches.push(`${name}匹配：${expected}`);
      } else {
        score -= Math.floor(weight / 2);
        conflicts.push(`${name}不一致：客户线索 ${expected}，日志 ${actual}`);
      }
    };
    compare("Request ID", input.confirmed.requestId ?? input.hints.requestId, log.request_id, 80);
    compare(
      "上游请求 ID",
      input.confirmed.upstreamRequestId ?? input.hints.upstreamRequestId,
      log.upstream_request_id,
      80,
    );
    compare(
      "模型",
      input.confirmed.model ?? input.hints.model,
      log.model_name,
      20,
      !input.confirmed.model,
    );
    compare("渠道", input.confirmed.channel ?? input.hints.channel, log.channel, 20);
    compare("流式请求", input.hints.isStream, log.is_stream, 10);
    const keywords = input.hints.keywords ?? [];
    for (const keyword of keywords) {
      if ((log.content ?? "").toLowerCase().includes(keyword.toLowerCase())) {
        score += 10;
        matches.push(`错误内容包含：${keyword}`);
      } else conflicts.push(`错误内容未匹配：${keyword}`);
    }
    const delta =
      timestamp !== null && log.created_at != null
        ? Math.round((log.created_at - timestamp) / 60)
        : null;
    if (delta !== null) {
      if (Math.abs(delta) <= 60) {
        score += 5;
        matches.push("接近客户提供的时间");
      } else conflicts.push(`与客户时间相差 ${delta} 分钟`);
    }
    return {
      requestId: log.request_id,
      tokenName: log.token_name ?? undefined,
      upstreamRequestId: log.upstream_request_id ?? "",
      model: log.model_name ?? "",
      channel: log.channel ?? null,
      timestamp: log.created_at ?? null,
      occurredAt: log.created_at != null ? new Date(log.created_at * 1000).toISOString() : "",
      content: log.content ?? "",
      isStream: log.is_stream ?? null,
      useTime: log.use_time ?? null,
      type: log.type ?? null,
      score,
      matches,
      conflicts,
      timeDifferenceMinutes: delta,
      imported: toWorkbenchLog(log),
    };
  });
  // Display one request once, favoring the event which best explains the clues.
  const byRequest = new Map<string, LocatedCandidate>();
  for (const candidate of candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
      a.requestId.localeCompare(b.requestId),
  )) {
    if (!byRequest.has(candidate.requestId)) byRequest.set(candidate.requestId, candidate);
  }
  return [...byRequest.values()].slice(0, 20);
}

export function groupRelatedRequests(candidates: LocatedCandidate[]): LocationResult["groups"] {
  const groups: LocationResult["groups"] = [];
  const used = new Set<string>();
  const ordered = [...candidates].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const anchor of ordered) {
    if (anchor.timestamp === null || used.has(anchor.requestId)) continue;
    const related = ordered.filter(
      (item) =>
        item.timestamp !== null &&
        !used.has(item.requestId) &&
        item.timestamp - anchor.timestamp! >= 0 &&
        item.timestamp - anchor.timestamp! <= 600 &&
        ((anchor.upstreamRequestId && item.upstreamRequestId === anchor.upstreamRequestId) ||
          (item.timestamp - anchor.timestamp! <= 90 &&
            anchor.tokenName &&
            item.tokenName === anchor.tokenName &&
            anchor.content.trim() &&
            item.content.trim() === anchor.content.trim()) ||
          (item.timestamp - anchor.timestamp! <= 90 &&
            anchor.model &&
            anchor.channel !== null &&
            item.model === anchor.model &&
            item.channel === anchor.channel)),
    );
    if (related.length > 1) {
      related.forEach((item) => used.add(item.requestId));
      groups.push({
        requestIds: related.map((item) => item.requestId),
        reason:
          "时间接近，且模型与渠道相同、共享上游请求标识，或令牌名称与错误原文相同；可能属于同一轮尝试，需人工确认，不能据此认定为重试。",
      });
    }
  }
  return groups;
}

export function chooseFollowUp(candidates: LocatedCandidate[]): string {
  if (!candidates.length)
    return "请提供一条原始 Request ID、上游请求 ID，或补充可核对的模型、错误原文与大致日期。";
  if (candidates.length === 1)
    return "请核对该请求的实际时间、模型和错误内容，确认是否为客户反馈的请求；请求确认不等于根因确认。";
  const top = candidates.slice(0, 5);
  if (new Set(top.map((item) => item.model)).size > 1)
    return `这些候选的模型不同。当时使用的是哪个模型？候选包括：${[...new Set(top.map((item) => item.model || "未记录"))].join("、")}。`;
  if (new Set(top.map((item) => item.channel)).size > 1)
    return "候选分布在不同渠道。能否提供当时的渠道名称或渠道编号？";
  if (new Set(top.map((item) => item.isStream)).size > 1)
    return "这些候选的流式设置不同。当时是否开启了 stream？";
  return "多个请求特征相近。请从客户端或原始日志复制一条 Request ID，或补充实际响应的错误原文，以区分这些请求。";
}

const State = Annotation.Root({
  input: Annotation<LocationInput>(),
  windows: Annotation<TimeWindow[]>(),
  windowIndex: Annotation<number>(),
  page: Annotation<number>(),
  logs: Annotation<Log[]>(),
  timestamp: Annotation<number | null>(),
  result: Annotation<LocationResult>(),
});

export async function locateRequests(
  rawInput: unknown,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<LocationResult> {
  const validated = locationInputSchema.parse(rawInput);
  const time = parseCustomerTime(validated, now);
  const initial: LocationResult = {
    status: "not_found",
    username: validated.username,
    originalTime: time.original,
    interpretedTime: time.timestamp !== null ? new Date(time.timestamp * 1000).toISOString() : null,
    timezoneOffsetMinutes: validated.timezoneOffsetMinutes,
    clues: [],
    rounds: [],
    candidates: [],
    groups: [],
    followUp: "",
    notices: [
      "时间来自客户回忆，可放宽；客户账号和已确认条件始终固定。",
      "查询结果受日志保留期限与记录完整度影响；无匹配不能证明客户时间错误。",
    ],
    scanned: 0,
    requests: 0,
    stopReason: "completed",
  };
  const searchTool = createRequestLogTool({
    username: validated.username,
    confirmed: validated.confirmed,
  });
  const graph = new StateGraph(State)
    .addNode("plan", async () => {
      assertNotAborted(signal);
      const extracted = await extractLocationClues(validated, signal);
      if (time.original)
        extracted.clues.push({
          field: "occurredAt",
          value: time.original,
          reliability: "recalled",
          source: validated.occurredAt ? "operator" : "customer",
        });
      extracted.clues.push({
        field: "timezoneOffsetMinutes",
        value: String(validated.timezoneOffsetMinutes),
        reliability: "recalled",
        source: "operator",
      });
      const input = { ...validated, hints: extracted.hints };
      const windows = planTimeWindows(time, input, now);
      const meaningful =
        time.timestamp !== null ||
        Object.values(input.confirmed).some((value) => value !== undefined) ||
        Object.values(input.hints).some((value) =>
          Array.isArray(value) ? value.length > 0 : value !== undefined,
        );
      const result = {
        ...initial,
        clues: extracted.clues,
        notices: [...initial.notices, ...extracted.notices],
        status: meaningful && windows.length ? ("not_found" as const) : ("needs_clues" as const),
        stopReason:
          meaningful && windows.length ? ("completed" as const) : ("insufficient_clues" as const),
      };
      if (
        time.timestamp === null &&
        !input.confirmed.requestId &&
        !input.confirmed.upstreamRequestId
      )
        result.notices.push("时间无法可靠解析，若继续检索将限定在最近七天；请补充日期或时区。");
      if (time.timestamp !== null && time.timestamp > now / 1000)
        result.notices.push("客户时间晚于当前时间，将只检索已经发生的时间范围。");
      if (time.timestamp !== null && time.dayOnly)
        result.notices.push(
          "客户仅提供了日期或大致时段；解释后的时间是检索窗口的参考点，不代表准确发生时间。",
        );
      result.followUp = chooseFollowUp([]);
      return {
        input,
        windows,
        windowIndex: 0,
        page: 1,
        logs: [],
        timestamp: time.timestamp,
        result,
      };
    })
    .addNode("search", async (state) => {
      assertNotAborted(signal);
      const { input, windows, windowIndex, page } = state;
      const window = windows[windowIndex];
      const remaining = MAX_ROWS - state.result.scanned;
      const exact = Boolean(input.confirmed.requestId || input.confirmed.upstreamRequestId);
      try {
        const response = await searchTool.invoke(
          {
            start: exact ? undefined : window.start,
            end: exact ? undefined : window.end,
            page,
            pageSize: 100,
          },
          { signal },
        );
        const items = response.items.slice(0, Math.min(100, remaining));
        const complete = page * 100 >= response.total;
        const requests = state.result.requests + 1,
          scanned = state.result.scanned + items.length;
        const nextWindow = complete ? windowIndex + 1 : windowIndex;
        const exhausted =
          (requests >= MAX_REQUESTS || scanned >= MAX_ROWS) &&
          (nextWindow < windows.length || !complete);
        const stopReason =
          exact && items.length
            ? ("exact_id" as const)
            : exhausted
              ? ("budget" as const)
              : ("completed" as const);
        const result = {
          ...state.result,
          requests,
          scanned,
          stopReason,
          rounds: [
            ...state.result.rounds,
            { ...window, page, fetched: items.length, total: response.total, complete },
          ],
        };
        return {
          logs: [...state.logs, ...items],
          windowIndex: nextWindow,
          page: complete ? 1 : page + 1,
          result,
        };
      } catch (error) {
        assertNotAborted(signal);
        const result: LocationResult = {
          ...state.result,
          requests: state.result.requests + 1,
          status: state.logs.length ? "incomplete" : "failed",
          stopReason: "error",
          error:
            error instanceof LogSearchError
              ? { kind: error.kind, message: error.message }
              : { kind: "upstream", message: "日志查询失败，已停止扩展时间范围。" },
        };
        return { result };
      }
    })
    .addNode("rank", (state) => {
      const candidates = rankRequestCandidates(state.logs, state.input, state.timestamp);
      const partial = state.result.stopReason === "budget" || state.result.stopReason === "error";
      const status = partial
        ? candidates.length || state.result.stopReason === "budget"
          ? "incomplete"
          : "failed"
        : candidates.length
          ? "candidates"
          : "not_found";
      const result: LocationResult = {
        ...state.result,
        candidates,
        status,
        groups: groupRelatedRequests(candidates),
        followUp: chooseFollowUp(candidates),
      };
      if (
        state.result.stopReason === "budget" &&
        !result.notices.includes("已达到最多六次查询或五百条扫描上限；候选排序只覆盖已读取的日志。")
      )
        result.notices.push("已达到最多六次查询或五百条扫描上限；候选排序只覆盖已读取的日志。");
      return { result };
    })
    .addEdge(START, "plan")
    .addConditionalEdges("plan", (state) =>
      state.result.status === "needs_clues" ? END : "search",
    )
    .addEdge("search", "rank")
    .addConditionalEdges("rank", (state) =>
      state.result.stopReason !== "completed" || state.windowIndex >= state.windows.length
        ? END
        : "search",
    )
    .compile();
  const output = await graph.invoke(
    {},
    { signal, recursionLimit: 18, runName: "locate_customer_request" },
  );
  return output.result;
}
