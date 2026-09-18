DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgroonga') THEN
    CREATE EXTENSION IF NOT EXISTS pgroonga;
    EXECUTE 'CREATE INDEX IF NOT EXISTS document_chunks_body_pgroonga_idx ON document_chunks USING pgroonga (body pgroonga_text_full_text_search_ops_v2)';
  END IF;
END $$;
