import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

const configured = process.env.DATABASE_URL;
if (!configured) throw new Error("DATABASE_URL is required for test:full.");
if (!process.env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is required for test:full.");
if (!process.env.NEW_API_ACCESS_TOKEN) throw new Error("NEW_API_ACCESS_TOKEN is required for test:full.");
const testUrl = new URL(configured);
const database = testUrl.pathname.slice(1);
testUrl.pathname = `/${database.endsWith("_test") ? database : `${database}_test`}`;
const testEnv = { ...process.env, DATABASE_URL: testUrl.toString(), DASHSCOPE_API_KEY: "", RUN_LIVE_LLM_TESTS: "0" };
const appUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:3002";
const children: ChildProcess[] = [];

async function reachable(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

async function waitReady(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await reachable(url)) return;
    if (child.exitCode !== null) throw new Error(`Local app exited before ${url} became ready.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Local app did not become ready at ${url} within 60 seconds.`);
}

function stage(name: string, args: string[], env = process.env) {
  const started = Date.now();
  console.log(`[test:full] ${name}: started`);
  const result = spawnSync("npm", args, { cwd: process.cwd(), env, stdio: "inherit", shell: process.platform === "win32" });
  console.log(`[test:full] ${name}: ${result.status === 0 ? "passed" : "failed"} (${Date.now() - started} ms)`);
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status ?? "unknown"}.`);
}

function background(args: string[]) {
  const child = spawn("npm", args, { cwd: process.cwd(), env: process.env, shell: process.platform === "win32", windowsHide: true, stdio: "ignore" });
  children.push(child);
  return child;
}

async function assertQueueIdle() {
  const client = new Client({ connectionString: configured });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>("SELECT count(*) AS count FROM pgboss.job WHERE name = 'diagnose-case' AND state IN ('created', 'retry', 'active')");
    if (Number(result.rows[0]?.count) !== 0) throw new Error("Diagnosis queue contains pending jobs; worker startup refused.");
  } finally { await client.end(); }
}

async function main() {
  try {
    const gatewayUrl = process.env.NEW_API_BASE_URL || "http://127.0.0.1:3000";
    if (!(await reachable(gatewayUrl))) throw new Error(`new-api is unavailable at ${gatewayUrl}.`);
    if (!(await reachable(appUrl))) {
      if (process.env.E2E_BASE_URL) throw new Error(`Configured E2E_BASE_URL is unavailable: ${appUrl}.`);
      console.log("[test:full] starting local app on port 3002");
      await waitReady(appUrl, background(["run", "dev", "--", "--port", "3002"]));
    }
    stage("test database", ["run", "db:test:prepare"]);
    stage("lint", ["run", "lint"]);
    stage("types", ["run", "typecheck"]);
    stage("unit tests", ["run", "test:unit"], testEnv);
    stage("database integration", ["run", "test:integration"], testEnv);
    stage("browser checks", ["run", "test:e2e"], { ...testEnv, E2E_BASE_URL: appUrl });
    await assertQueueIdle();
    background(["exec", "--", "tsx", "src/worker.ts"]);
    stage("live local chain", ["exec", "--", "tsx", "tests/helpers/live-chain.ts"], { ...process.env, E2E_BASE_URL: appUrl });
  } finally {
    for (const child of children.reverse()) {
      if (!child.pid) continue;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    }
  }
}

void main().catch((error) => {
  console.error(`[test:full] ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = 1;
});
