import { z } from "zod";

export const traceSchema = z.object({
  customerQuestion: z.string().optional(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  upstreamRequestId: z.string().optional(),
  provider: z.string().optional(),
  route: z.string().optional(),
  model: z.string().optional(),
  statusCode: z.number().int().optional(),
  retryCount: z.number().int().optional(),
  retryReason: z.string().optional(),
  clientRequest: z.record(z.unknown()).optional(),
  transformedRequest: z.record(z.unknown()).optional(),
  upstreamResponse: z.record(z.unknown()).optional(),
  finalResponse: z.record(z.unknown()).optional(),
  logs: z.array(z.string()).optional(),
  sse: z.array(z.string()).optional(),
});

export const findingSchema = z.object({
  ruleId: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  faultLayer: z.enum(["client", "gateway", "adapter", "route", "provider", "upstream", "unknown"]),
  evidence: z.array(z.string()),
  conclusion: z.string(),
  needsMoreEvidence: z.boolean(),
});

const imageExtractionSchema = z.object({
  id: z.string().min(1),
  status: z.literal("completed"),
  error: z.string().optional(),
  fields: z.array(z.string()).optional(),
  observations: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        quote: z.string(),
        location: z.string().optional(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  model: z.string().optional(),
  version: z.string().optional(),
  fileHash: z.string().optional(),
  extractedAt: z.string().optional(),
});

export const diagnosisEvidenceSchema = z.object({
  traceInput: traceSchema,
  allFindings: z.array(findingSchema),
  successfulImages: z.array(imageExtractionSchema).max(5),
  imageIssues: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(["failed", "unreadable", "skipped"]),
        reason: z.string(),
      }),
    )
    .optional(),
  textEvidence: z
    .array(
      z.object({
        id: z.string().min(1),
        evidenceType: z.string(),
        content: z.string(),
        truncated: z.boolean(),
      }),
    )
    .max(5),
  knowledge: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      sourceUrl: z.string(),
      body: z.string(),
      excerpt: z.string().optional(),
    }),
  ),
});

export const ruleToolSchema = z.object({
  trace: traceSchema,
  images: z.array(imageExtractionSchema).max(5).optional().describe("提供时仅检查图片派生规则"),
  existingFindings: z
    .array(findingSchema)
    .optional()
    .describe("已有规则结果，用于排除图片规则重复项"),
});
