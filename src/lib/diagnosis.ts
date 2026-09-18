import { readFile } from "fs/promises";
import { join } from "path";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { apiTraces, cases, citations, diagnosisRuns, evidenceAssets, ruleFindings } from "@/db/schema";
import { searchKnowledge, type KnowledgeHit } from "@/lib/knowledge";
import type { Finding, Trace } from "@/lib/types";

const reportSchema = z.object({
  summary: z.string().min(1).max(4000),
  root_cause: z.string().min(1).max(4000),
  confidence: z.preprocess(
    (value) =>
      typeof value === "string" ? Number(value.replace(/[^0-9.]+/g, "")) : value,
    z.number().min(0).max(100),
  ),
  severity: z.enum(["critical", "high", "medium", "low"]),
  fault_layer: z.enum(["client", "gateway", "adapter", "route", "provider", "upstream", "unknown"]),
  confirmed_evidence: z.array(z.string().max(1000)).max(12),
  hypotheses: z.array(z.string().max(1000)).max(8),
  missing_evidence: z.array(z.string().max(1000)).max(8),
  next_actions: z.array(z.string().max(1000)).min(1).max(8),
  customer_message: z.string().min(1).max(2000),
});
export type AiReport = z.infer<typeof reportSchema>;
type ImageExtraction = { status: "completed" | "failed"; error?: string; fields?: string[]; summary?: string };
type EvidenceContext = {
  ruleIds: Set<string>;
  knowledgeIds: Set<string>;
  imageIds: Set<string>;
  traceReferences: Set<string>;
};
const MAX_MODEL_IMAGES = 5;
export class DiagnosisNotFoundError extends Error {}
export class DiagnosisConflictError extends Error {}
export function parseAiReport(raw: string): AiReport {
  return reportSchema.parse(JSON.parse(raw));
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Request cancelled", "AbortError");
}

function validateEvidence(report: AiReport, context: EvidenceContext) {
  for (const evidence of report.confirmed_evidence) {
    const [source, reference] = evidence.split(":", 2);
    const valid =
      (source === "rule" && context.ruleIds.has(reference)) ||
      (source === "knowledge" && context.knowledgeIds.has(reference)) ||
      (source === "image" && context.imageIds.has(reference)) ||
      (source === "trace" && context.traceReferences.has(reference));
    if (!valid) throw new Error(`Invalid evidence reference: ${evidence}`);
  }
}

