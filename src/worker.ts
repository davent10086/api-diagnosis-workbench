import { runDiagnosisGraph } from "@/lib/diagnosis-graph";
import { startDiagnosisWorker } from "@/lib/diagnosis-queue";

startDiagnosisWorker(runDiagnosisGraph).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
