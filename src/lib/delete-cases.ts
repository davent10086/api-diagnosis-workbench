import { rm } from "fs/promises";
import { join } from "path";
import { inArray, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  apiTraces,
  caseLinks,
  cases,
  citations,
  diagnosisRuns,
  evidenceAssets,
  extractedFields,
  ruleFindings,
} from "@/db/schema";

export async function deleteCases(caseIds: string[]) {
  if (!caseIds.length) return 0;
  const assets = await db
    .select({ id: evidenceAssets.id, filePath: evidenceAssets.filePath })
    .from(evidenceAssets)
    .where(inArray(evidenceAssets.caseId, caseIds));
  const runs = await db
    .select({ id: diagnosisRuns.id })
    .from(diagnosisRuns)
    .where(inArray(diagnosisRuns.caseId, caseIds));
  await db.transaction(async (tx) => {
    if (runs.length)
      await tx.delete(citations).where(
        inArray(
          citations.diagnosisId,
          runs.map((run) => run.id),
        ),
      );
    if (assets.length)
      await tx.delete(extractedFields).where(
        inArray(
          extractedFields.evidenceId,
          assets.map((asset) => asset.id),
        ),
      );
    await tx.delete(extractedFields).where(inArray(extractedFields.caseId, caseIds));
    await tx
      .delete(caseLinks)
      .where(or(inArray(caseLinks.caseId, caseIds), inArray(caseLinks.linkedCaseId, caseIds)));
    await tx.delete(ruleFindings).where(inArray(ruleFindings.caseId, caseIds));
    await tx.delete(evidenceAssets).where(inArray(evidenceAssets.caseId, caseIds));
    await tx.delete(apiTraces).where(inArray(apiTraces.caseId, caseIds));
    await tx.delete(diagnosisRuns).where(inArray(diagnosisRuns.caseId, caseIds));
    await tx.delete(cases).where(inArray(cases.id, caseIds));
  });
  await Promise.all(
    assets.map((asset) =>
      asset.filePath.startsWith("storage")
        ? rm(join(process.cwd(), asset.filePath), { force: true }).catch(() => undefined)
        : undefined,
    ),
  );
  return caseIds.length;
}
