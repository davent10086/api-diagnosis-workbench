import { afterEach, beforeAll } from "vitest";
import { assertTestDatabase } from "./env";

beforeAll(() => assertTestDatabase());
// Individual integration suites may truncate tables in afterEach. Keeping this
// hook explicit prevents a future suite from silently using a development DB.
afterEach(() => assertTestDatabase());
