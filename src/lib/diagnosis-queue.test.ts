import { afterEach, describe, expect, it, vi } from "vitest";
import { startDiagnosisWorker } from "./diagnosis-queue";

const boss = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  createQueue: vi.fn(async () => undefined),
  work: vi.fn(async (_name: string, handler: (jobs: {
    id: string;
    data: { caseId: string; reasoningEffort: "low" | "high" | "max" };
  }[]) => Promise<void>) => {
    await handler([{ id: "job-123", data: { caseId: "case-123", reasoningEffort: "high" } }]);
  }),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    start = boss.start;
    createQueue = boss.createQueue;
    work = boss.work;
  },
}));

describe("diagnosis queue handoff", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("passes the durable queue job ID to diagnosis for idempotent redelivery", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/diagnosis_unit_test");
    const run = vi.fn(async () => undefined);

    await startDiagnosisWorker(run);

    expect(boss.work).toHaveBeenCalledWith("diagnose-case", expect.any(Function));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("case-123", "high", undefined, "job-123");
  });
});
