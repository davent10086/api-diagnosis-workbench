import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { evidenceAssets, pendingFileDeletions } from "@/db/schema";
import { isManagedStoragePath, storageRoot } from "@/lib/storage";

const orphanAgeMs = 60 * 60 * 1000;
const managedName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

export async function cleanupPendingFileDeletions(ids?: string[], removeFile: (path: string) => Promise<void> = (path) => rm(path, { force: true })) {
  const entries = await db.select().from(pendingFileDeletions)
    .where(ids?.length ? inArray(pendingFileDeletions.id, ids) : undefined)
    .limit(500);
  let deleted = 0;
  for (const entry of entries) {
    if (!isManagedStoragePath(entry.filePath) || !managedName.test(basename(entry.filePath))) continue;
    try {
      await removeFile(entry.filePath);
      await db.delete(pendingFileDeletions).where(inArray(pendingFileDeletions.id, [entry.id]));
      deleted += 1;
    } catch {
      // Leave the durable record for the next sweep.
    }
  }
  return { deleted, pending: entries.length - deleted };
}

export async function cleanupOrphanEvidenceFiles(now = Date.now()) {
  const root = resolve(storageRoot());
  let names: string[];
  try { names = await readdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const [assets, pending] = await Promise.all([
    db.select({ filePath: evidenceAssets.filePath }).from(evidenceAssets),
    db.select({ filePath: pendingFileDeletions.filePath }).from(pendingFileDeletions),
  ]);
  const retained = new Set([...assets, ...pending].map((item) => resolve(process.cwd(), item.filePath)));
  let deleted = 0;
  for (const name of names) {
    if (!managedName.test(name)) continue;
    const path = join(root, name);
    if (retained.has(path)) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile() || now - info.mtimeMs < orphanAgeMs) continue;
      // A recent upload cannot be collected; UUID filenames are never reused.
      await rm(path);
      deleted += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return deleted;
}

export async function sweepEvidenceStorage() {
  const pending = await cleanupPendingFileDeletions();
  const orphans = await cleanupOrphanEvidenceFiles();
  return { ...pending, orphans };
}
