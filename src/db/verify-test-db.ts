import { config } from "dotenv";
import { count, like } from "drizzle-orm";

config({ path: ".env.local" });
const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is not configured.");
const testUrl = new URL(configuredUrl);
const configuredName = testUrl.pathname.slice(1);
testUrl.pathname = `/${configuredName.endsWith("_test") ? configuredName : `${configuredName}_test`}`;
process.env.DATABASE_URL = testUrl.toString();

async function main() {
  const [{ db, pool }, { cases }] = await Promise.all([import("@/db/client"), import("@/db/schema")]);
  try {
    const [row] = await db.select({ total: count() }).from(cases).where(like(cases.title, "live smoke:%"));
    if (Number(row.total) !== 0) throw new Error("Live-smoke cases remain in the test database.");
    console.log("Test database cleanup verified.");
  } finally {
    await pool.end();
  }
}

void main();
