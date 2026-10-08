import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { apiTraces, cases, diagnosisRuns, evidenceAssets } from "@/db/schema";
import { runDiagnosis, DiagnosisConflictError, type AiReport } from "@/lib/diagnosis";
import { generateDiagnosisReport } from "@/lib/diagnosis-model";
import { deleteCases } from "@/lib/delete-cases";
import { extractImages } from "@/lib/diagnosis-image";
import { storageFilePath } from "@/lib/storage";

vi.mock("@/lib/diagnosis-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/diagnosis-model")>()),
  generateDiagnosisReport: vi.fn(),
}));
vi.mock("@/lib/knowledge", () => ({
  searchKnowledgeQueries: vi.fn(async () => ({
    items: [],
    meta: { vendor: null, fallbackToAll: false, vendorHitCount: 0, fallbackHitCount: 0, backend: "postgres-contains" },
  })),
}));
vi.mock("@/lib/diagnosis-image", () => ({ extractImages: vi.fn(async () => []) }));

const report: AiReport = {
  summary: "观察到 HTTP 429。",
  root_cause: "上游可能发生限流。",
  severity: "medium",
  fault_layer: "provider",
  confirmed_evidence: ["trace:statusCode"],
  root_cause_evidence: ["trace:statusCode"],
  hypotheses: ["也可能是网关侧限制。"],
  missing_evidence: ["需要上游限流详情。"],
  next_actions: ["核对上游响应。"],
  customer_message: "正在核对限流原因。",
};

