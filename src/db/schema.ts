import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  boolean,
  index,
  customType,
} from "drizzle-orm/pg-core";
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
export const cases = pgTable("cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  summary: text("summary"),
  finalConclusion: text("final_conclusion"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const evidenceAssets = pgTable(
  "evidence_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .references(() => cases.id)
      .notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    evidenceType: text("evidence_type").notNull(),
    redactionStatus: text("redaction_status").notNull().default("pending"),
    extraction: jsonb("extraction"),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  },
  (t) => [index("evidence_case_idx").on(t.caseId)],
);
export const apiTraces = pgTable(
  "api_traces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .references(() => cases.id)
      .notNull(),
    customerQuestion: text("customer_question"),
    requestId: text("request_id"),
    traceId: text("trace_id"),
    upstreamRequestId: text("upstream_request_id"),
    provider: text("provider"),
    route: text("route"),
    channel: text("channel"),
    model: text("model"),
    statusCode: integer("status_code"),
    retry: jsonb("retry"),
    clientRequest: jsonb("client_request"),
    transformedRequest: jsonb("transformed_request"),
    upstreamResponse: jsonb("upstream_response"),
    finalResponse: jsonb("final_response"),
    logs: jsonb("logs"),
    sse: jsonb("sse"),
  },
  (t) => [
    index("trace_case_idx").on(t.caseId),
    index("trace_request_idx").on(t.requestId),
    index("trace_trace_idx").on(t.traceId),
    index("trace_status_idx").on(t.statusCode),
  ],
);
export const extractedFields = pgTable("extracted_fields", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => cases.id)
    .notNull(),
  evidenceId: uuid("evidence_id").references(() => evidenceAssets.id),
  fieldName: text("field_name").notNull(),
  fieldValue: text("field_value"),
  confidence: real("confidence"),
  sourceCoordinates: jsonb("source_coordinates"),
  humanEdited: boolean("human_edited").default(false),
});
export const ruleFindings = pgTable("rule_findings", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => cases.id)
    .notNull(),
  ruleId: text("rule_id").notNull(),
  severity: text("severity").notNull(),
  faultLayer: text("fault_layer").notNull(),
  evidence: jsonb("evidence"),
  conclusion: text("conclusion").notNull(),
  needsMoreEvidence: boolean("needs_more_evidence").default(false),
});
export const diagnosisRuns = pgTable("diagnosis_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => cases.id)
    .notNull(),
  model: text("model"),
  reasoningEffort: text("reasoning_effort"),
  report: jsonb("report").notNull(),
  durationMs: integer("duration_ms"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const citations = pgTable("citations", {
  id: uuid("id").defaultRandom().primaryKey(),
  diagnosisId: uuid("diagnosis_id")
    .references(() => diagnosisRuns.id)
    .notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  vendor: text("vendor"),
  category: text("category"),
  excerpt: text("excerpt"),
});
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    vendor: text("vendor").notNull(),
    category: text("category"),
    priority: integer("priority").default(0),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at"),
    searchVector: tsvector("search_vector"),
    embedding: jsonb("embedding"),
  },
  (t) => [index("document_chunks_search_idx").using("gin", t.searchVector)],
);
export const caseLinks = pgTable("case_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => cases.id)
    .notNull(),
  linkedCaseId: uuid("linked_case_id").references(() => cases.id),
  linkType: text("link_type").notNull(),
  score: real("score"),
});
