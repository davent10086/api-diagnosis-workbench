import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { chromium } from "@playwright/test";
import { GatewayFixture } from "./gateway-fixture";
import { eq } from "drizzle-orm";

config({ path: ".env.local" });

const app = process.env.E2E_BASE_URL || "http://127.0.0.1:3002";
const gateway = process.env.NEW_API_BASE_URL || "http://127.0.0.1:3000";
const key = process.env.DASHSCOPE_API_KEY;
if (!key) throw new Error("DASHSCOPE_API_KEY is required for the live chain.");
if (!process.env.NEW_API_ACCESS_TOKEN) throw new Error("NEW_API_ACCESS_TOKEN is required for log import.");

async function main() {
const runId = `full-${randomUUID()}`;
const started = Date.now();
const { db, pool } = await import("@/db/client");
const schema = await import("@/db/schema");
const { deleteCases } = await import("@/lib/delete-cases");
const created: string[] = [];
const fixture = new GatewayFixture(runId);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function stage<T>(name: string, task: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const value = await task();
    console.log(`[${runId}] ${name}: passed (${Date.now() - start} ms)`);
    return value;
  } catch (error) {
    console.error(`[${runId}] ${name}: failed (${Date.now() - start} ms)`);
    throw error;
  }
}

async function expectHttp(response: Response, status: number) {
  if (response.status !== status) throw new Error(`HTTP ${response.status}, expected ${status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

try {
  console.log(`[${runId}] recovery label: ${fixture.label}`);
  await stage("preflight", async () => {
    const [appResponse, gatewayResponse] = await Promise.all([fetch(app), fetch(gateway)]);
    if (!appResponse.ok || !gatewayResponse.ok) throw new Error("Local 3000/3002 services are unavailable.");
    const jobs = await pool.query("SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'diagnose-case' AND state IN ('created', 'retry', 'active')");
    if (jobs.rows[0].count !== 0) throw new Error("Diagnosis queue has pending work; live run refused.");
  });

  const { requestId, errorIds } = await stage("temporary gateway resources and requests", async () => {
    await fixture.setup();
    const success = await fixture.request("success");
    const rateLimit = await fixture.request("rate-limit");
    const badGateway = await fixture.request("upstream-error");
    return { requestId: success, errorIds: [rateLimit, badGateway] };
  });

  async function importLog(requestId: string) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      response = await fetch(`${app}/api/integrations/new-api/log?request_id=${encodeURIComponent(requestId)}`);
      if (response.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!response) throw new Error("No log import response.");
    const data = await expectHttp(response, 200);
    const metadata = data.metadata as Record<string, unknown>;
    if (metadata.requestId !== requestId) throw new Error("Imported Request ID mismatch.");
    return data;
  }

  const imported = await stage("request ID log import", async () => importLog(requestId));
  await stage("documented error log import", async () => {
    const expected = [
      { id: errorIds[0], status: "429", reason: "rate limit" },
      { id: errorIds[1], status: "502", reason: "invalid response" },
    ];
    for (const item of expected) {
      const log = await importLog(item.id);
      const context = String(log.context);
      if (!context.includes(item.status) || !context.toLowerCase().includes(item.reason))
        throw new Error(`Imported error log ${item.status} is missing its status or documented reason.`);
    }
  });

  const caseId = await stage("case creation", async () => {
    const metadata = imported.metadata as Record<string, string>;
    const response = await fetch(`${app}/api/cases`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: runId, trace: {
        requestId: metadata.requestId, upstreamRequestId: metadata.upstreamRequestId,
        model: metadata.model, logs: [String(imported.context)], statusCode: 429,
        customerQuestion: "A gateway request was rate limited; screenshot omits some fields.",
      } }),
    });
    const data = await expectHttp(response, 201);
    if (typeof data.id !== "string") throw new Error("Case ID missing.");
    created.push(data.id);
    return data.id;
  });

  await stage("synthetic screenshot upload", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 760, height: 380 } });
    await page.goto("about:blank");
    await page.setContent(`<body style="font:24px Arial;background:white;color:#111;padding:30px"><h2>API request result</h2><p>Request ID: ${requestId}</p><p>Status: 429 Too Many Requests</p><p>Upstream Request ID: null</p><p>Retry count: null</p></body>`);
    const screenshot = await page.screenshot({ type: "png" });
    const form = new FormData();
    form.set("file", new File([Uint8Array.from(screenshot)], "redacted-gateway-error.png", { type: "image/png" }));
    await expectHttp(await fetch(`${app}/api/cases/${caseId}/evidence`, { method: "POST", body: form }), 201);
    await page.close();
  });

  await stage("case completion", async () => {
    await expectHttp(await fetch(`${app}/api/cases/${caseId}/complete`, { method: "POST" }), 200);
  });

  await stage("worker diagnosis", async () => {
    await expectHttp(await fetch(`${app}/api/cases/${caseId}/diagnosis`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reasoningEffort: "low" }),
    }), 202);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const [run] = await db.select().from(schema.diagnosisRuns).where(eq(schema.diagnosisRuns.caseId, caseId));
      if (run?.status === "completed") {
        const report = run.report as Record<string, unknown>;
        if (!report.summary || !report.root_cause || !Array.isArray(report.confirmed_evidence)) throw new Error("Incomplete report.");
        const ledger = report.evidence_ledger as { id?: string }[] | undefined;
        if (!Array.isArray(ledger) || !ledger.length || !report.confirmed_evidence.length)
          throw new Error("Report has no evidence references.");
        for (const reference of report.confirmed_evidence) {
          const prefix = String(reference).split(/[=\s]/, 1)[0];
          if (!ledger.some((entry) => prefix.startsWith(String(entry.id)))) throw new Error("Report cites evidence absent from its ledger.");
        }
        const [image] = await db.select().from(schema.evidenceAssets).where(eq(schema.evidenceAssets.caseId, caseId));
        const extraction = image?.extraction as { status?: string; fields?: string[] } | undefined;
        if (extraction?.status !== "completed" || !Array.isArray(extraction.fields)) throw new Error("Image extraction did not complete.");
        if (extraction.fields.some((field) => /(?:upstream.?request.?id|retry.?count)\s*[:=]\s*(?!null\b|none\b)\S+/i.test(field)))
          throw new Error("Image extraction invented a value for a null field.");
        const review = await fetch(`${app}/api/cases/${caseId}/diagnosis/review`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ diagnosisId: run.id, verdict: "confirmed", notes: runId }),
        });
        await expectHttp(review, 201);
        return;
      }
      if (run?.status === "failed") throw new Error("Worker diagnosis failed.");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Worker did not complete diagnosis within four minutes.");
  });

  await stage("report display", async () => {
    const page = await browser!.newPage();
    await page.goto(`${app}/cases/${caseId}`);
    await page.getByText(runId).first().waitFor({ timeout: 15_000 });
    await page.close();
  });
  console.log(`[${runId}] complete (${Date.now() - started} ms)`);
} finally {
  await browser?.close();
  const cleanupErrors: string[] = [];
  try { if (created.length) await deleteCases(created); }
  catch (error) { cleanupErrors.push(`case: ${error instanceof Error ? error.message : "failed"}`); }
  try { await fixture.recover(); await fixture.dispose(); }
  catch (error) { cleanupErrors.push(`gateway: ${error instanceof Error ? error.message : "failed"}`); }
  if (cleanupErrors.length) {
    console.error(`[${runId}] cleanup failed; run npm run test:full:cleanup -- ${runId}: ${cleanupErrors.join("; ")}`);
    process.exitCode = 1;
  } else console.log(`[${runId}] cleanup: ${created.length} case(s), gateway resources and logs`);
  await pool.end();
}
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Live chain failed.");
  process.exitCode = 1;
});
