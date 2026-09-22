import { readFile } from "fs/promises";
import { join } from "path";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import {
  apiTraces,
  cases,
  citations,
  diagnosisRuns,
  diagnosisWorkflowSteps,
  evidenceAssets,
  ruleFindings,
} from "@/db/schema";
import { searchKnowledgeQueries } from "@/lib/knowledge";
import { adjudicateReport, buildEvidenceLedger } from "@/lib/diagnosis-quality";
import { runRules } from "@/lib/rules";
import type { Finding, Trace } from "@/lib/types";

const reportTextItem = z.preprocess((value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "source" in value && "reference" in value) {
    const item = value as { source?: unknown; reference?: unknown };
    if (typeof item.source === "string" && typeof item.reference === "string")
      return `${item.source}:${item.reference}`;
  }
  return value;
}, z.string().max(1000));
const reportSchema = z.object({
  summary: z.string().min(1).max(4000),
  root_cause: z.string().min(1).max(4000),
  confidence: z.preprocess(
    (value) => (typeof value === "string" ? Number(value.replace(/[^0-9.]+/g, "")) : value),
    z.number().min(0).max(100),
  ),
  severity: z.enum(["critical", "high", "medium", "low"]),
  fault_layer: z.enum(["client", "gateway", "adapter", "route", "provider", "upstream", "unknown"]),
  confirmed_evidence: z.array(reportTextItem).max(12),
  hypotheses: z.array(reportTextItem).max(8),
  missing_evidence: z.array(reportTextItem).max(8),
  next_actions: z.array(reportTextItem).min(1).max(8),
  customer_message: z.string().min(1).max(2000),
  root_cause_evidence: z.array(reportTextItem).max(6).default([]),
});
export type AiReport = z.infer<typeof reportSchema>;
export const reasoningEfforts = ["low", "high", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
type ImageExtraction = {
  status: "completed" | "failed";
  error?: string;
  fields?: string[];
  summary?: string;
};
type EvidenceContext = {
  ruleIds: Set<string>;
  knowledgeIds: Set<string>;
  imageIds: Set<string>;
  traceReferences: Set<string>;
  textEvidenceIds: Set<string>;
};
type TextEvidence = { id: string; evidenceType: string; content: string; truncated: boolean };
type DashScopeResponse = {
  code?: string;
  message?: string;
  output?: { choices?: { message?: { content?: unknown } }[] };
};
const MAX_MODEL_IMAGES = 5;
const IMAGE_EXTRACTION_CONCURRENCY = 2;
type WorkflowNode = "prepare" | "images" | "retrieval" | "model" | "adjudicate" | "validate_and_persist";
export class DiagnosisNotFoundError extends Error {}
export class DiagnosisConflictError extends Error {}
export function workflowSummary(error: unknown) {
  const message = error instanceof Error ? error.message : "step failed";
  if (/429|rate limit/i.test(message)) return "upstream rate limited";
  if (/timeout|abort/i.test(message)) return "upstream timeout or cancellation";
  if (/network|fetch|ECONN/i.test(message)) return "upstream connection failed";
  return "step failed";
}
async function markWorkflowStep(
  diagnosisId: string,
  nodeName: WorkflowNode,
  status: "running" | "completed" | "failed" | "skipped",
  summary?: string,
) {
  const now = new Date();
  await db
    .insert(diagnosisWorkflowSteps)
    .values({
      diagnosisId,
      nodeName,
      status,
      attempts: status === "running" ? 1 : 0,
      ...(status === "running" ? { startedAt: now } : { completedAt: now }),
      ...(summary ? { summary } : {}),
    })
    .onConflictDoUpdate({
      target: [diagnosisWorkflowSteps.diagnosisId, diagnosisWorkflowSteps.nodeName],
      set: {
        status,
        ...(status === "running"
          ? { attempts: sql`${diagnosisWorkflowSteps.attempts} + 1`, startedAt: now, completedAt: null }
          : { completedAt: now }),
        ...(summary ? { summary } : {}),
      },
    });
}
export function parseAiReport(raw: string): AiReport {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return reportSchema.parse(JSON.parse(json));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown validation error";
    throw new Error(`Invalid AI diagnosis report: ${message}`);
  }
}
function isChineseReport(report: AiReport) {
  const readableText = [
    report.summary,
    report.root_cause,
    report.customer_message,
    ...report.confirmed_evidence,
    ...report.hypotheses,
    ...report.missing_evidence,
    ...report.next_actions,
  ];
  return readableText.every((item) => /[\u3400-\u9fff]/.test(item));
}
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Request cancelled", "AbortError");
}
export function validateEvidence(report: AiReport, context: EvidenceContext) {
  for (const evidence of [...report.confirmed_evidence, ...report.root_cause_evidence]) {
    const [source, rawReference] = evidence.split(":", 2);
    const reference = rawReference?.split(/[=\s]/, 1)[0]?.replace(/\[\d+\].*$/, "");
    const matches = (values: Set<string>) =>
      Boolean(reference && [...values].some((value) => reference.startsWith(value)));
    if (
      !(
        (source === "rule" && matches(context.ruleIds)) ||
        (source === "knowledge" && matches(context.knowledgeIds)) ||
        (source === "image" && matches(context.imageIds)) ||
        (source === "text" && matches(context.textEvidenceIds)) ||
        (source === "trace" && matches(context.traceReferences))
      )
    )
      throw new Error(`Invalid evidence reference: ${evidence}`);
  }
}
function config() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Qwen is not configured. Set DASHSCOPE_API_KEY.");
  return {
    apiKey,
    baseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(
      /\/$/,
      "",
    ),
  };
}
export function parseDashScopeContent(body: DashScopeResponse) {
  const content = body.output?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "",
      )
      .join("");
    if (text) return text;
  }
  throw new Error("Qwen did not return content.");
}
async function dashScopeAttempt(
  endpoint: "text-generation" | "multimodal-generation",
  model: string,
  messages: unknown[],
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { baseUrl, apiKey } = config();
  assertNotAborted(signal);
  const response = await fetch(`${baseUrl}/services/aigc/${endpoint}/generation`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: { messages },
      parameters: { result_format: "message", temperature: 0.1, ...parameters },
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
      : AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => ({}))) as DashScopeResponse;
  if (!response.ok)
    throw new Error(
      `Qwen request failed (HTTP ${response.status}${body.code ? ` / ${body.code}` : ""}): ${body.message || "request rejected"}`,
    );
  return parseDashScopeContent(body);
}
function retryableModelFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /HTTP (429|5\d\d)|fetch failed|ECONN|network|timeout/i.test(message);
}
async function waitForRetry(delayMs: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Request cancelled", "AbortError"));
    }, { once: true });
  });
}
async function dashScopeCompletion(
  endpoint: "text-generation" | "multimodal-generation",
  model: string,
  messages: unknown[],
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await dashScopeAttempt(endpoint, model, messages, parameters, signal); }
    catch (error) {
      lastError = error;
      if (attempt === 2 || !retryableModelFailure(error) || signal?.aborted) throw error;
      await waitForRetry(500 * 2 ** attempt + Math.floor(Math.random() * 250), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Qwen request failed.");
}
async function extractImage(
  asset: { id: string; filePath: string; extraction: unknown },
  signal?: AbortSignal,
) {
  const existing = asset.extraction as ImageExtraction | null;
  if (existing?.status === "completed") return existing;
  try {
    const data = await readFile(join(process.cwd(), asset.filePath));
    const mime = asset.filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const content = await dashScopeCompletion(
      "multimodal-generation",
      process.env.QWEN_VISION_MODEL || "qwen-vl-max",
      [
        {
          role: "system",
          content:
            "你是 API 排障证据提取助手。仅提取图片中实际可见的 API 排障事实，不要推测或补全。所有说明性文本必须使用简体中文；错误码、时间戳、请求 ID、Trace ID、接口地址、模型名和原始日志片段必须保持原样。仅输出包含 summary 和 fields 的 JSON 对象。",
        },
        {
          role: "user",
          content: [
            {
              text: "请提取图片中可见的错误码、时间戳、请求 ID、Trace ID、接口地址、HTTP 状态码和日志线索。summary 与 fields 中的说明使用简体中文；技术标识符和原始日志片段保持原样。",
            },
            { image: `data:${mime};base64,${data.toString("base64")}` },
          ],
        },
      ],
      { response_format: { type: "json_object" } },
      signal,
    );
    const parsed = z
      .object({
        summary: z.string().max(3000),
        fields: z.union([
          z.array(z.string().max(500)).max(30),
          z.record(z.union([z.string(), z.number(), z.boolean()])).refine(
            (value) => Object.keys(value).length <= 30,
            "too many fields",
          ),
        ]),
      })
      .parse(JSON.parse(content));
    const fields = Array.isArray(parsed.fields)
      ? parsed.fields
      : Object.entries(parsed.fields).map(([key, value]) => `${key}=${String(value).slice(0, 450)}`);
    const result: ImageExtraction = { status: "completed", summary: parsed.summary, fields };
    await db
      .update(evidenceAssets)
      .set({ extraction: result })
      .where(eq(evidenceAssets.id, asset.id));
    return result;
  } catch (error) {
    const result: ImageExtraction = {
      status: "failed",
      error: error instanceof Error ? error.message : "Image extraction failed.",
    };
    await db
      .update(evidenceAssets)
      .set({ extraction: result })
      .where(eq(evidenceAssets.id, asset.id));
    return result;
  }
}
type KnowledgeQuery = { value: string; kind: "error" | "status" | "field" | "event" | "model" | "route" | "phrase" | "rule" };
const sensitive = /(?:authorization|cookie|api[-_]?key|secret|token|password)\s*[:=]/i;
function strings(value: unknown, output: string[] = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => { output.push(key); strings(item, output); });
  return output;
}
export function knowledgeQueries(trace: Trace, findings: Finding[], images: ImageExtraction[]): KnowledgeQuery[] {
  const sources: unknown[] = [
    trace.customerQuestion,
    trace.provider,
    trace.route,
    trace.model,
    trace.statusCode,
    trace.clientRequest,
    trace.transformedRequest,
    trace.upstreamResponse,
    trace.finalResponse,
    trace.logs,
    trace.sse,
    ...findings.flatMap((finding) => [finding.ruleId, finding.conclusion, finding.evidence]),
    ...images.flatMap((image) => image.fields ?? []),
  ];
  const candidates: KnowledgeQuery[] = [];
  for (const source of sources) for (const raw of strings(source)) {
    if (sensitive.test(raw)) continue;
    const value = raw.slice(0, 200);
    for (const token of value.match(/\b(?:[45]\d{2}|\d{3,5})\b|\b(?:[A-Z][A-Za-z]+(?:Exception|Error)|[a-z][a-z0-9_]{2,})\b/g) ?? [])
      candidates.push({ value: token, kind: /^\d+$/.test(token) ? "status" : /(Exception|Error|exceeded|timeout|rate)/i.test(token) ? "error" : "field" });
    for (const phrase of value.match(/[\u3400-\u9fff]{2,16}/g) ?? []) candidates.push({ value: phrase, kind: "phrase" });
  }
  if (trace.model) candidates.push({ value: trace.model, kind: "model" });
  if (trace.route) candidates.push({ value: trace.route, kind: "route" });
  for (const event of [...(trace.sse ?? []), ...(trace.logs ?? [])]) {
    const match = /(?:event\s*[:=]\s*|\bevent\b\s+)([A-Za-z][\w.-]+)/i.exec(event);
    if (match) candidates.push({ value: match[1], kind: "event" });
  }
  for (const finding of findings) candidates.push({ value: finding.ruleId, kind: "rule" });
  const weight: Record<KnowledgeQuery["kind"], number> = { event: -1, error: 0, status: 1, field: 2, model: 4, route: 5, rule: 6, phrase: 7 };
  const deduped = new Map<string, KnowledgeQuery>();
  for (const item of candidates.filter((item) => item.value.length >= 2 && !sensitive.test(item.value))) {
    const key = item.value.toLowerCase(); const old = deduped.get(key);
    if (!old || weight[item.kind] < weight[old.kind]) deduped.set(key, item);
  }
  return [...deduped.values()].sort((a, b) => weight[a.kind] - weight[b.kind]).slice(0, 8);
}
async function readTextEvidence(
  assets: { id: string; filePath: string; evidenceType: string; redactionStatus: string }[],
) {
  const selected = assets
    .filter((asset) => asset.redactionStatus === "redacted" && /\.(json|txt|log)$/i.test(asset.filePath))
    .slice(0, 5);
  let remaining = 120_000;
  const result: TextEvidence[] = [];
  for (const asset of selected) {
    if (remaining <= 0) break;
    try {
      const content = await readFile(join(process.cwd(), asset.filePath), "utf8");
      const included = content.slice(0, Math.min(40_000, remaining));
      remaining -= included.length;
      if (included.trim())
        result.push({ id: asset.id, evidenceType: asset.evidenceType, content: included, truncated: included.length < content.length });
    } catch {
      // A missing attachment must not make a case impossible to diagnose; it is simply omitted.
    }
  }
  return result;
}
export function knowledgeCitationIds(items: string[]) {
  return new Set(
    items.flatMap((item) => {
      const match = /^knowledge:([0-9a-f-]{36})(?:\s|$)/i.exec(item.trim());
      return match ? [match[1]] : [];
    }),
  );
}
function traceReferenceSet(trace: Trace) {
  const refs = new Set([
    "customerQuestion",
    "requestId",
    "traceId",
    "upstreamRequestId",
    "provider",
    "route",
    "model",
    "statusCode",
    "clientRequest",
    "transformedRequest",
    "upstreamResponse",
    "finalResponse",
    "logs",
    "sse",
  ]);
  const addPaths = (value: unknown, prefix: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const path = `${prefix}.${key}`;
      refs.add(path);
      addPaths(child, path);
    }
  };
  for (const [field, value] of Object.entries(trace)) addPaths(value, field);
  return refs;
}
export async function runDiagnosis(
  caseId: string,
  reasoningEffort: ReasoningEffort = "high",
  signal?: AbortSignal,
) {
  const started = Date.now();
  assertNotAborted(signal);
  const [claimed] = await db
    .update(cases)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(and(eq(cases.id, caseId), eq(cases.status, "completed")))
    .returning({ id: cases.id });
  let resumedRunId: string | undefined;
  if (!claimed) {
    const [existing] = await db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!existing) throw new DiagnosisNotFoundError("Case not found.");
    if (existing.status === "analyzing") {
      const [running] = await db
        .select({ id: diagnosisRuns.id })
        .from(diagnosisRuns)
        .where(and(eq(diagnosisRuns.caseId, caseId), eq(diagnosisRuns.status, "running")))
        .orderBy(desc(diagnosisRuns.createdAt))
        .limit(1);
      if (running) resumedRunId = running.id;
    }
    if (resumedRunId) {
      // pg-boss may redeliver work after a worker process dies. Reuse the
      // durable run instead of leaving the case permanently in `analyzing`.
    } else {
      throw new DiagnosisConflictError("Case is not ready or diagnosis is already running.");
    }
  }
  const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, caseId)).limit(1);
  if (!trace) {
    await db
      .update(cases)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    throw new Error("Case has no trace.");
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
    clientRequest: trace.clientRequest as Record<string, unknown> | undefined,
    transformedRequest: trace.transformedRequest as Record<string, unknown> | undefined,
    upstreamResponse: trace.upstreamResponse as Record<string, unknown> | undefined,
    finalResponse: trace.finalResponse as Record<string, unknown> | undefined,
    logs: trace.logs as string[] | undefined,
    sse: trace.sse as string[] | undefined,
  };
  const assets = await db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, caseId));
  const textEvidence = await readTextEvidence(assets);
  const enrichedTrace: Trace = {
    ...traceInput,
    logs: [...(traceInput.logs ?? []), ...textEvidence.map((item) => item.content)],
  };
  const allFindings = runRules(enrichedTrace);
  await db.transaction(async (tx) => {
    await tx.delete(ruleFindings).where(eq(ruleFindings.caseId, caseId));
    if (allFindings.length)
      await tx.insert(ruleFindings).values(
        allFindings.map((finding) => ({
          caseId,
          ruleId: finding.ruleId,
          severity: finding.severity,
          faultLayer: finding.faultLayer,
          evidence: finding.evidence,
          conclusion: finding.conclusion,
          needsMoreEvidence: finding.needsMoreEvidence,
        })),
      );
  });
  const model = process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus";
  const run = resumedRunId
    ? [{ id: resumedRunId }]
    : await db
        .insert(diagnosisRuns)
        .values({ caseId, model, reasoningEffort, report: { state: "running" }, status: "running" })
        .returning({ id: diagnosisRuns.id });
  const [checkpointRow] = resumedRunId
    ? await db
        .select({ report: diagnosisRuns.report })
        .from(diagnosisRuns)
        .where(eq(diagnosisRuns.id, resumedRunId))
        .limit(1)
    : [];
  const modelCheckpoint = checkpointRow?.report as { state?: string; output?: AiReport } | undefined;
  await markWorkflowStep(
    run[0].id,
    "prepare",
    "completed",
    resumedRunId ? "resumed after worker interruption" : "case, trace and evidence loaded",
  );
  let activeNode: WorkflowNode = "images";
  try {
    const approvedImages = assets.filter(
      (asset) =>
        (asset.redactionStatus === "redacted" || asset.redactionStatus === "direct_upload") &&
        /\.(png|jpe?g)$/i.test(asset.filePath),
    );
    if (approvedImages.length > MAX_MODEL_IMAGES)
      throw new Error(`At most ${MAX_MODEL_IMAGES} redacted images are allowed.`);
    activeNode = "images";
    await markWorkflowStep(run[0].id, "images", "running");
    const images = approvedImages.length
      ? await mapWithConcurrency(
          approvedImages,
          IMAGE_EXTRACTION_CONCURRENCY,
          async (asset) => {
            assertNotAborted(signal);
            return extractImage(asset, signal);
          },
        )
      : [];
    const successfulImages = approvedImages.flatMap((asset, index) => {
      const extraction = images[index];
      return extraction?.status === "completed" ? [{ id: asset.id, ...extraction }] : [];
    });
    const failedImageCount = images.filter((image) => image.status === "failed").length;
    await markWorkflowStep(
      run[0].id,
      "images",
      approvedImages.length ? "completed" : "skipped",
      approvedImages.length
        ? `${successfulImages.length} image(s) extracted${failedImageCount ? `; ${failedImageCount} failed and excluded from diagnosis` : ""}`
        : "no supported images",
    );
    const knowledgeQueryList = knowledgeQueries(
      enrichedTrace,
      allFindings as Finding[],
      successfulImages,
    );
    activeNode = "retrieval";
    await markWorkflowStep(run[0].id, "retrieval", "running");
    const retrieval = await searchKnowledgeQueries(knowledgeQueryList.map((item) => item.value), trace.provider ?? undefined).catch(() => ({ items: [], meta: { vendor: null, fallbackToAll: false, vendorHitCount: 0, fallbackHitCount: 0, backend: "unavailable" as const, error: "search backend unavailable" } }));
    const knowledge = retrieval.items;
    await markWorkflowStep(run[0].id, "retrieval", retrieval.meta.backend === "unavailable" ? "skipped" : "completed", retrieval.meta.backend === "unavailable" ? "knowledge search unavailable" : `${knowledge.length} document(s) selected`);
    // Historical model conclusions are not evidence. Do not feed them back into
    // a new diagnosis, otherwise one wrong conclusion can anchor later cases.
    const prompt = {
      trace: traceInput,
      rules: allFindings.map(
        ({ ruleId, severity, faultLayer, evidence, conclusion, needsMoreEvidence }) => ({
          ruleId,
          severity,
          faultLayer,
          evidence,
          conclusion,
          needsMoreEvidence,
        }),
      ),
      imageEvidence: successfulImages,
      textEvidence,
      knowledge: knowledge.slice(0, 5).map((x) => ({
        id: x.id,
        title: x.title,
        url: x.sourceUrl,
        excerpt: x.body.slice(0, 1200),
      })),
      evidenceLedger: buildEvidenceLedger(traceInput, allFindings, textEvidence, successfulImages),
      instructions:
        "仅依据所提供的证据进行诊断，不能将推测写成已确认的根因。所有 needsMoreEvidence 规则都是确认阻断项，必须在 missing_evidence 中说明。文本、截图和知识库片段只能支持候选，除非存在对应的确定性 rule 证据。必须至少提出一个替代解释；无法排除时写入 hypotheses。summary、root_cause、confirmed_evidence 中的说明、hypotheses、missing_evidence、next_actions 和 customer_message 的所有可读文本必须使用简体中文。错误码、请求 ID、Trace ID、模型名、API 字段名、URL、引用的原始日志片段和证据引用前缀必须保持原样。confirmed_evidence 必须使用 rule:<id>、trace:<field>、image:<id>、text:<id> 或 knowledge:<id> 形式的引用；knowledge 引用可在 ID 后附中文说明。缺少证据支撑的结论必须写入 hypotheses。confirmed_evidence、hypotheses、missing_evidence 和 next_actions 中的每一项都必须是纯字符串，不能是对象。仅输出 JSON，字段为 summary、root_cause、confidence、severity、fault_layer、confirmed_evidence、hypotheses、missing_evidence、next_actions、customer_message。",
    };
    const messages = [
      {
        role: "system",
        content:
          "你是一名严谨的 API 排障工程师。只可根据输入证据得出结论，不得将假设表述为已确认根因。所有面向读者的分析、建议和客户回复必须使用简体中文；错误码、请求 ID、Trace ID、模型名、API 字段名、URL 及原始证据必须保持原样。输出必须是符合用户要求字段的 JSON 对象，除 JSON 外不要输出任何内容。",
      },
      { role: "user", content: JSON.stringify(prompt) },
      {
        role: "user",
        content:
          "输出中必须包含 root_cause_evidence 数组。它只能引用 confirmed_evidence 中已有的 rule:<id>、trace:<field>、text:<id>、image:<id> 或 knowledge:<id>，且每一项必须直接支持 root_cause。",
      },
    ];
    const parameters = {
      enable_thinking: true,
      reasoning_effort: reasoningEffort,
      response_format: { type: "json_object" },
    };
    activeNode = "model";
    let report = modelCheckpoint?.state === "model_completed" && modelCheckpoint.output
      ? reportSchema.parse(modelCheckpoint.output)
      : undefined;
    if (!report) {
      await markWorkflowStep(run[0].id, "model", "running");
      const raw = await dashScopeCompletion(
        "multimodal-generation",
        model,
        messages,
        parameters,
        signal,
      );
      report = parseAiReport(raw);
    }
    if (!isChineseReport(report)) {
      const retry = await dashScopeCompletion(
        "multimodal-generation",
        model,
        [
          ...messages,
          {
            role: "user",
            content:
              "上一份输出因包含非中文的说明性报告文本而被拒绝。请重新生成完整 JSON。summary、root_cause、confirmed_evidence、hypotheses、missing_evidence、next_actions 与 customer_message 中每一项必须包含简体中文说明；仅技术标识符、原始日志和证据引用可保留原文。",
          },
        ],
        parameters,
        signal,
      );
      report = parseAiReport(retry);
      if (!isChineseReport(report))
        throw new Error("Qwen 未返回中文诊断报告，请稍后重试或检查模型配置。");
    }
    await markWorkflowStep(run[0].id, "model", "completed", "model report received");
    await db
      .update(diagnosisRuns)
      .set({ report: { state: "model_completed", output: report } })
      .where(eq(diagnosisRuns.id, run[0].id));
    activeNode = "validate_and_persist";
    await markWorkflowStep(run[0].id, "validate_and_persist", "running");
    validateEvidence(report, {
      ruleIds: new Set(allFindings.map((finding) => finding.ruleId)),
      knowledgeIds: new Set(knowledge.slice(0, 5).map((item) => item.id)),
      imageIds: new Set(successfulImages.map((image) => image.id)),
      textEvidenceIds: new Set(textEvidence.map((item) => item.id)),
      traceReferences: traceReferenceSet(traceInput),
    });
    activeNode = "adjudicate";
    await markWorkflowStep(run[0].id, "adjudicate", "running");
    const adjudication = adjudicateReport(report, allFindings);
    await markWorkflowStep(
      run[0].id,
      "adjudicate",
      "completed",
      `${adjudication.conclusionStatus}; ${adjudication.blockers.length} confirmation blocker(s)`,
    );
    await db.transaction(async (tx) => {
      await tx
        .update(diagnosisRuns)
        .set({
          report: { ...report, customer_message: adjudication.customerMessage, conclusion_status: adjudication.conclusionStatus, confirmation_blockers: adjudication.blockers, evidence_ledger: buildEvidenceLedger(traceInput, allFindings, textEvidence, successfulImages), retrieval: { queryCount: knowledgeQueryList.length, queryKinds: Object.fromEntries(knowledgeQueryList.reduce((counts, item) => counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1), new Map<string, number>())), vendor: retrieval.meta.vendor, vendorHitCount: retrieval.meta.vendorHitCount, fallbackToAll: retrieval.meta.fallbackToAll, fallbackHitCount: retrieval.meta.fallbackHitCount, finalDocumentCount: knowledge.length, backend: retrieval.meta.backend, ...(retrieval.meta.error ? { error: retrieval.meta.error } : {}) } },
          durationMs: Date.now() - started,
          status: "completed",
        })
        .where(eq(diagnosisRuns.id, run[0].id));
      await tx
        .update(cases)
        .set({
          status: "completed",
          summary: report.summary,
          finalConclusion: adjudication.conclusionStatus === "confirmed" ? report.root_cause : "初步诊断，待人工确认。",
          confidence: report.confidence / 100,
          updatedAt: new Date(),
        })
        .where(eq(cases.id, caseId));
      const citedIds = knowledgeCitationIds(report.confirmed_evidence);
      const refs = knowledge
        .filter((item) => citedIds.has(item.id))
        .map((x) => ({
          diagnosisId: run[0].id,
          title: x.title,
          url: x.sourceUrl,
          vendor: x.vendor,
          category: x.category,
          excerpt: x.body.slice(0, 1000),
        }));
      if (refs.length) await tx.insert(citations).values(refs);
    });
    await markWorkflowStep(run[0].id, "validate_and_persist", "completed", "report and citations saved");
    return { runId: run[0].id, report };
  } catch (error) {
    const cancelled =
      signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = cancelled
      ? "AI diagnosis cancelled."
      : error instanceof Error
        ? error.message
        : "AI diagnosis failed.";
    await markWorkflowStep(run[0].id, activeNode, "failed", workflowSummary(error)).catch(() => undefined);
    await db.transaction(async (tx) => {
      await tx
        .update(diagnosisRuns)
        .set({
          report: { state: cancelled ? "cancelled" : "failed", error: message },
          durationMs: Date.now() - started,
          status: cancelled ? "cancelled" : "failed",
        })
        .where(eq(diagnosisRuns.id, run[0].id));
      await tx
        .update(cases)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(cases.id, caseId));
    });
    throw new Error(message);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
