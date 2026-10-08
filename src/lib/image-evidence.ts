import { z } from "zod";
import { runRules } from "./rules";
import type { Finding, Trace } from "./types";

export const IMAGE_EXTRACTION_VERSION = "4";
export const MAX_MODEL_IMAGES = 5;
export type ImageObservation = { name: string; value: string; quote: string; location?: string };
export type ImageExtraction = {
  status: "completed" | "failed" | "unreadable";
  error?: string;
  fields?: string[];
  observations?: ImageObservation[];
  summary?: string;
  warnings?: string[];
  model?: string;
  version?: string;
  fileHash?: string;
  extractedAt?: string;
};
export type ImageIssue = { id: string; status: "failed" | "unreadable" | "skipped"; reason: string };

const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const observation = z.object({
  name: z.string().trim().min(1).max(80), value: scalar,
  quote: z.string().trim().max(1000).nullable().optional().transform((value) => value ?? ""), location: z.string().trim().max(200).nullable().optional().transform((value) => value ?? undefined), readable: z.boolean().optional(),
});
const responseSchema = z.object({
  summary: z.string().trim().max(3000),
  fields: z.union([
    z.array(z.union([z.string().max(500), observation])).max(100),
    z.record(z.union([scalar, z.array(scalar).max(30)])).refine((value) => Object.keys(value).length <= 100),
  ]),
  unreadable_regions: z.array(z.string().max(200)).max(30).optional(),
});

export function parseImageExtraction(content: string): ImageExtraction {
  const parsed = responseSchema.parse(JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
  const fields: string[] = [];
  const observations: ImageObservation[] = [];
  const warnings = [...(parsed.unreadable_regions ?? [])];
  if (Array.isArray(parsed.fields)) {
    for (const item of parsed.fields) {
      if (typeof item === "string") {
        if (item.trim()) fields.push(item.trim());
      } else if (item.readable === false || item.value === null || !String(item.value).trim() || !item.quote) {
        warnings.push(`${item.name}：无法从图片核实，请人工查看原图。`);
      } else {
        const value = String(item.value);
        observations.push({ name: item.name, value, quote: item.quote, location: item.location });
        fields.push(`${item.name}=${value}`);
      }
    }
  } else {
    for (const [key, value] of Object.entries(parsed.fields)) {
      if (value !== null) {
        const text = Array.isArray(value) ? value.filter((v) => v !== null).join("；") : String(value);
        if (text.trim()) fields.push(`${key}=${text}`);
      }
    }
  }
  if (!fields.length) return { status: "unreadable", summary: parsed.summary, fields: [], observations: [], warnings, error: "图片未提取到可核对的字段，请补充清晰截图或原始日志。" };
  if (!observations.length) warnings.push("提取结果未提供逐字段原文位置，需结合原图复核。");
  if (fields.some((field) => /request[_\s-]*id|请求\s*ID/i.test(field))) warnings.push("截图中的请求 ID 可能含 0/O、1/l、5/S 等相似字符，请从原始日志复制核对后再查询。");
  return { status: "completed", summary: parsed.summary, fields, observations, warnings };
}

export function imageRuleFindings(trace: Trace, images: ({ id: string } & ImageExtraction)[], existing: Finding[]): Finding[] {
  const originalIds = new Set(existing.map((item) => item.ruleId));
  return images.flatMap((image) => {
    const fields = image.fields ?? [];
    const status = fields.map((field) => /^(?:http(?:[_\s-]*status(?:[_\s-]*code)?)?|status[_\s-]*code|HTTP状态码|状态码)\s*[:=：]\s*([1-5]\d{2})\b/i.exec(field)?.[1]).find(Boolean);
    const errorFields = fields.filter((field) => /Exception|Error|context_length_exceeded|unsupported_parameter/i.test(field));
    const candidateTrace: Trace = {
      ...trace, statusCode: status ? Number(status) : trace.statusCode,
      logs: [...(trace.logs ?? []), ...fields],
      ...(errorFields.length && !trace.upstreamResponse ? { upstreamResponse: { image_error: errorFields.join("\n") } } : {}),
    };
    return runRules(candidateTrace).filter((finding) => !originalIds.has(finding.ruleId) && !(finding.ruleId === "cache-evidence" && fields.some((field) => /缓存读取|缓存写入|cache_(?:read|write|creation)_/i.test(field)))).map((finding) => ({
      ...finding, ruleId: `image-${image.id}-${finding.ruleId}`, needsMoreEvidence: true,
      conclusion: `截图识别线索（待人工核对）：${finding.conclusion}`, evidence: [`image:${image.id}`, ...finding.evidence],
    }));
  });
}

export function hasDiagnosticEvidence(trace: Trace, textEvidence: { content: string }[]) {
  const hasValue = (value: unknown): boolean => typeof value === "string" ? Boolean(value.trim()) : typeof value === "number" || typeof value === "boolean" ? true : Array.isArray(value) ? value.some(hasValue) : value && typeof value === "object" ? Object.values(value).some(hasValue) : false;
  return Boolean(trace.statusCode || [trace.clientRequest, trace.transformedRequest, trace.upstreamResponse, trace.finalResponse, trace.sse].some(hasValue) || trace.logs?.some((line) => line.trim() && !/^occurred_at=/.test(line)) || textEvidence.some((item) => item.content.trim()));
}
