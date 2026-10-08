import { and, desc, eq, sql } from "drizzle-orm";
import { db, pool } from "@/db/client";
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
import { extractImages } from "@/lib/diagnosis-image";
import { MAX_MODEL_IMAGES, hasDiagnosticEvidence, imageRuleFindings, type ImageIssue } from "@/lib/image-evidence";
import { assertNotAborted, generateDiagnosisReport, validateEvidence, type AiReport, type ReasoningEffort } from "@/lib/diagnosis-model";
import { knowledgeCitationIds, knowledgeQueries, readTextEvidence, traceReferenceSet } from "@/lib/diagnosis-retrieval";
import type { Finding, Trace } from "@/lib/types";

export { parseAiReport, parseOpenAICompatibleContent, validateEvidence, reasoningEfforts } from "@/lib/diagnosis-model";
export type { AiReport, ReasoningEffort } from "@/lib/diagnosis-model";
export { knowledgeCitationIds, knowledgeQueries } from "@/lib/diagnosis-retrieval";

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
export async function runDiagnosis(
  caseId: string,
  reasoningEffort: ReasoningEffort = "high",
  signal?: AbortSignal,
  jobId?: string,
) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [caseId],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new DiagnosisConflictError("Diagnosis is already running for this case.");
    return await runDiagnosisLocked(caseId, reasoningEffort, signal, jobId);
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [caseId]); }
      finally { client.release(); }
    } else {
      client.release();
    }
  }
}

