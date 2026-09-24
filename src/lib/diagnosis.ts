import { and, desc, eq, sql } from "drizzle-orm";
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
import { extractImages } from "@/lib/diagnosis-image";
import { assertNotAborted, generateDiagnosisReport, validateEvidence, type AiReport, type ReasoningEffort } from "@/lib/diagnosis-model";
import { knowledgeCitationIds, knowledgeQueries, readTextEvidence, traceReferenceSet } from "@/lib/diagnosis-retrieval";
import type { Finding, Trace } from "@/lib/types";

export { parseAiReport, parseOpenAICompatibleContent, validateEvidence, reasoningEfforts } from "@/lib/diagnosis-model";
export type { AiReport, ReasoningEffort } from "@/lib/diagnosis-model";
export { knowledgeCitationIds, knowledgeQueries } from "@/lib/diagnosis-retrieval";

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
    const images = await extractImages(approvedImages, IMAGE_EXTRACTION_CONCURRENCY, signal);
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
    activeNode = "model";
    if (modelCheckpoint?.state !== "model_completed")
      await markWorkflowStep(run[0].id, "model", "running");
    const report = await generateDiagnosisReport({
      traceInput, allFindings, successfulImages, textEvidence, knowledge,
      reasoningEffort, model,
      checkpoint: modelCheckpoint?.state === "model_completed" ? modelCheckpoint.output : undefined,
      signal,
    });
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