function config() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("千问模型未配置。请设置 OPENAI_BASE_URL 与 OPENAI_API_KEY。");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function completion(model: string, messages: unknown[], responseFormat = true, signal?: AbortSignal) {
  const { baseUrl, apiKey } = config();
  assertNotAborted(signal);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.1, ...(responseFormat ? { response_format: { type: "json_object" } } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`千问调用失败（HTTP ${response.status}）。`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("千问未返回诊断内容。");
  return content;
}

async function extractImage(asset: { id: string; filePath: string; extraction: unknown }, signal?: AbortSignal) {
  const existing = asset.extraction as ImageExtraction | null;
  if (existing?.status === "completed") return existing;
  try {
    const data = await readFile(join(process.cwd(), asset.filePath));
    const mime = asset.filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const content = await completion(process.env.VISION_MODEL || "qwen-vl-max", [{ role: "system", content: "你是 API 排障证据提取器。只识别截图中可见的错误码、时间、请求 ID、Trace ID、接口、状态码和日志。不要猜测被遮蔽或不可见内容。输出 JSON：{summary:string,fields:string[]}。" }, { role: "user", content: [{ type: "text", text: "提取这张已脱敏截图中的排障事实。" }, { type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}` } }] }], true, signal);
    const parsed = z.object({ summary: z.string().max(3000), fields: z.array(z.string().max(500)).max(30) }).parse(JSON.parse(content));
    const result: ImageExtraction = { status: "completed", ...parsed };
    await db.update(evidenceAssets).set({ extraction: result }).where(eq(evidenceAssets.id, asset.id));
    return result;
  } catch (error) {
    const result: ImageExtraction = { status: "failed", error: error instanceof Error ? error.message : "图片提取失败。" };
    await db.update(evidenceAssets).set({ extraction: result }).where(eq(evidenceAssets.id, asset.id));
    return result;
  }
}

function queryFor(trace: Trace, findings: Finding[], images: ImageExtraction[]) {
  return [trace.provider, trace.route, trace.model, trace.statusCode, ...findings.map((f) => f.ruleId), ...images.flatMap((x) => x.fields ?? [])].filter(Boolean).join(" ").slice(0, 200);
}

export async function runDiagnosis(caseId: string, signal?: AbortSignal) {
  const started = Date.now();
  assertNotAborted(signal);
  const [claimed] = await db
    .update(cases)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(and(eq(cases.id, caseId), eq(cases.status, "completed")))
    .returning({ id: cases.id });
  if (!claimed) {
    const [existing] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!existing) throw new DiagnosisNotFoundError("案件不存在。");
    throw new DiagnosisConflictError("案件尚未完成或 AI 诊断正在运行。");
  }
  const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, caseId)).limit(1);
  if (!trace) {
    await db.update(cases).set({ status: "completed", updatedAt: new Date() }).where(eq(cases.id, caseId));
    throw new Error("案件缺少 Trace，无法运行 AI 诊断。");
  }
  const traceInput: Trace = {
    customerQuestion: trace.customerQuestion ?? undefined,
    requestId: trace.requestId ?? undefined,
    traceId: trace.traceId ?? undefined,
    upstreamRequestId: trace.upstreamRequestId ?? undefined,
    provider: trace.provider ?? undefined,
    route: trace.route ?? undefined,
    model: trace.model ?? undefined,
    statusCode: trace.statusCode ?? undefined,
    clientRequest: (trace.clientRequest ?? undefined) as Record<string, unknown> | undefined,
    transformedRequest: (trace.transformedRequest ?? undefined) as Record<string, unknown> | undefined,
    upstreamResponse: (trace.upstreamResponse ?? undefined) as Record<string, unknown> | undefined,
    finalResponse: (trace.finalResponse ?? undefined) as Record<string, unknown> | undefined,
    logs: (trace.logs ?? undefined) as string[] | undefined,
    sse: (trace.sse ?? undefined) as string[] | undefined,
  };
  const [assets, findings] = await Promise.all([
    db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, caseId)),
    db.select().from(ruleFindings).where(eq(ruleFindings.caseId, caseId)),
  ]);
  const run = await db.insert(diagnosisRuns).values({ caseId, model: process.env.ANALYSIS_MODEL || "qwen-plus", report: { state: "running" }, status: "running" }).returning({ id: diagnosisRuns.id });
  try {
    const approvedImages = assets.filter(
      (asset) => asset.redactionStatus === "redacted" && /\.(png|jpe?g)$/i.test(asset.filePath),
    );
    if (approvedImages.length > MAX_MODEL_IMAGES)
      throw new Error(`单次诊断最多处理 ${MAX_MODEL_IMAGES} 张已确认脱敏的图片。`);
    const images: ImageExtraction[] = [];
    for (const asset of approvedImages) {
      assertNotAborted(signal);
      images.push(await extractImage(asset, signal));
    }
    const knowledge = await searchKnowledge(queryFor(traceInput, findings as Finding[], images), trace.provider ?? undefined).catch(() => [] as KnowledgeHit[]);
    const similar = await db.select({ id: cases.id, title: cases.title, summary: cases.summary, conclusion: cases.finalConclusion }).from(cases).where(and(ne(cases.id, caseId), eq(cases.status, "completed"))).orderBy(desc(cases.updatedAt)).limit(5);
    const prompt = { trace: traceInput, rules: findings, imageEvidence: images.map((image, index) => ({ id: approvedImages[index].id, ...image })), knowledge: knowledge.slice(0, 5).map((x) => ({ id: x.id, title: x.title, url: x.sourceUrl, excerpt: x.body.slice(0, 1200) })), similarCases: similar, instructions: "仅基于提供的证据诊断 API 故障。confirmed_evidence 每项必须精确使用 rule:<ruleId>、trace:<字段名>、image:<imageId> 或 knowledge:<knowledgeId>；禁止编造引用。无直接证据的结论放入 hypotheses。严格输出 JSON，字段为 summary, root_cause, confidence, severity, fault_layer, confirmed_evidence, hypotheses, missing_evidence, next_actions, customer_message。" };
    const raw = await completion(process.env.ANALYSIS_MODEL || "qwen-plus", [{ role: "system", content: "你是审慎的 API 排障工程师。不得把假设写成已确认根因。" }, { role: "user", content: JSON.stringify(prompt) }], true, signal);
    const report = parseAiReport(raw);
    validateEvidence(report, {
      ruleIds: new Set(findings.map((finding) => finding.ruleId)),
      knowledgeIds: new Set(knowledge.slice(0, 5).map((item) => item.id)),
      imageIds: new Set(approvedImages.map((asset) => asset.id)),
      traceReferences: new Set(["customerQuestion", "requestId", "traceId", "upstreamRequestId", "provider", "route", "model", "statusCode", "logs", "sse"]),
    });
    await db.transaction(async (tx) => {
      await tx.update(diagnosisRuns).set({ report, durationMs: Date.now() - started, status: "completed" }).where(eq(diagnosisRuns.id, run[0].id));
      await tx.update(cases).set({ status: "completed", summary: report.summary, finalConclusion: report.root_cause, confidence: report.confidence / 100, updatedAt: new Date() }).where(eq(cases.id, caseId));
      const refs = knowledge.slice(0, 5).map((x) => ({ diagnosisId: run[0].id, title: x.title, url: x.sourceUrl, vendor: x.vendor, category: x.category, excerpt: x.body.slice(0, 1000) }));
      if (refs.length) await tx.insert(citations).values(refs);
    });
    return { runId: run[0].id, report };
  } catch (error) {
    const cancelled = signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = cancelled ? "AI 诊断已取消。" : error instanceof Error ? error.message : "AI 诊断失败。";
    await db.transaction(async (tx) => {
      await tx.update(diagnosisRuns).set({ report: { state: cancelled ? "cancelled" : "failed", error: message }, durationMs: Date.now() - started, status: cancelled ? "cancelled" : "failed" }).where(eq(diagnosisRuns.id, run[0].id));
      await tx.update(cases).set({ status: "completed", updatedAt: new Date() }).where(eq(cases.id, caseId));
    });
    throw new Error(message);
  }
}
