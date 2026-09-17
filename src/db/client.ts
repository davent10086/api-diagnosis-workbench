import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
config({ path: ".env.local" });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 未配置");
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
