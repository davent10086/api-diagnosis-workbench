CREATE TABLE "diagnosis_workflow_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "diagnosis_id" uuid NOT NULL REFERENCES "diagnosis_runs"("id"),
  "node_name" text NOT NULL,
  "status" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "summary" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);

CREATE UNIQUE INDEX "diagnosis_workflow_steps_run_node_idx"
  ON "diagnosis_workflow_steps" ("diagnosis_id", "node_name");
CREATE INDEX "diagnosis_workflow_steps_diagnosis_idx"
  ON "diagnosis_workflow_steps" ("diagnosis_id");
