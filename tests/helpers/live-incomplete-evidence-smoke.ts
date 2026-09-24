import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { assertTestDatabase } from "../setup/env";

config({ path: ".env.local" });
if (process.env.RUN_LIVE_LLM_TESTS !== "1" || !process.env.DASHSCOPE_API_KEY)
  throw new Error("Set RUN_LIVE_LLM_TESTS=1 and DASHSCOPE_API_KEY to run this smoke test.");
assertTestDatabase();

export async function runLiveDiagnosisSmoke() {
  const [{ db, pool }, schema, { runDiagnosis }, { deleteCases }] = await Promise.all([
    import("@/db/client"),
    import("@/db/schema"),
    import("@/lib/diagnosis"),
    import("@/lib/delete-cases"),
  ]);
  let caseId: string | undefined;
  try {
  const tokenLimitScenario = process.env.LIVE_DIAGNOSIS_SCENARIO === "token-limit";
  const [item] = await db
    .insert(schema.cases)
    .values({ title: `live smoke: ${tokenLimitScenario ? "token-limit" : "incomplete-502"}`, status: "completed" })
    .returning({ id: schema.cases.id });
  caseId = item.id;
  await db.insert(schema.apiTraces).values({
    caseId,
    provider: tokenLimitScenario ? "Anthropic" : "Bedrock",
    route: tokenLimitScenario ? "anthropic" : "bedrock",
    statusCode: tokenLimitScenario ? 400 : 502,
    customerQuestion: tokenLimitScenario
      ? "status_code=400, prompt is too long: 263839 tokens > 200000 maximum"
      : undefined,
  });
  const result = await runDiagnosis(caseId, "low");
  const [run] = await db
    .select({ report: schema.diagnosisRuns.report, status: schema.diagnosisRuns.status })
    .from(schema.diagnosisRuns)
    .where(eq(schema.diagnosisRuns.id, result.runId));
  const report = run.report as Record<string, unknown>;
  const persisted = run.report as Record<string, unknown>;
  console.log(JSON.stringify({
    runStatus: run.status,
    conclusionStatus: persisted.conclusion_status,
    summary: report.summary,
    rootCause: report.root_cause,
    missingEvidence: report.missing_evidence,
  }));
  } finally {
    if (caseId) {
      try {
        await deleteCases([caseId]);
      } catch (error) {
        console.error("live diagnosis cleanup failed", error);
      }
    }
    await pool.end();
  }
}
if (process.argv[1]?.includes("live-incomplete-evidence-smoke"))
  void runLiveDiagnosisSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : "live diagnosis failed");
    process.exitCode = 1;
  });
