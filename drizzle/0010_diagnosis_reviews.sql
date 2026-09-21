CREATE TABLE "diagnosis_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "diagnosis_id" uuid NOT NULL REFERENCES "diagnosis_runs"("id"),
  "verdict" text NOT NULL,
  "corrected_root_cause" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "diagnosis_reviews_diagnosis_idx"
  ON "diagnosis_reviews" ("diagnosis_id");
