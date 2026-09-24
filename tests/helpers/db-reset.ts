import { Client } from "pg";
import { assertTestDatabase } from "../setup/env";

assertTestDatabase();
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // CASCADE includes pg-boss tables created by queue integration tests.
    await client.query("DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}
void main();
