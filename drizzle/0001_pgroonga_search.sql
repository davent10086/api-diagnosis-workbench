CREATE EXTENSION IF NOT EXISTS pgroonga;
CREATE INDEX "document_chunks_body_pgroonga_idx" ON "document_chunks" USING pgroonga ("body" pgroonga_text_full_text_search_ops_v2);
