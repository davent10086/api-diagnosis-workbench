import { z } from "zod";
import { redact } from "./redaction";

const logSchema = z.object({
  request_id: z.string(),
  upstream_request_id: z.string().optional().nullable(),
  model_name: z.string().optional().nullable(),
  created_at: z.number().int().optional().nullable(),
  type: z.number().int().optional().nullable(),
  channel: z.number().int().optional().nullable(),
  channel_name: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  is_stream: z.boolean().optional().nullable(),
  use_time: z.number().int().optional().nullable(),
});

export const logPageSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(logSchema), total: z.number().int() }),
});

export function toWorkbenchLog(log: z.infer<typeof logSchema>) {
  const lines = [
    `new-api request_id=${log.request_id}`,
    log.type === 5 ? "log_type=error" : log.type === 2 ? "log_type=consume" : `log_type=${log.type ?? "unknown"}`,
    log.channel ? `channel_id=${log.channel}` : "",
    log.channel_name ? `channel_name=${redact(log.channel_name)}` : "",
    log.is_stream === null || log.is_stream === undefined ? "" : `is_stream=${log.is_stream}`,
    log.use_time === null || log.use_time === undefined ? "" : `use_time=${log.use_time}s`,
    log.content ? `content=${redact(log.content).slice(0, 6000)}` : "",
  ].filter(Boolean);
  return {
    metadata: {
      model: log.model_name ?? "",
      requestId: log.request_id,
      upstreamRequestId: log.upstream_request_id ?? "",
      occurredAt: log.created_at ? new Date(log.created_at * 1000).toISOString() : "",
    },
    context: lines.join("\n").slice(0, 8000),
  };
}
