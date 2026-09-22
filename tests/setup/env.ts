import { config } from "dotenv";

config({ path: ".env.local" });
/** Safe defaults shared by every test process. Never load customer fixtures or keys. */
process.env.RUN_LIVE_LLM_TESTS ??= "0";
// Unit, integration and browser suites must never inherit a real key. The
// dedicated contract command is the sole explicit opt-in exception.
if (process.env.RUN_LIVE_LLM_TESTS !== "1") process.env.DASHSCOPE_API_KEY = "";
process.env.STORAGE_ROOT ??= "storage-test";

export function assertTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url || !/(?:[_-]test)(?:[/?#]|$)/i.test(url))
    throw new Error("Refusing test database operation: DATABASE_URL must name a database ending in _test.");
}
