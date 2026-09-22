import { config } from "dotenv";

config({ path: ".env.local" });
const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is not configured.");

const testUrl = new URL(configuredUrl);
const configuredName = testUrl.pathname.slice(1);
const databaseName = configuredName.endsWith("_test") ? configuredName : `${configuredName}_test`;
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe test database name.");
testUrl.pathname = `/${databaseName}`;

async function main() {
  process.env.DATABASE_URL = testUrl.toString();
  process.env.RUN_LIVE_LLM_TESTS = "1";
  const { runLiveDiagnosisSmoke } = await import("../../tests/helpers/live-incomplete-evidence-smoke");
  await runLiveDiagnosisSmoke();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "live diagnosis failed");
  process.exitCode = 1;
});
