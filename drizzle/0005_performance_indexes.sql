CREATE INDEX IF NOT EXISTS "cases_status_updated_idx" ON "cases" ("status", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "rule_findings_case_idx" ON "rule_findings" ("case_id");
CREATE INDEX IF NOT EXISTS "diagnosis_runs_case_created_idx" ON "diagnosis_runs" ("case_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "citations_diagnosis_idx" ON "citations" ("diagnosis_id");
