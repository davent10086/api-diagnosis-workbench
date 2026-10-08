import { readFile, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import type { Finding, Trace } from "@/lib/types";

config({ path: ".env.local" });
const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is not configured.");
const testUrl = new URL(configuredUrl);
const name = testUrl.pathname.slice(1);
if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unsafe test database name.");
testUrl.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
process.env.DATABASE_URL = testUrl.toString();

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Pass the live diagnosis result JSON path.");
  const artifact = JSON.parse(await readFile(file, "utf8")) as {
    batchId: string;
    database: string;
    results: { scenario: string; caseId: string; runId: string; report: Record<string, unknown> }[];
  };
  if (artifact.database !== testUrl.pathname.slice(1)) throw new Error("Result database does not match the test database.");
  const [{ db, pool }, { cases, apiTraces, diagnosisRuns, ruleFindings }, { adjudicateReport }, { reportSchema, validateEvidence }, { traceReferenceSet }] = await Promise.all([
    import("@/db/client"), import("@/db/schema"), import("@/lib/diagnosis-quality"),
    import("@/lib/diagnosis-model"), import("@/lib/diagnosis-retrieval"),
  ]);
  try {
    for (const result of artifact.results) {
      const [item] = await db.select().from(cases).where(eq(cases.id, result.caseId));
      const [run] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, result.runId));
      if (!item?.title.startsWith(`live test ${artifact.batchId}:`) || run?.caseId !== item.id || run.status !== "completed")
        throw new Error(`Unexpected synthetic case or run for ${result.scenario}.`);
      const findings = await db.select().from(ruleFindings).where(eq(ruleFindings.caseId, item.id));
      const [trace] = await db.select().from(apiTraces).where(eq(apiTraces.caseId, item.id));
      const fields = ["customerQuestion", "requestId", "traceId", "upstreamRequestId", "provider",
        "route", "model", "statusCode", "clientRequest", "transformedRequest", "upstreamResponse",
        "finalResponse", "logs", "sse"] as const;
      const traceInput = Object.fromEntries(fields.flatMap((field) => {
        const value = trace?.[field];
        return value === undefined || value === null ? [] : [[field, value]];
      })) as Trace;
      const current = run.report as typeof result.report;
      const parsed = reportSchema.parse(current);
      validateEvidence(parsed, {
        ruleIds: new Set(findings.map((finding) => finding.ruleId)),
        traceReferences: traceReferenceSet(traceInput),
        knowledgeIds: new Set(), imageIds: new Set(), textEvidenceIds: new Set(),
      });
      const adjudication = adjudicateReport(parsed, findings as Finding[]);
      const updated = {
        ...current,
        customer_message: adjudication.customerMessage,
        conclusion_status: adjudication.conclusionStatus,
        confirmation_blockers: adjudication.blockers,
      };
      await db.transaction(async (tx) => {
        await tx.update(diagnosisRuns).set({ report: updated }).where(eq(diagnosisRuns.id, run.id));
        await tx.update(cases).set({
          finalConclusion: adjudication.conclusionStatus === "confirmed" ? String(current.root_cause) : "初步诊断，待人工确认。",
        }).where(eq(cases.id, item.id));
      });
      result.report = updated;
      console.log(JSON.stringify({ scenario: result.scenario, caseId: item.id,
        conclusionStatus: adjudication.conclusionStatus, blockers: adjudication.blockers }));
    }
    await writeFile(file, JSON.stringify(artifact, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "live diagnosis recheck failed");
  process.exitCode = 1;
});
