-- Existing timestamp values were written while PostgreSQL used Asia/Shanghai.
-- Preserve their wall-clock meaning while converting them to absolute instants.
ALTER TABLE "cases"
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'Asia/Shanghai',
  ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'Asia/Shanghai';

ALTER TABLE "evidence_assets"
  ALTER COLUMN "uploaded_at" TYPE timestamp with time zone USING "uploaded_at" AT TIME ZONE 'Asia/Shanghai';

ALTER TABLE "diagnosis_runs"
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'Asia/Shanghai';

ALTER TABLE "document_chunks"
  ALTER COLUMN "fetched_at" TYPE timestamp with time zone USING "fetched_at" AT TIME ZONE 'Asia/Shanghai';
