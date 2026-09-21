import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "@/app/api/cases/route";
import { db } from "@/db/client";
import { apiTraces, cases, ruleFindings } from "@/db/schema";

describe("POST /api/cases (real PostgreSQL)", () => {
  const created: string[] = [];
  afterEach(async () => {
    if (!created.length) return;
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
});
