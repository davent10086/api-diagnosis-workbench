import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

config({ path: ".env.local" });

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is not configured.");
const testUrl = new URL(configuredUrl);
const databaseName = testUrl.pathname.slice(1);
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe test database name.");
testUrl.pathname = `/${databaseName.endsWith("_test") ? databaseName : `${databaseName}_test`}`;
process.env.DATABASE_URL = testUrl.toString();
if (!testUrl.pathname.endsWith("_test")) throw new Error("Refusing to run outside a test database.");
if (!process.env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is required for live diagnosis.");

const batchId = randomUUID().slice(0, 8);
const scenarios = [
  {
    id: "incomplete-502",
    title: "502 缺少上游响应",
    trace: {
      provider: "Bedrock", route: "bedrock", statusCode: 502,
      customerQuestion: "网关返回 502，但没有保存上游响应；请区分已知事实与猜测。",
      logs: ["synthetic gateway log: forwarding request failed with HTTP 502"],
    },
    expectedRule: "http-5xx",
    expectedBlocker: true,
  },
  {
    id: "incomplete-429",
    title: "429 缺少重试上下文",
    trace: {
      provider: "OpenAI", route: "/v1/chat/completions", statusCode: 429,
      customerQuestion: "请求返回 429；当前没有 retry_count 或 Retry-After 记录。",
      upstreamResponse: { error: { type: "rate_limit_error", message: "Rate limit reached for this request." } },
    },
    expectedRule: "http-429",
    expectedBlocker: true,
  },
  {
    id: "bedrock-tool-incompatible",
    title: "Bedrock 工具类型不兼容",
    trace: {
      provider: "Bedrock", route: "bedrock", statusCode: 400,
      customerQuestion: "使用 web_search_20250305 工具后，上游返回 ValidationException。",
      clientRequest: { tools: [{ type: "web_search_20250305" }] },
      upstreamResponse: { error: { type: "ValidationException", message: "Tool type web_search_20250305 is not supported by this Bedrock model." } },
    },
    expectedRule: "bedrock-tool-compatibility",
    expectedBlocker: false,
  },
  {
    id: "context-window-exceeded",
    title: "输入 token 超过上下文窗口",
    trace: {
      provider: "OpenAI", route: "/v1/chat/completions", statusCode: 400,
      customerQuestion: "上游明确报告 context_length_exceeded；请指出限制与下一步动作。",
      upstreamResponse: { error: { code: "context_length_exceeded", message: "Maximum context length is 128000 tokens; requested 134000 tokens." } },
    },
    expectedRule: "context-window-exceeded",
    expectedBlocker: false,
  },
] as const;

async function main() {
  const [{ db, pool }, { cases, apiTraces, diagnosisRuns, ruleFindings }, { runDiagnosis }] = await Promise.all([
    import("@/db/client"), import("@/db/schema"), import("@/lib/diagnosis"),
  ]);
  const results: Record<string, unknown>[] = [];
  try {
    const selected = scenarios.filter((scenario) => !process.env.LIVE_DIAGNOSIS_SCENARIO || scenario.id === process.env.LIVE_DIAGNOSIS_SCENARIO);
    if (!selected.length) throw new Error("No matching live diagnosis scenario.");
    for (const scenario of selected) {
      const [item] = await db.insert(cases).values({
        title: `live test ${batchId}: ${scenario.title}`, status: "completed",
      }).returning({ id: cases.id });
      await db.insert(apiTraces).values({
        caseId: item.id,
        requestId: `synthetic-${batchId}-${scenario.id}`,
        ...scenario.trace,
      });
      try {
        const { runId } = await runDiagnosis(item.id, "low");
        const [run] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, runId));
        const findings = await db.select({ ruleId: ruleFindings.ruleId, needsMoreEvidence: ruleFindings.needsMoreEvidence })
          .from(ruleFindings).where(eq(ruleFindings.caseId, item.id));
        const report = run.report as Record<string, unknown>;
        const blockers = Array.isArray(report.confirmation_blockers) ? report.confirmation_blockers.map(String) : [];
        const checks = {
          completed: run.status === "completed",
          reasoningSaved: typeof report.model_reasoning === "string" && report.model_reasoning.trim().length > 0,
          expectedRuleFound: findings.some((finding) => finding.ruleId === scenario.expectedRule),
          remainsUnconfirmed: report.conclusion_status !== "confirmed",
          expectedBlocker: !scenario.expectedBlocker || blockers.some((blocker) => blocker.includes(scenario.expectedRule)),
        };
        results.push({ scenario: scenario.id, caseId: item.id, runId, checks, findings, report });
        console.log(JSON.stringify({ scenario: scenario.id, caseId: item.id, checks,
          conclusionStatus: report.conclusion_status, rootCause: report.root_cause }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        results.push({ scenario: scenario.id, caseId: item.id, error: message });
        console.error(JSON.stringify({ scenario: scenario.id, caseId: item.id, error: message }));
      }
    }
    await mkdir("test-results", { recursive: true });
    const output = join("test-results", `live-diagnosis-${batchId}.json`);
    await writeFile(output, JSON.stringify({ batchId, database: testUrl.pathname.slice(1), results }, null, 2));
    console.log(`Detailed synthetic results: ${output}`);
    if (results.some((result) => "error" in result || Object.values(result.checks as Record<string, boolean>).some((passed) => !passed)))
      process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "live diagnosis failed");
  process.exitCode = 1;
});
