import { PgBoss } from "pg-boss";

let boss: PgBoss | undefined;
async function getBoss() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!boss) {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    await boss.start();
    await boss.createQueue("diagnose-case");
  }
  return boss;
}
export async function enqueueDiagnosis(caseId: string, reasoningEffort: "low" | "high" | "max") {
  return (await getBoss()).send("diagnose-case", { caseId, reasoningEffort });
}
export async function startDiagnosisWorker(
  run: (caseId: string, reasoningEffort: "low" | "high" | "max") => Promise<unknown>,
) {
  const queue = await getBoss();
  await queue.work<{ caseId: string; reasoningEffort: "low" | "high" | "max" }>(
    "diagnose-case",
    async (jobs) => {
      for (const job of jobs) await run(job.data.caseId, job.data.reasoningEffort);
    },
  );
}
