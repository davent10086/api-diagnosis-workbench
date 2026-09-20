import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { runDiagnosis, type ReasoningEffort } from "@/lib/diagnosis";

const DiagnosisState = Annotation.Root({
  caseId: Annotation<string>,
  reasoningEffort: Annotation<ReasoningEffort>,
  runId: Annotation<string | undefined>,
  error: Annotation<string | undefined>,
});

const diagnosisGraph = new StateGraph(DiagnosisState)
  .addNode("run_diagnosis", async (state) => {
    try {
      const result = await runDiagnosis(state.caseId, state.reasoningEffort);
      return { runId: result.runId };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Diagnosis failed." };
    }
  })
  .addNode("finalize", (state) => {
    if (state.error) throw new Error(state.error);
    return {};
  })
  .addEdge(START, "run_diagnosis")
  .addEdge("run_diagnosis", "finalize")
  .addEdge("finalize", END)
  .compile();

export async function runDiagnosisGraph(caseId: string, reasoningEffort: ReasoningEffort) {
  const state = await diagnosisGraph.invoke({ caseId, reasoningEffort });
  if (!state.runId) throw new Error("Diagnosis graph completed without a diagnosis run.");
  return state;
}
