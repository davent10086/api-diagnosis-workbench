import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { evidenceAssets } from "@/db/schema";
import type { AiReport } from "./diagnosis-model";
import type { ImageExtraction } from "./diagnosis-image";
import type { ImageIssue } from "./image-evidence";
import type { TextEvidence, knowledgeQueries } from "./diagnosis-retrieval";
import type { adjudicateReport } from "./diagnosis-quality";
import type { KnowledgeSearchResult } from "./knowledge";
import type { Finding, Trace } from "./types";

// Only evidence and stage outputs enter graph state. Credentials and run-local
// resources (locks, AbortSignal, database clients) stay outside it.
const DiagnosisState = Annotation.Root({
  traceInput: Annotation<Trace>(),
  enrichedTrace: Annotation<Trace>(),
  assets: Annotation<(typeof evidenceAssets.$inferSelect)[]>(),
  textEvidence: Annotation<TextEvidence[]>(),
  allFindings: Annotation<Finding[]>(),
  successfulImages: Annotation<(ImageExtraction & { id: string; status: "completed" })[]>(),
  imageIssues: Annotation<ImageIssue[]>(),
  knowledgeQueryList: Annotation<ReturnType<typeof knowledgeQueries>>(),
  retrievalResult: Annotation<KnowledgeSearchResult>(),
  report: Annotation<AiReport>(),
  adjudication: Annotation<ReturnType<typeof adjudicateReport>>(),
});

export const diagnosisNodes = [
  "prepare",
  "images",
  "retrieval",
  "model",
  "validate",
  "adjudicate",
  "validate_and_persist",
] as const;
export type WorkflowNode = (typeof diagnosisNodes)[number];
export type DiagnosisGraphState = typeof DiagnosisState.State;
type DiagnosisNode = (state: DiagnosisGraphState) => Promise<Partial<DiagnosisGraphState>>;

export function createDiagnosisGraph(
  nodes: Record<WorkflowNode, DiagnosisNode>,
  beforeNode: (name: WorkflowNode) => void,
) {
  const execute =
    (name: WorkflowNode): DiagnosisNode =>
    async (state) => {
      beforeNode(name);
      return nodes[name](state);
    };
  return new StateGraph(DiagnosisState)
    .addNode("prepare", execute("prepare"))
    .addNode("images", execute("images"))
    .addNode("retrieval", execute("retrieval"))
    .addNode("model", execute("model"))
    .addNode("validate", execute("validate"))
    .addNode("adjudicate", execute("adjudicate"))
    .addNode("validate_and_persist", execute("validate_and_persist"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "images")
    .addEdge("images", "retrieval")
    .addEdge("retrieval", "model")
    .addEdge("model", "validate")
    .addEdge("validate", "adjudicate")
    .addEdge("adjudicate", "validate_and_persist")
    .addEdge("validate_and_persist", END)
    .compile();
}
