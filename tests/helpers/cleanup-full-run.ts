import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { GatewayFixture } from "./gateway-fixture";

config({ path: ".env.local" });

const runId = process.argv[2];
if (!runId || !/^full-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId))
  throw new Error("Usage: npm run test:full:cleanup -- full-<UUID>");

async function main() {
  const { db, pool } = await import("@/db/client");
  const { cases } = await import("@/db/schema");
  const { deleteCases } = await import("@/lib/delete-cases");
  const fixture = new GatewayFixture(runId);
  const errors: string[] = [];
  try {
    const rows = await db.select({ id: cases.id }).from(cases).where(eq(cases.title, runId));
    try { await deleteCases(rows.map((row) => row.id)); }
    catch (error) { errors.push(`case cleanup: ${error instanceof Error ? error.message : "failed"}`); }
    try { await fixture.recover(); await fixture.dispose(); }
    catch (error) { errors.push(`gateway cleanup: ${error instanceof Error ? error.message : "failed"}`); }
    console.log(`[${runId}] recovery cleanup: ${rows.length} case(s), gateway label ${fixture.label}`);
    if (errors.length) throw new Error(errors.join("; "));
  } finally { await pool.end(); }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Recovery cleanup failed.");
  process.exitCode = 1;
});
