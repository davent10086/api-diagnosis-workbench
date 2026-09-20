DROP INDEX IF EXISTS "document_chunks_vendor_api_idx";
DROP INDEX IF EXISTS "document_chunks_domain_idx";

ALTER TABLE "document_chunks"
  DROP COLUMN IF EXISTS "product",
  DROP COLUMN IF EXISTS "api_type",
  DROP COLUMN IF EXISTS "models",
  DROP COLUMN IF EXISTS "language",
  DROP COLUMN IF EXISTS "document_version",
  DROP COLUMN IF EXISTS "official_domain",
  DROP COLUMN IF EXISTS "source_updated_at";
