import type { Finding, Trace } from "./types";
export const ruleCatalog = [
  {
    id: "http-429",
    name: "HTTP 429 重试证据",
    description: "检查限流响应是否包含重试上下文。",
    severity: "medium",
  },
  {
    id: "http-5xx",
    name: "HTTP 5xx 上游边界",
    description: "区分上游异常与证据不足的网关错误。",
    severity: "high",
  },
  {
    id: "cancellation",
    name: "取消与超时",
    description: "识别提前断流、超时和客户端取消线索。",
    severity: "high",
  },
  {
    id: "anthropic-sse-lifecycle",
    name: "SSE 生命周期",
    description: "检查 content block start/stop 配对。",
    severity: "high",
  },
  {
    id: "anthropic-sse-index",
    name: "SSE 事件索引",
    description: "检查流式 content index 是否跳变。",
    severity: "medium",
  },
  {
    id: "protocol-diff",
    name: "请求转换差异",
    description: "检查客户端与转换后请求的关键字段差异。",
    severity: "medium",
  },
  {
    id: "bedrock-tool-compatibility",
    name: "Bedrock 工具兼容性",
    description: "识别 Bedrock 路由中的不兼容工具类型。",
    severity: "high",
  },
  {
    id: "tool-lifecycle",
    name: "工具调用生命周期",
    description: "检查 tool_result 是否缺少对应 tool_use。",
    severity: "high",
  },
  {
    id: "cache-evidence",
    name: "缓存证据",
    description: "提示缺少缓存命中或未命中判断所需证据。",
    severity: "low",
  },
] as const;
const f = (
  ruleId: string,
  severity: Finding["severity"],
  faultLayer: Finding["faultLayer"],
  conclusion: string,
  evidence: string[],
  needsMoreEvidence = false,
): Finding => ({ ruleId, severity, faultLayer, conclusion, evidence, needsMoreEvidence });
export function runRules(t: Trace): Finding[] {
  const out: Finding[] = [];
  const logs = (t.logs ?? []).join("\n");
  const sse = t.sse ?? [];
  if (t.statusCode === 429)
    out.push(
      f(
        "http-429",
        "medium",
        "provider",
        `观察到 HTTP 429；${t.retryCount === undefined ? "未见 retry_count，需补充重试证据" : `retry_count=${t.retryCount}${t.retryReason ? `，原因：${t.retryReason}` : ""}`}`,
        ["status_code=429"],
        t.retryCount === undefined,
      ),
    );
  if ((t.statusCode ?? 0) >= 500)
    out.push(
      f(
        "http-5xx",
        "high",
        t.upstreamResponse ? "upstream" : "unknown",
        t.upstreamResponse
          ? "已观察到上游响应异常。"
          : "观察到 5xx，但缺少上游响应，无法区分中转与上游。",
        [`status_code=${t.statusCode}`],
        !t.upstreamResponse,
      ),
    );
  if (/context canceled|client_gone|timeout|超时/i.test(logs))
    out.push(
      f(
        "cancellation",
        "high",
        "gateway",
        "日志含取消、客户端离开或超时线索，可能发生提前断流。",
        [
          logs.match(/.{0,30}(context canceled|client_gone|timeout|超时).{0,40}/i)?.[0] ??
            "日志线索",
        ],
        false,
      ),
    );
  const starts = new Set(
    sse
      .filter((x) => /content_block_start/.test(x))
      .map((x) => x.match(/index["=: ]+(\d+)/)?.[1] ?? "?"),
  );
  const stops = sse.filter((x) => /content_block_stop/.test(x));
  if (stops.some((x) => !starts.has(x.match(/index["=: ]+(\d+)/)?.[1] ?? "?")))
    out.push(
      f(
        "anthropic-sse-lifecycle",
        "high",
        "adapter",
        "SSE 中 content_block_stop 缺少对应 start。",
        stops,
        false,
      ),
    );
  const idx = sse.map((x) => Number(x.match(/index["=: ]+(\d+)/)?.[1])).filter(Number.isFinite);
  if (idx.some((n, i) => i > 0 && n > idx[i - 1] + 1))
    out.push(
      f("anthropic-sse-index", "medium", "adapter", "SSE content index 出现跳变。", sse, false),
    );
  if (t.statusCode === 200 && sse.some((x) => /event:\s*error|"error"/.test(x)))
    out.push(
      f(
        "sse-after-200",
        "high",
        "upstream",
        "HTTP 200 后仍出现 SSE error 事件。",
        sse.filter((x) => /error/.test(x)),
        false,
      ),
    );
  const a = t.clientRequest ?? {},
    b = t.transformedRequest ?? {};
  const keys = [
    "model",
    "system",
    "messages",
    "tools",
    "thinking",
    "temperature",
    "max_tokens",
    "headers",
    "cache_control",
  ];
  const diffs = keys.filter(
    (k) =>
      JSON.stringify(a[k]) !== JSON.stringify(b[k]) && (a[k] !== undefined || b[k] !== undefined),
  );
  if (diffs.length)
    out.push(
      f(
        "protocol-diff",
        "medium",
        "adapter",
        `客户端请求与转换后请求字段差异：${diffs.join("、")}。`,
        diffs,
        false,
      ),
    );
  if (
    (t.route ?? "").toLowerCase().includes("bedrock") &&
    JSON.stringify(a).includes("web_search_20250305") &&
    JSON.stringify(t.upstreamResponse ?? {}).includes("ValidationException")
  )
    out.push(
      f(
        "bedrock-tool-compatibility",
        "high",
        "adapter",
        "Bedrock 路由携带 web_search_20250305，且上游返回 ValidationException，工具能力不兼容。",
        ["route=bedrock", "web_search_20250305", "ValidationException"],
        false,
      ),
    );
  const events = JSON.stringify(a);
  if (events.includes("tool_result") && !events.includes("tool_use"))
    out.push(
      f(
        "tool-lifecycle",
        "high",
        "client",
        "存在 tool_result 但缺少 tool_use。",
        ["tool_result"],
        false,
      ),
    );
  if (
    !JSON.stringify(a).includes("cache") &&
    !JSON.stringify(t.upstreamResponse ?? {}).includes("cache")
  )
    out.push(
      f(
        "cache-evidence",
        "low",
        "unknown",
        "缓存证据不足，无法确认 cache miss。",
        ["未找到可比较请求、缓存字段或 usage"],
        true,
      ),
    );
  return out;
}
