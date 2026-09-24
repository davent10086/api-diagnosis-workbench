CREATE TABLE IF NOT EXISTS "pending_file_deletions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
