import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { access, utimes, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { POST } from "@/app/api/cases/route";
import { db } from "@/db/client";
import {
  apiTraces,
  cases,
  diagnosisReviews,
  diagnosisRuns,
  diagnosisWorkflowSteps,
  evidenceAssets,
  pendingFileDeletions,
  ruleFindings,
} from "@/db/schema";
import { deleteCases } from "@/lib/delete-cases";
import { cleanupOrphanEvidenceFiles, cleanupPendingFileDeletions } from "@/lib/evidence-cleanup";
import { storageFilePath } from "@/lib/storage";

describe("POST /api/cases (real PostgreSQL)", () => {
  const created: string[] = [];
  afterEach(async () => {
    if (created.length) await deleteCases(created);
    created.length = 0;
  });

  it("persists only a redacted trace and deterministic findings in one request", async () => {
    const request = new Request("http://test/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "redaction integration", trace: { route: "bedrock", statusCode: 400, clientRequest: { authorization: "Bearer definitely-not-real-value", tools: [{ type: "web_search_20250305" }] }, upstreamResponse: { type: "ValidationException" } } }),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    created.push(body.id);
    const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, body.id));
    expect(JSON.stringify(trace)).not.toContain("definitely-not-real-value");
    const findings = await db.select().from(ruleFindings).where(eq(ruleFindings.caseId, body.id));
    expect(findings.some(x => x.ruleId === "bedrock-tool-compatibility")).toBe(true);
  });

  it("clears a case that has durable workflow and human review records", async () => {
    const [item] = await db.insert(cases).values({ title: "deletion graph", status: "completed" }).returning({ id: cases.id });
    created.push(item.id);
    const [run] = await db.insert(diagnosisRuns).values({ caseId: item.id, report: {}, status: "completed" }).returning({ id: diagnosisRuns.id });
    await db.insert(diagnosisWorkflowSteps).values({ diagnosisId: run.id, nodeName: "prepare", status: "completed" });
    await db.insert(diagnosisReviews).values({ diagnosisId: run.id, verdict: "confirmed" });
    expect(await deleteCases([item.id])).toBe(1);
    created.length = 0;
    expect(await db.select({ id: cases.id }).from(cases).where(eq(cases.id, item.id))).toEqual([]);
  });

  it("removes managed evidence and keeps failed deletions retryable", async () => {
    const [item] = await db.insert(cases).values({ title: "evidence lifecycle" }).returning({ id: cases.id });
    created.push(item.id);
    const path = storageFilePath(`${randomUUID()}-evidence.txt`);
    await writeFile(path, "redacted evidence");
    await db.insert(evidenceAssets).values({ caseId: item.id, filePath: path, fileHash: "test", evidenceType: "other", redactionStatus: "redacted" });
    expect(await deleteCases([item.id])).toBe(1);
    created.length = 0;
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.filePath, path))).toEqual([]);

    const retryPath = storageFilePath(`${randomUUID()}-retry.txt`);
    await writeFile(retryPath, "redacted evidence");
    const [pending] = await db.insert(pendingFileDeletions).values({ filePath: retryPath }).returning({ id: pendingFileDeletions.id });
    expect((await cleanupPendingFileDeletions([pending.id], async () => { throw new Error("file locked"); })).pending).toBe(1);
    await access(retryPath);
    expect((await cleanupPendingFileDeletions([pending.id])).deleted).toBe(1);
    await expect(access(retryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps only old unreferenced managed files", async () => {
    const [item] = await db.insert(cases).values({ title: "orphan sweep" }).returning({ id: cases.id });
    created.push(item.id);
    const retained = storageFilePath(`${randomUUID()}-retained.txt`);
    const orphan = storageFilePath(`${randomUUID()}-orphan.txt`);
    await Promise.all([writeFile(retained, "retained"), writeFile(orphan, "orphan")]);
    await db.insert(evidenceAssets).values({ caseId: item.id, filePath: retained, fileHash: "test", evidenceType: "other", redactionStatus: "redacted" });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Promise.all([utimes(retained, old, old), utimes(orphan, old, old)]);
    expect(await cleanupOrphanEvidenceFiles()).toBe(1);
    await access(retained);
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
