ALTER TABLE "document_chunks"
  ADD COLUMN "product" text,
  ADD COLUMN "api_type" text,
  ADD COLUMN "models" jsonb,
  ADD COLUMN "language" text,
  ADD COLUMN "document_version" text,
  ADD COLUMN "official_domain" text,
  ADD COLUMN "source_updated_at" timestamp with time zone;

CREATE INDEX "document_chunks_vendor_api_idx" ON "document_chunks" ("vendor", "api_type");
CREATE INDEX "document_chunks_domain_idx" ON "document_chunks" ("official_domain");
