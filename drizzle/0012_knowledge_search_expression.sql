DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgroonga') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS document_chunks_text_pgroonga_idx ON document_chunks USING pgroonga ((coalesce(title, '''') || '' '' || coalesce(category, '''') || '' '' || coalesce(body, '''')) pgroonga_text_full_text_search_ops_v2)';
  END IF;
END $$;
