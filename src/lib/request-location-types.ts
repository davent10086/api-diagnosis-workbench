import { z } from "zod";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\r\n%]/.test(value), "不能包含通配符或换行");
export const locationInputSchema = z
  .object({
    username: identifier.describe("经支持人员确认的客户账号，查询时不可放宽"),
    scopeConfirmed: z.literal(true),
    question: z.string().trim().max(10000),
    occurredAt: z.string().trim().max(100).optional(),
    timezoneOffsetMinutes: z.number().int().min(-720).max(840).default(480),
    hints: z
      .object({
        requestId: identifier.optional(),
        upstreamRequestId: identifier.optional(),
        model: identifier.optional(),
        channel: z.number().int().positive().optional(),
        keywords: z.array(z.string().trim().min(2).max(120)).max(6).optional(),
        isStream: z.boolean().optional(),
      })
      .default({}),
    confirmed: z
      .object({
        requestId: identifier.optional(),
        upstreamRequestId: identifier.optional(),
        model: identifier.optional(),
        channel: z.number().int().positive().optional(),
      })
      .default({}),
  })
  .strict();
export type LocationInput = z.infer<typeof locationInputSchema>;
export type Clue = {
  field: string;
  value: string;
  reliability: "confirmed" | "recalled";
  source: "operator" | "customer" | "model";
};
export type TimeWindow = { start: number; end: number; label: string };
export type SearchRound = TimeWindow & {
  page: number;
  fetched: number;
  total: number;
  complete: boolean;
};
export type LocatedCandidate = {
  tokenName?: string;
  requestId: string;
  upstreamRequestId: string;
  model: string;
  channel: number | null;
  occurredAt: string;
  timestamp: number | null;
  content: string;
  isStream: boolean | null;
  useTime: number | null;
  type: number | null;
  score: number;
  matches: string[];
  conflicts: string[];
  timeDifferenceMinutes: number | null;
  imported: {
    metadata: { requestId: string; upstreamRequestId: string; model: string; occurredAt: string };
    context: string;
  };
};
export type LocationResult = {
  status: "candidates" | "not_found" | "incomplete" | "failed" | "needs_clues";
  username: string;
  originalTime: string;
  interpretedTime: string | null;
  timezoneOffsetMinutes: number;
  clues: Clue[];
  rounds: SearchRound[];
  candidates: LocatedCandidate[];
  groups: { requestIds: string[]; reason: string }[];
  followUp: string;
  notices: string[];
  scanned: number;
  requests: number;
  stopReason: "completed" | "exact_id" | "budget" | "error" | "insufficient_clues";
  error?: { kind: string; message: string };
};
