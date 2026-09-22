import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "@/app/api/cases/route";
import { db } from "@/db/client";
import {
  apiTraces,
  cases,
  diagnosisReviews,
  diagnosisRuns,
  diagnosisWorkflowSteps,
  ruleFindings,
} from "@/db/schema";
import { deleteCases } from "@/lib/delete-cases";

describe("POST /api/cases (real PostgreSQL)", () => {
  const created: string[] = [];
  afterEach(async () => {
    if (!created.length) return;
    const runs = await db.select({ id: diagnosisRuns.id }).from(diagnosisRuns).where(eq(diagnosisRuns.caseId, created[0]));
    if (runs.length) {
      const ids = runs.map((run) => run.id);
      await db.delete(diagnosisWorkflowSteps).where(eq(diagnosisWorkflowSteps.diagnosisId, ids[0]));
      await db.delete(diagnosisReviews).where(eq(diagnosisReviews.diagnosisId, ids[0]));
    }
    await db.delete(ruleFindings).where(eq(ruleFindings.caseId, created[0]));
    await db.delete(apiTraces).where(eq(apiTraces.caseId, created[0]));
    await db.delete(cases).where(eq(cases.id, created[0]));
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
});
