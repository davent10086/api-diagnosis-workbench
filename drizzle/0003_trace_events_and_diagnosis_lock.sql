ALTER TABLE "api_traces" ADD COLUMN IF NOT EXISTS "logs" jsonb;
ALTER TABLE "api_traces" ADD COLUMN IF NOT EXISTS "sse" jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS "diagnosis_runs_one_running_per_case_idx"
  ON "diagnosis_runs" ("case_id") WHERE "status" = 'running';
