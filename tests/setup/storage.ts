import { afterAll, beforeEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), process.env.STORAGE_ROOT || "storage-test");
if (!root.endsWith("storage-test")) throw new Error("Refusing to clean a non-test storage directory.");
beforeEach(async () => { await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true }); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
