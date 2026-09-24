import { runDiagnosis } from "@/lib/diagnosis";
import { startDiagnosisWorker } from "@/lib/diagnosis-queue";
import { sweepEvidenceStorage } from "@/lib/evidence-cleanup";

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await sweepEvidenceStorage();
    if (result.pending || result.deleted || result.orphans)
      console.info(`Evidence cleanup: ${result.deleted} deleted, ${result.orphans} orphan(s), ${result.pending} pending.`);
  } catch (error) {
    console.error("Evidence cleanup failed:", error instanceof Error ? error.message : "unknown error");
  } finally { sweeping = false; }
}
void sweep();
setInterval(() => { void sweep(); }, 5 * 60_000).unref();
startDiagnosisWorker(runDiagnosis).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
