import { readFile } from "fs/promises";
import { join } from "path";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { apiTraces, cases, citations, diagnosisRuns, evidenceAssets, ruleFindings } from "@/db/schema";
import { searchKnowledgeQueries, type KnowledgeHit } from "@/lib/knowledge";
import type { Finding, Trace } from "@/lib/types";

const reportTextItem = z.preprocess((value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "source" in value && "reference" in value) {
    const item = value as { source?: unknown; reference?: unknown };
    if (typeof item.source === "string" && typeof item.reference === "string") return `${item.source}:${item.reference}`;
  }
  return value;
}, z.string().max(1000));
const reportSchema = z.object({
  summary: z.string().min(1).max(4000), root_cause: z.string().min(1).max(4000),
  confidence: z.preprocess((value) => typeof value === "string" ? Number(value.replace(/[^0-9.]+/g, "")) : value, z.number().min(0).max(100)),
  severity: z.enum(["critical", "high", "medium", "low"]),
  fault_layer: z.enum(["client", "gateway", "adapter", "route", "provider", "upstream", "unknown"]),
  confirmed_evidence: z.array(reportTextItem).max(12), hypotheses: z.array(reportTextItem).max(8),
  missing_evidence: z.array(reportTextItem).max(8), next_actions: z.array(reportTextItem).min(1).max(8), customer_message: z.string().min(1).max(2000),
});
export type AiReport = z.infer<typeof reportSchema>;
export const reasoningEfforts = ["low", "high", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
type ImageExtraction = { status: "completed" | "failed"; error?: string; fields?: string[]; summary?: string };
type EvidenceContext = { ruleIds: Set<string>; knowledgeIds: Set<string>; imageIds: Set<string>; traceReferences: Set<string> };
type DashScopeResponse = { code?: string; message?: string; output?: { choices?: { message?: { content?: unknown } }[] } };
const MAX_MODEL_IMAGES = 5;
export class DiagnosisNotFoundError extends Error {}
export class DiagnosisConflictError extends Error {}
export function parseAiReport(raw: string): AiReport { return reportSchema.parse(JSON.parse(raw)); }
function assertNotAborted(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Request cancelled", "AbortError"); }
function validateEvidence(report: AiReport, context: EvidenceContext) {
  for (const evidence of report.confirmed_evidence) {
    const [source, rawReference] = evidence.split(":", 2);
    const reference = rawReference?.split(/[=\s]/, 1)[0]?.replace(/\[\d+\].*$/, "");
    if (!((source === "rule" && context.ruleIds.has(reference)) || (source === "knowledge" && context.knowledgeIds.has(reference)) || (source === "image" && context.imageIds.has(reference)) || (source === "trace" && context.traceReferences.has(reference)))) throw new Error(`Invalid evidence reference: ${evidence}`);
  }
}
function config() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Qwen is not configured. Set DASHSCOPE_API_KEY.");
  return { apiKey, baseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "") };
}
function messageContent(body: DashScopeResponse) {
  const content = body.output?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) { const text = content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "").join(""); if (text) return text; }
  throw new Error("Qwen did not return content.");
}
async function dashScopeCompletion(endpoint: "text-generation" | "multimodal-generation", model: string, messages: unknown[], parameters: Record<string, unknown>, signal?: AbortSignal) {
  const { baseUrl, apiKey } = config(); assertNotAborted(signal);
  const response = await fetch(`${baseUrl}/services/aigc/${endpoint}/generation`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, input: { messages }, parameters: { result_format: "message", temperature: 0.1, ...parameters } }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
  const body = (await response.json().catch(() => ({}))) as DashScopeResponse;
  if (!response.ok) throw new Error(`Qwen request failed (HTTP ${response.status}${body.code ? ` / ${body.code}` : ""}): ${body.message || "request rejected"}`);
  return messageContent(body);
}
async function extractImage(asset: { id: string; filePath: string; extraction: unknown }, signal?: AbortSignal) {
  const existing = asset.extraction as ImageExtraction | null; if (existing?.status === "completed") return existing;
  try {
    const data = await readFile(join(process.cwd(), asset.filePath)); const mime = asset.filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const content = await dashScopeCompletion("multimodal-generation", process.env.QWEN_VISION_MODEL || "qwen-vl-max", [{ role: "system", content: "Extract only visible API troubleshooting facts from the image. Output JSON with summary and fields." }, { role: "user", content: [{ text: "Extract visible error codes, timestamps, request IDs, trace IDs, endpoints, status codes, and log clues." }, { image: `data:${mime};base64,${data.toString("base64")}` }] }], { response_format: { type: "json_object" } }, signal);
    const parsed = z.object({ summary: z.string().max(3000), fields: z.array(z.string().max(500)).max(30) }).parse(JSON.parse(content)); const result: ImageExtraction = { status: "completed", ...parsed };
    await db.update(evidenceAssets).set({ extraction: result }).where(eq(evidenceAssets.id, asset.id)); return result;
  } catch (error) { const result: ImageExtraction = { status: "failed", error: error instanceof Error ? error.message : "Image extraction failed." }; await db.update(evidenceAssets).set({ extraction: result }).where(eq(evidenceAssets.id, asset.id)); return result; }
}
function stringTokens(value: unknown) {
  return (typeof value === "string" ? value : JSON.stringify(value ?? "")).match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? [];
}
function knowledgeQueries(trace: Trace, findings: Finding[], images: ImageExtraction[]) {
  const sources: unknown[] = [trace.provider, trace.route, trace.model, trace.statusCode, trace.clientRequest, trace.transformedRequest, trace.upstreamResponse, trace.finalResponse, trace.logs, trace.sse, ...findings.flatMap((finding) => [finding.ruleId, finding.conclusion, finding.evidence]), ...images.flatMap((image) => image.fields ?? [])];
  return [...new Set(sources.flatMap(stringTokens))];
}
function traceReferenceSet(trace: Trace) {
  const refs = new Set(["customerQuestion", "requestId", "traceId", "upstreamRequestId", "provider", "route", "model", "statusCode", "clientRequest", "transformedRequest", "upstreamResponse", "finalResponse", "logs", "sse"]);
  const addPaths = (value: unknown, prefix: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) { const path = `${prefix}.${key}`; refs.add(path); addPaths(child, path); }
  };
  for (const [field, value] of Object.entries(trace)) addPaths(value, field);
  return refs;
}
export async function runDiagnosis(caseId: string, reasoningEffort: ReasoningEffort = "high", signal?: AbortSignal) {
  const started = Date.now(); assertNotAborted(signal);
  const [claimed] = await db.update(cases).set({ status: "analyzing", updatedAt: new Date() }).where(and(eq(cases.id, caseId), eq(cases.status, "completed"))).returning({ id: cases.id });
  if (!claimed) { const [existing] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1); if (!existing) throw new DiagnosisNotFoundError("Case not found."); throw new DiagnosisConflictError("Case is not ready or diagnosis is already running."); }
  const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, caseId)).limit(1);
  if (!trace) { await db.update(cases).set({ status: "completed", updatedAt: new Date() }).where(eq(cases.id, caseId)); throw new Error("Case has no trace."); }
  const traceInput: Trace = { customerQuestion: trace.customerQuestion ?? undefined, requestId: trace.requestId ?? undefined, traceId: trace.traceId ?? undefined, upstreamRequestId: trace.upstreamRequestId ?? undefined, provider: trace.provider ?? undefined, route: trace.route ?? undefined, model: trace.model ?? undefined, statusCode: trace.statusCode ?? undefined, clientRequest: trace.clientRequest as Record<string, unknown> | undefined, transformedRequest: trace.transformedRequest as Record<string, unknown> | undefined, upstreamResponse: trace.upstreamResponse as Record<string, unknown> | undefined, finalResponse: trace.finalResponse as Record<string, unknown> | undefined, logs: trace.logs as string[] | undefined, sse: trace.sse as string[] | undefined };
  const [assets, findings] = await Promise.all([db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, caseId)), db.select().from(ruleFindings).where(eq(ruleFindings.caseId, caseId))]);
  const model = process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus";
  const run = await db.insert(diagnosisRuns).values({ caseId, model, reasoningEffort, report: { state: "running" }, status: "running" }).returning({ id: diagnosisRuns.id });
  try {
    const approvedImages = assets.filter((asset) => asset.redactionStatus === "redacted" && /\.(png|jpe?g)$/i.test(asset.filePath)); if (approvedImages.length > MAX_MODEL_IMAGES) throw new Error(`At most ${MAX_MODEL_IMAGES} redacted images are allowed.`);
    const images: ImageExtraction[] = []; for (const asset of approvedImages) { assertNotAborted(signal); images.push(await extractImage(asset, signal)); }
    const knowledge = await searchKnowledgeQueries(knowledgeQueries(traceInput, findings as Finding[], images), trace.provider ?? undefined).catch(() => [] as KnowledgeHit[]);
    const similar = await db.select({ id: cases.id, title: cases.title, summary: cases.summary, conclusion: cases.finalConclusion }).from(cases).where(and(ne(cases.id, caseId), eq(cases.status, "completed"))).orderBy(desc(cases.updatedAt)).limit(5);
    const prompt = { trace: traceInput, rules: findings.map(({ ruleId, severity, faultLayer, evidence, conclusion, needsMoreEvidence }) => ({ ruleId, severity, faultLayer, evidence, conclusion, needsMoreEvidence })), imageEvidence: images.map((image, index) => ({ id: approvedImages[index].id, ...image })), knowledge: knowledge.slice(0, 5).map((x) => ({ id: x.id, title: x.title, url: x.sourceUrl, excerpt: x.body.slice(0, 1200) })), similarCases: similar, instructions: "Diagnose only from supplied evidence. confirmed_evidence must use rule:<id>, trace:<field>, image:<id>, or knowledge:<id>. When provided knowledge directly supports the root cause or a next action, include the relevant knowledge:<id> reference. Put unsupported conclusions in hypotheses. Every item in confirmed_evidence, hypotheses, missing_evidence, and next_actions must be a plain string, never an object. Output JSON with summary, root_cause, confidence, severity, fault_layer, confirmed_evidence, hypotheses, missing_evidence, next_actions, customer_message." };
    const raw = await dashScopeCompletion("multimodal-generation", model, [{ role: "system", content: "You are a careful API troubleshooting engineer. Do not present hypotheses as confirmed root causes." }, { role: "user", content: JSON.stringify(prompt) }], { enable_thinking: true, reasoning_effort: reasoningEffort, response_format: { type: "json_object" } }, signal);
    const report = parseAiReport(raw); validateEvidence(report, { ruleIds: new Set(findings.map((finding) => finding.ruleId)), knowledgeIds: new Set(knowledge.slice(0, 5).map((item) => item.id)), imageIds: new Set(approvedImages.map((asset) => asset.id)), traceReferences: traceReferenceSet(traceInput) });
    await db.transaction(async (tx) => { await tx.update(diagnosisRuns).set({ report, durationMs: Date.now() - started, status: "completed" }).where(eq(diagnosisRuns.id, run[0].id)); await tx.update(cases).set({ status: "completed", summary: report.summary, finalConclusion: report.root_cause, confidence: report.confidence / 100, updatedAt: new Date() }).where(eq(cases.id, caseId)); const citedIds = new Set(report.confirmed_evidence.filter((item) => item.startsWith("knowledge:")).map((item) => item.slice("knowledge:".length))); const refs = knowledge.filter((item) => citedIds.has(item.id)).map((x) => ({ diagnosisId: run[0].id, title: x.title, url: x.sourceUrl, vendor: x.vendor, category: x.category, excerpt: x.body.slice(0, 1000) })); if (refs.length) await tx.insert(citations).values(refs); });
    return { runId: run[0].id, report };
  } catch (error) { const cancelled = signal?.aborted || (error instanceof DOMException && error.name === "AbortError"); const message = cancelled ? "AI diagnosis cancelled." : error instanceof Error ? error.message : "AI diagnosis failed."; await db.transaction(async (tx) => { await tx.update(diagnosisRuns).set({ report: { state: cancelled ? "cancelled" : "failed", error: message }, durationMs: Date.now() - started, status: cancelled ? "cancelled" : "failed" }).where(eq(diagnosisRuns.id, run[0].id)); await tx.update(cases).set({ status: "completed", updatedAt: new Date() }).where(eq(cases.id, caseId)); }); throw new Error(message); }
}
