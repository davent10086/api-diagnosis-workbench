import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logPageSchema } from "./new-api-log";
import { redact } from "./redaction";
import { locationInputSchema } from "./request-location-types";

export class LogSearchError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
  }
}

// Scope and confirmed identifiers are bound by the server before the tool is
// exposed. A planner can select time windows, never remove the customer filter.
export function createRequestLogTool(scope: {
  username: string;
  confirmed: { requestId?: string; upstreamRequestId?: string; model?: string; channel?: number };
}) {
  const bound = {
    username: locationInputSchema.shape.username.parse(scope.username),
    ...locationInputSchema.shape.confirmed.parse(scope.confirmed),
  };
  return tool(
    async ({ start, end, page, pageSize }, config) => {
      const base = process.env.NEW_API_BASE_URL?.trim();
      const token = process.env.NEW_API_ACCESS_TOKEN?.trim();
      if (!base || !token)
        throw new LogSearchError("configuration", "请先配置 new-api 地址和日志访问令牌。");
      let url: URL;
      try {
        url = new URL("/api/log/", base);
        if (!/^https?:$/.test(url.protocol)) throw new Error();
      } catch {
        throw new LogSearchError("configuration", "new-api 地址无效。");
      }
      url.searchParams.set("username", bound.username);
      for (const [name, value] of Object.entries({
        request_id: bound.requestId,
        upstream_request_id: bound.upstreamRequestId,
        model_name: bound.model,
        channel: bound.channel,
      })) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
      if (start !== undefined) url.searchParams.set("start_timestamp", String(start));
      if (end !== undefined) url.searchParams.set("end_timestamp", String(end));
      url.searchParams.set("p", String(page));
      url.searchParams.set("page_size", String(pageSize));
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          redirect: "error",
          signal: config.signal
            ? AbortSignal.any([config.signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
        });
      } catch (error) {
        if (config.signal?.aborted) throw error;
        throw new LogSearchError(
          error instanceof Error && /timeout|abort/i.test(error.name) ? "timeout" : "connection",
          "日志查询超时或连接失败，本次检索尚未完成。",
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new LogSearchError("permission", "日志访问令牌无效或权限不足。");
      if (response.status === 429)
        throw new LogSearchError("rate_limit", "日志接口限流，本次检索尚未完成。");
      if (!response.ok)
        throw new LogSearchError("upstream", "new-api 日志接口返回错误，本次检索尚未完成。");
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === "object" && "success" in body && body.success === false)
        throw new LogSearchError(
          "query_rejected",
          "日志接口拒绝查询，可能受时间范围或接口策略限制；已停止扩大范围。",
        );
      const parsed = logPageSchema.safeParse(body);
      if (!parsed.success)
        throw new LogSearchError("format", "日志响应格式无效或查询被拒绝，本次检索尚未完成。");
      if (parsed.data.data.total < 0 || parsed.data.data.items.length > pageSize)
        throw new LogSearchError("format", "日志接口返回了无效的分页数据，已停止查询。");
      const items = parsed.data.data.items;
      if (items.some((item) => item.username !== bound.username))
        throw new LogSearchError("scope", "日志接口未返回指定客户范围内的记录，已停止查询。");
      if (
        (start !== undefined || end !== undefined) &&
        items.some(
          (item) =>
            item.created_at == null ||
            (start !== undefined && item.created_at < start) ||
            (end !== undefined && item.created_at > end),
        )
      )
        throw new LogSearchError("scope", "日志接口未返回指定时间范围内的可核对记录，已停止查询。");
      if (
        items.some(
          (item) =>
            (bound.requestId && item.request_id !== bound.requestId) ||
            (bound.upstreamRequestId && item.upstream_request_id !== bound.upstreamRequestId) ||
            (bound.model && item.model_name !== bound.model) ||
            (bound.channel && item.channel !== bound.channel),
        )
      )
        throw new LogSearchError("scope", "日志接口未遵守已确认的筛选条件，已停止查询。");
      return {
        items: items.map((item) => ({
          ...item,
          content: redact(item.content ?? "").slice(0, 6000),
        })),
        total: parsed.data.data.total,
      };
    },
    {
      name: "search_request_logs",
      description:
        "在服务端绑定的客户账号与已确认条件内分页查询 new-api 日志；时间为 Unix 秒。返回日志及总条数，查询失败抛出错误，不等同于没有匹配。",
      schema: z
        .object({
          start: z.number().int().nonnegative().optional(),
          end: z.number().int().nonnegative().optional(),
          page: z.number().int().min(1).max(6),
          pageSize: z.number().int().min(1).max(100),
        })
        .strict()
        .refine(
          (value) =>
            value.start === undefined || value.end === undefined || value.start <= value.end,
          "起始时间不能晚于结束时间",
        ),
    },
  );
}
