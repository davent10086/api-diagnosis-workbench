import { z } from "zod";
import { redactTrace } from "./redaction";
import type { Trace } from "./types";

const shortText = z.string().max(10_000);
const traceSchema = z
  .object({
    customerQuestion: shortText.optional(),
    requestId: z.string().max(200).optional(),
    traceId: z.string().max(200).optional(),
    upstreamRequestId: z.string().max(200).optional(),
    provider: z.string().max(100).optional(),
    route: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    retryCount: z.number().int().min(0).max(100).optional(),
    retryReason: shortText.optional(),
    clientRequest: z.record(z.unknown()).optional(),
    transformedRequest: z.record(z.unknown()).optional(),
    upstreamResponse: z.record(z.unknown()).optional(),
    finalResponse: z.record(z.unknown()).optional(),
    logs: z.array(shortText).max(100).optional(),
    sse: z.array(shortText).max(1_000).optional(),
  })
  .refine((value) => JSON.stringify(value).length <= 512_000, "追踪数据过大。");

type WorkbenchInput = {
  question?: string;
  metadata: {
    provider: string;
    model: string;
    route: string;
    statusCode: string;
    requestId: string;
    upstreamRequestId: string;
    occurredAt: string;
  };
  advanced: { trace?: string; requestHeaders?: string; response?: string; sse?: string; context?: string };
};

function parseTrace(raw?: string): Trace {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("完整 Trace JSON 格式无效。");
  }
  const parsed = traceSchema.safeParse(value);
  if (!parsed.success) throw new Error("完整 Trace JSON 字段无效或超过限制。");
  return parsed.data;
}

function preferred(manual: string, fromTrace?: string) {
  return manual.trim() || fromTrace;
}

export function buildWorkbenchTrace(input: WorkbenchInput): Trace {
  const base = parseTrace(input.advanced.trace);
  const statusText = input.metadata.statusCode.trim();
  let manualStatusCode: number | undefined;
  if (statusText) {
    const parsedStatusCode = Number(statusText);
    if (
      !Number.isInteger(parsedStatusCode) ||
      parsedStatusCode < 100 ||
      parsedStatusCode > 599
    )
      throw new Error("状态码必须为 100–599 的整数。");
    manualStatusCode = parsedStatusCode;
  }
  const statusCode = manualStatusCode ?? base.statusCode;
  const logs = [
    ...(base.logs ?? []),
    input.metadata.occurredAt.trim() ? `occurred_at=${input.metadata.occurredAt.trim()}` : "",
    input.advanced.context?.trim() ?? "",
  ].filter(Boolean);
  return redactTrace({
    ...base,
    customerQuestion: preferred(input.question ?? "", base.customerQuestion),
    requestId: preferred(input.metadata.requestId, base.requestId),
    upstreamRequestId: preferred(input.metadata.upstreamRequestId, base.upstreamRequestId),
    provider: preferred(input.metadata.provider, base.provider),
    route: preferred(input.metadata.route, base.route),
    model: preferred(input.metadata.model, base.model),
    statusCode,
    clientRequest: input.advanced.requestHeaders?.trim()
      ? { ...(base.clientRequest ?? {}), raw_headers: input.advanced.requestHeaders.trim() }
      : base.clientRequest,
    upstreamResponse: input.advanced.response?.trim()
      ? { ...(base.upstreamResponse ?? {}), raw_response: input.advanced.response.trim() }
      : base.upstreamResponse,
    sse: input.advanced.sse?.trim() ? [...(base.sse ?? []), input.advanced.sse.trim()] : base.sse,
    logs: logs.length ? logs : undefined,
  });
}
