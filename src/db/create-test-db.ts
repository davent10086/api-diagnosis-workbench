import { spawnSync } from "node:child_process";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is not configured.");

const targetUrl = new URL(configuredUrl);
const configuredName = targetUrl.pathname.slice(1);
const databaseName = configuredName.endsWith("_test") ? configuredName : `${configuredName}_test`;
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe test database name.");

const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const client = new Client({ connectionString: adminUrl.toString() });

async function main() {
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }

  targetUrl.pathname = `/${databaseName}`;
  const migration = spawnSync("npx", ["drizzle-kit", "migrate"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
  });
  if (migration.status !== 0) process.exit(migration.status ?? 1);
  console.log(`Test database ready: ${databaseName}`);
}

void main();
