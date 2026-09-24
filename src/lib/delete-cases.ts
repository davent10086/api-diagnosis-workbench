import { inArray, or } from "drizzle-orm";
import { db } from "@/db/client";
import { isManagedStoragePath } from "@/lib/storage";
import { cleanupPendingFileDeletions } from "@/lib/evidence-cleanup";
import {
  apiTraces,
  caseLinks,
  cases,
  citations,
  diagnosisReviews,
  diagnosisRuns,
  diagnosisWorkflowSteps,
  evidenceAssets,
  pendingFileDeletions,
  extractedFields,
  ruleFindings,
} from "@/db/schema";

export async function deleteCases(caseIds: string[]) {
  if (!caseIds.length) return 0;
  const { count, deletionIds } = await db.transaction(async (tx) => {
    // Read every dependent row in the same transaction that removes it. This
    // prevents a worker from adding a child row between discovery and delete.
    const targets = await tx
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(inArray(cases.id, caseIds))
      .for("update");
    if (targets.some((item) => item.status === "analyzing"))
      throw new Error("Cannot delete a case while diagnosis is running.");
    const assets = await tx
      .select({ id: evidenceAssets.id, filePath: evidenceAssets.filePath })
      .from(evidenceAssets)
      .where(inArray(evidenceAssets.caseId, caseIds));
    const managed = assets.filter((asset) => isManagedStoragePath(asset.filePath));
    const deletions = managed.length
      ? await tx.insert(pendingFileDeletions).values(managed.map((asset) => ({ filePath: asset.filePath }))).returning({ id: pendingFileDeletions.id })
      : [];
    const runs = await tx
      .select({ id: diagnosisRuns.id })
      .from(diagnosisRuns)
      .where(inArray(diagnosisRuns.caseId, caseIds));
    // These tables reference diagnosis_runs without ON DELETE CASCADE. Remove
    // them first so deleting a diagnosed case remains atomic.
    if (runs.length) {
      const runIds = runs.map((run) => run.id);
      await tx.delete(diagnosisWorkflowSteps).where(inArray(diagnosisWorkflowSteps.diagnosisId, runIds));
      await tx.delete(diagnosisReviews).where(inArray(diagnosisReviews.diagnosisId, runIds));
    }
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
    return { count: targets.length, deletionIds: deletions.map((entry) => entry.id) };
  });
  if (deletionIds.length) await cleanupPendingFileDeletions(deletionIds).catch(() => undefined);
  return count;
}
