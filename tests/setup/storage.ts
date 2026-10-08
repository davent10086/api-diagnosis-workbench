import { afterAll, beforeEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const configured = resolve(process.cwd(), process.env.STORAGE_ROOT || "storage-test");
const base = /[\\/]worker-\d+$/.test(configured) ? dirname(configured) : configured;
if (!base.endsWith("storage-test")) throw new Error("Refusing to clean a non-test storage directory.");
const root = join(base, `worker-${process.pid}`);
process.env.STORAGE_ROOT = root;
beforeEach(async () => { await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true }); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