describe("diagnosis lifecycle (real PostgreSQL, stubbed model)", () => {
  it("persists model reasoning alongside the adjudicated report", async () => {
    const caseId = await createCase();
    vi.mocked(generateDiagnosisReport).mockResolvedValueOnce({ ...report, model_reasoning: "核对 HTTP 429 的来源后仍需补充配额证据。" });
    const run = await runDiagnosis(caseId);
    const [saved] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, run.runId));
    expect(saved.report).toMatchObject({ model_reasoning: "核对 HTTP 429 的来源后仍需补充配额证据。", conclusion_status: "provisional" });
  });
  const created: string[] = [];

  async function createCase(status = "completed") {
    const [item] = await db.insert(cases).values({ title: "diagnosis lifecycle", status })
      .returning({ id: cases.id });
    created.push(item.id);
    await db.insert(apiTraces).values({ caseId: item.id, statusCode: 429 });
    return item.id;
  }

  beforeEach(() => {
    vi.mocked(extractImages).mockReset();
    vi.mocked(extractImages).mockResolvedValue([]);
    vi.mocked(generateDiagnosisReport).mockReset();
    vi.mocked(generateDiagnosisReport).mockResolvedValue(report);
  });

  async function addImages(caseId: string, count = 1) {
    return db.insert(evidenceAssets).values(Array.from({ length: count }, (_, index) => ({ caseId, filePath: storageFilePath(`${caseId}-${index}.png`), fileHash: "test", evidenceType: "customer_chat", redactionStatus: "direct_upload", uploadedAt: new Date(Date.now() + index) }))).returning({ id: evidenceAssets.id });
  }

  it("blocks a diagnosis when its only evidence is unreadable screenshots", async () => {
    const caseId = await createCase();
    await db.update(apiTraces).set({ statusCode: null, customerQuestion: "截图出现错误" }).where(eq(apiTraces.caseId, caseId));
    await addImages(caseId);
    vi.mocked(extractImages).mockResolvedValue([{ status: "unreadable", error: "模糊" }]);
    await expect(runDiagnosis(caseId)).rejects.toThrow("所有图片均未识别");
    expect(generateDiagnosisReport).not.toHaveBeenCalled();
  });

  it("passes missing images to the model and persists confirmation blockers", async () => {
    const caseId = await createCase();
    const [image] = await addImages(caseId);
    vi.mocked(extractImages).mockResolvedValue([{ status: "failed", error: "vision unavailable" }]);
    const run = await runDiagnosis(caseId);
    expect(generateDiagnosisReport).toHaveBeenCalledWith(expect.objectContaining({ successfulImages: [], imageIssues: [{ id: image.id, status: "failed", reason: "vision unavailable" }] }));
    const [saved] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, run.runId));
    expect(saved.report).toMatchObject({ confirmation_blockers: expect.arrayContaining([expect.stringContaining(`image:${image.id}`)]) });
  });

  it("handles excess screenshots by marking omissions rather than failing the case", async () => {
    const caseId = await createCase();
    const images = await addImages(caseId, 6);
    vi.mocked(extractImages).mockResolvedValue(Array.from({ length: 5 }, () => ({ status: "completed", fields: ["http_status_code=429"] })));
    await runDiagnosis(caseId);
    expect(vi.mocked(extractImages).mock.calls[0][0]).toHaveLength(5);
    expect(generateDiagnosisReport).toHaveBeenCalledWith(expect.objectContaining({ imageIssues: [expect.objectContaining({ id: images[5].id, status: "skipped" })] }));
  });

  it("retains field-level image evidence in the report ledger", async () => {
    const caseId = await createCase();
    const [image] = await addImages(caseId);
    vi.mocked(extractImages).mockResolvedValue([{ status: "completed", fields: ["http_status_code=429"], observations: [{ name: "http_status_code", value: "429", quote: "HTTP 429", location: "顶部" }] }]);
    vi.mocked(generateDiagnosisReport).mockResolvedValue({ ...report, confirmed_evidence: [`image:${image.id}[0]：HTTP 429`], root_cause_evidence: [`image:${image.id}[0]`] });
    const run = await runDiagnosis(caseId);
    const [saved] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, run.runId));
    expect(saved.report).toMatchObject({ evidence_ledger: expect.arrayContaining([expect.objectContaining({ id: `image:${image.id}[0]`, kind: "candidate", statement: expect.stringContaining("原文：HTTP 429") })]) });
  });

  afterEach(async () => {
    if (created.length) {
      await db.update(diagnosisRuns).set({ status: "failed" })
        .where(and(inArray(diagnosisRuns.caseId, created), eq(diagnosisRuns.status, "running")));
      await db.update(cases).set({ status: "completed" }).where(inArray(cases.id, created));
      await deleteCases(created);
      created.length = 0;
    }
  });

  it("persists one run and returns its report on redelivery of the same job", async () => {
    const caseId = await createCase();
    const first = await runDiagnosis(caseId, "low", undefined, "job-redelivery");
    const second = await runDiagnosis(caseId, "low", undefined, "job-redelivery");

    expect(second.runId).toBe(first.runId);
    expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalledTimes(1);
    const runs = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.caseId, caseId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].report).toMatchObject({ jobId: "job-redelivery", conclusion_status: "provisional" });
  });

  it("resumes an interrupted run from its saved model checkpoint", async () => {
    const caseId = await createCase("analyzing");
    const [run] = await db.insert(diagnosisRuns).values({
      caseId, model: "saved-model", reasoningEffort: "low", status: "running",
      report: { state: "model_completed", output: report, jobId: "original-job" },
    }).returning({ id: diagnosisRuns.id });

    const result = await runDiagnosis(caseId, "max", undefined, "redelivered-job");

    expect(result.runId).toBe(run.id);
    expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: report, model: "saved-model", reasoningEffort: "low",
    }));
    const [saved] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, run.id));
    expect(saved.report).toMatchObject({ jobId: "original-job", conclusion_status: "provisional" });
  });

  it("allows only one worker to execute a case at a time", async () => {
    const caseId = await createCase();
    let release!: (value: AiReport) => void;
    vi.mocked(generateDiagnosisReport).mockImplementationOnce(() => new Promise<AiReport>((resolve) => { release = resolve; }));
    const first = runDiagnosis(caseId, "low", undefined, "first-job");
    try {
      await vi.waitFor(() => expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalledTimes(1));
      await expect(runDiagnosis(caseId, "low", undefined, "second-job"))
        .rejects.toBeInstanceOf(DiagnosisConflictError);
    } finally {
      release?.(report);
      await first;
    }
    expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalledTimes(1);
  });

  it("clears the running state when preparation fails before model execution", async () => {
    const [item] = await db.insert(cases).values({ title: "missing trace", status: "completed" })
      .returning({ id: cases.id });
    created.push(item.id);

    await expect(runDiagnosis(item.id, "low", undefined, "missing-trace-job"))
      .rejects.toThrow("Case has no trace.");
    const [savedCase] = await db.select().from(cases).where(eq(cases.id, item.id));
    const [savedRun] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.caseId, item.id));
    expect(savedCase.status).toBe("completed");
    expect(savedRun.status).toBe("failed");
    expect(vi.mocked(generateDiagnosisReport)).not.toHaveBeenCalled();
  });

  it("releases the claim after a model failure so the same job can retry", async () => {
    const caseId = await createCase();
    vi.mocked(generateDiagnosisReport).mockRejectedValueOnce(new Error("upstream unavailable"));

    await expect(runDiagnosis(caseId, "low", undefined, "retry-job"))
      .rejects.toThrow("upstream unavailable");
    const retried = await runDiagnosis(caseId, "low", undefined, "retry-job");

    const runs = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.caseId, caseId));
    expect(runs.map((run) => run.status).sort()).toEqual(["completed", "failed"]);
    expect(runs.find((run) => run.status === "completed")?.id).toBe(retried.runId);
    expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalledTimes(2);
  });
});