async function runDiagnosisLocked(
  caseId: string,
  reasoningEffort: ReasoningEffort,
  signal?: AbortSignal,
  jobId?: string,
) {
  const started = Date.now();
  assertNotAborted(signal);
  let model = process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus";
  const claimed = await db.transaction(async (tx) => {
    if (jobId) {
      const [completed] = await tx.select({ id: diagnosisRuns.id, report: diagnosisRuns.report }).from(diagnosisRuns)
        .where(and(eq(diagnosisRuns.caseId, caseId), eq(diagnosisRuns.status, "completed"),
          sql`${diagnosisRuns.report}->>'jobId' = ${jobId}`)).limit(1);
      if (completed) return { completed } as const;
    }
    const [existing] = await tx.select({ status: cases.status }).from(cases)
      .where(eq(cases.id, caseId)).limit(1);
    if (!existing) throw new DiagnosisNotFoundError("Case not found.");
    if (existing.status !== "completed" && existing.status !== "analyzing")
      throw new DiagnosisConflictError("Case is not ready for diagnosis.");
    const [running] = await tx.select({ id: diagnosisRuns.id, report: diagnosisRuns.report,
      model: diagnosisRuns.model, reasoningEffort: diagnosisRuns.reasoningEffort })
      .from(diagnosisRuns)
      .where(and(eq(diagnosisRuns.caseId, caseId), eq(diagnosisRuns.status, "running")))
      .orderBy(desc(diagnosisRuns.createdAt)).limit(1);
    if (running) {
      await tx.update(cases).set({ status: "analyzing", updatedAt: new Date() })
        .where(eq(cases.id, caseId));
      return { run: running, resumed: true } as const;
    }
    await tx.update(cases).set({ status: "analyzing", updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    const [run] = await tx.insert(diagnosisRuns)
      .values({ caseId, model, reasoningEffort, report: { state: "running", jobId }, status: "running" })
      .returning({ id: diagnosisRuns.id, report: diagnosisRuns.report,
        model: diagnosisRuns.model, reasoningEffort: diagnosisRuns.reasoningEffort });
    return { run, resumed: false } as const;
  });
  if ("completed" in claimed && claimed.completed)
    return { runId: claimed.completed.id, report: claimed.completed.report as AiReport };
  const runId = claimed.run.id;
  const resumedRunId = claimed.resumed ? runId : undefined;
  const modelCheckpoint = claimed.run.report as { state?: string; output?: AiReport; jobId?: string };
  const effectiveJobId = modelCheckpoint.jobId ?? jobId;
  model = claimed.run.model || model;
  reasoningEffort = (claimed.run.reasoningEffort as ReasoningEffort | null) || reasoningEffort;
  let activeNode: WorkflowNode = "prepare";
  try {
  const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, caseId)).limit(1);
  if (!trace) throw new Error("Case has no trace.");
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
  const assets = await db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, caseId)).orderBy(evidenceAssets.uploadedAt, evidenceAssets.id);
  const textEvidence = await readTextEvidence(assets);
  const enrichedTrace: Trace = {
    ...traceInput,
    logs: [...(traceInput.logs ?? []), ...textEvidence.map((item) => item.content)],
  };
  let allFindings = runRules(enrichedTrace);
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
  await markWorkflowStep(
    runId,
    "prepare",
    "completed",
    resumedRunId ? "resumed after worker interruption" : "case, trace and evidence loaded",
  );
  activeNode = "images";
    const approvedImages = assets.filter(
      (asset) =>
        (asset.redactionStatus === "redacted" || asset.redactionStatus === "direct_upload") &&
        /\.(png|jpe?g|webp)$/i.test(asset.filePath),
    );
    activeNode = "images";
    await markWorkflowStep(runId, "images", "running");
    const selectedImages = approvedImages.slice(0, MAX_MODEL_IMAGES);
    const images = await extractImages(selectedImages, IMAGE_EXTRACTION_CONCURRENCY, signal);
    const successfulImages = selectedImages.flatMap((asset, index) => {
      const extraction = images[index];
      return extraction?.status === "completed" ? [{ id: asset.id, ...extraction }] : [];
    });
    const imageIssues: ImageIssue[] = [
      ...selectedImages.flatMap((asset, index) => {
        const extraction = images[index];
        return extraction.status === "completed" ? [] : [{ id: asset.id, status: extraction.status, reason: extraction.error ?? "图片无法辨认。" }];
      }),
      ...approvedImages.slice(MAX_MODEL_IMAGES).map((asset) => ({ id: asset.id, status: "skipped" as const, reason: `每次最多处理 ${MAX_MODEL_IMAGES} 张图片；该图片未纳入本次诊断，请单独建立案件或移除重复截图。` })),
    ];
    const failedImageCount = imageIssues.length;
    const imageFindings = imageRuleFindings(traceInput, successfulImages, allFindings);
    if (imageFindings.length) {
      allFindings = [...allFindings, ...imageFindings];
      await db.insert(ruleFindings).values(imageFindings.map((finding) => ({ caseId, ...finding })));
    }
    await markWorkflowStep(
      runId,
      "images",
      approvedImages.length ? "completed" : "skipped",
      approvedImages.length
        ? `${successfulImages.length} image(s) extracted${failedImageCount ? `; ${failedImageCount} failed and excluded from diagnosis` : ""}`
        : "no supported images",
    );
    if (approvedImages.length && !successfulImages.length && !hasDiagnosticEvidence(traceInput, textEvidence))
      throw new Error("所有图片均未识别到可用证据，无法仅根据客户描述诊断；请补充清晰截图或原始请求、响应与日志。");
    const knowledgeQueryList = knowledgeQueries(
      enrichedTrace,
      allFindings as Finding[],
      successfulImages,
    );
    activeNode = "retrieval";
    await markWorkflowStep(runId, "retrieval", "running");
    const retrieval = await searchKnowledgeQueries(knowledgeQueryList.map((item) => item.value), trace.provider ?? undefined).catch(() => ({ items: [], meta: { vendor: null, fallbackToAll: false, vendorHitCount: 0, fallbackHitCount: 0, backend: "unavailable" as const, error: "search backend unavailable" } }));
    const knowledge = retrieval.items;
    await markWorkflowStep(runId, "retrieval", retrieval.meta.backend === "unavailable" ? "skipped" : "completed", retrieval.meta.backend === "unavailable" ? "knowledge search unavailable" : `${knowledge.length} document(s) selected`);
    activeNode = "model";
    if (modelCheckpoint?.state !== "model_completed")
      await markWorkflowStep(runId, "model", "running");
    let report = await generateDiagnosisReport({
      traceInput, allFindings, successfulImages, imageIssues, textEvidence, knowledge,
      reasoningEffort, model,
      checkpoint: modelCheckpoint?.state === "model_completed" ? modelCheckpoint.output : undefined,
      signal,
    });
    await markWorkflowStep(runId, "model", "completed", "model report received");
    await db
      .update(diagnosisRuns)
      .set({ report: { state: "model_completed", output: report, jobId: effectiveJobId } })
      .where(eq(diagnosisRuns.id, runId));
    activeNode = "validate_and_persist";
    await markWorkflowStep(runId, "validate_and_persist", "running");
    validateEvidence(report, {
      ruleIds: new Set(allFindings.map((finding) => finding.ruleId)),
      knowledgeIds: new Set(knowledge.slice(0, 5).map((item) => item.id)),
      imageIds: new Set(successfulImages.flatMap((image) => [image.id, ...(image.fields ?? []).map((_, index) => `${image.id}[${index}]`)])),
      textEvidenceIds: new Set(textEvidence.map((item) => item.id)),
      traceReferences: traceReferenceSet(traceInput),
    });
    activeNode = "adjudicate";
    await markWorkflowStep(runId, "adjudicate", "running");
    const imageBlockers = imageIssues.map((issue) => `image:${issue.id}：${issue.status === "skipped" ? "未处理" : "未识别"}，该图片未纳入诊断，请核对原图或补充可读证据。`);
    report = { ...report, missing_evidence: [...imageBlockers, ...report.missing_evidence].slice(0, 8) };
    const adjudication = adjudicateReport(report, allFindings, imageBlockers);
    await markWorkflowStep(
      runId,
      "adjudicate",
      "completed",
      `${adjudication.conclusionStatus}; ${adjudication.blockers.length} confirmation blocker(s)`,
    );
    await db.transaction(async (tx) => {
      await tx
        .update(diagnosisRuns)
        .set({
          report: { ...report, jobId: effectiveJobId, customer_message: adjudication.customerMessage, conclusion_status: adjudication.conclusionStatus, confirmation_blockers: adjudication.blockers, evidence_ledger: buildEvidenceLedger(traceInput, allFindings, textEvidence, successfulImages), retrieval: { queryCount: knowledgeQueryList.length, queryKinds: Object.fromEntries(knowledgeQueryList.reduce((counts, item) => counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1), new Map<string, number>())), vendor: retrieval.meta.vendor, vendorHitCount: retrieval.meta.vendorHitCount, fallbackToAll: retrieval.meta.fallbackToAll, fallbackHitCount: retrieval.meta.fallbackHitCount, finalDocumentCount: knowledge.length, backend: retrieval.meta.backend, ...(retrieval.meta.error ? { error: retrieval.meta.error } : {}) } },
          durationMs: Date.now() - started,
          status: "completed",
        })
        .where(eq(diagnosisRuns.id, runId));
      await tx
        .update(cases)
        .set({
          status: "completed",
          summary: report.summary,
          finalConclusion: adjudication.conclusionStatus === "confirmed" ? report.root_cause : "初步诊断，待人工确认。",
          updatedAt: new Date(),
        })
        .where(eq(cases.id, caseId));
      const citedIds = knowledgeCitationIds(report.confirmed_evidence);
      const refs = knowledge
        .filter((item) => citedIds.has(item.id))
        .map((x) => ({
          diagnosisId: runId,
          title: x.title,
          url: x.sourceUrl,
          vendor: x.vendor,
          category: x.category,
          excerpt: x.excerpt ?? x.body.slice(0, 1200),
        }));
      if (refs.length) await tx.insert(citations).values(refs);
    });
    await markWorkflowStep(runId, "validate_and_persist", "completed", "report and citations saved").catch(() => undefined);
    return { runId, report };
  } catch (error) {
    const cancelled =
      signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = cancelled
      ? "AI diagnosis cancelled."
      : error instanceof Error
        ? error.message
        : "AI diagnosis failed.";
    await markWorkflowStep(runId, activeNode, "failed", workflowSummary(error)).catch(() => undefined);
    await db.transaction(async (tx) => {
      await tx
        .update(diagnosisRuns)
        .set({
          report: { state: cancelled ? "cancelled" : "failed", error: message, jobId: effectiveJobId },
          durationMs: Date.now() - started,
          status: cancelled ? "cancelled" : "failed",
        })
        .where(eq(diagnosisRuns.id, runId));
      await tx
        .update(cases)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(cases.id, caseId));
    });
    throw new Error(message);
  }
}
