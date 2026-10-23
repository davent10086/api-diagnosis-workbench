import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosisGraph,
  diagnosisNodes,
  type DiagnosisGraphState,
  type WorkflowNode,
} from "./diagnosis-graph";

function fixture() {
  const visited: WorkflowNode[] = [];
  const nodes = Object.fromEntries(
    diagnosisNodes.map((name) => [name, vi.fn(async () => ({}) as Partial<DiagnosisGraphState>)]),
  ) as Record<WorkflowNode, ReturnType<typeof vi.fn<() => Promise<Partial<DiagnosisGraphState>>>>>;
  const graph = createDiagnosisGraph(nodes, (name) => {
    visited.push(name);
  });
  return { graph, nodes, visited };
}

describe("diagnosis StateGraph", () => {
  it("passes stage outputs through real graph state in validation-before-persistence order", async () => {
    const { graph, nodes, visited } = fixture();
    nodes.prepare.mockResolvedValue({ traceInput: { statusCode: 429 } });
    nodes.retrieval.mockResolvedValue({
      retrievalResult: {
        items: [],
        meta: {
          vendor: null,
          fallbackToAll: false,
          vendorHitCount: 0,
          fallbackHitCount: 0,
          backend: "postgres-contains",
        },
      },
    });
    const result = await graph.invoke({});
    expect(visited).toEqual([...diagnosisNodes]);
    expect(result.traceInput.statusCode).toBe(429);
    expect(nodes.model).toHaveBeenCalledWith(
      expect.objectContaining({
        traceInput: { statusCode: 429 },
        retrievalResult: expect.objectContaining({ items: [] }),
      }),
    );
  });

  it("never adjudicates or persists a report rejected by the evidence gate", async () => {
    const { graph, nodes, visited } = fixture();
    nodes.validate.mockRejectedValue(new Error("Invalid evidence reference"));
    await expect(graph.invoke({})).rejects.toThrow("Invalid evidence reference");
    expect(visited.at(-1)).toBe("validate");
    expect(nodes.adjudicate).not.toHaveBeenCalled();
    expect(nodes.validate_and_persist).not.toHaveBeenCalled();
  });

  it("does not run later nodes after cancellation", async () => {
    const { graph, nodes } = fixture();
    const controller = new AbortController();
    nodes.images.mockImplementation(async () => {
      controller.abort();
      return {};
    });
    await expect(graph.invoke({}, { signal: controller.signal })).rejects.toThrow();
    expect(nodes.retrieval).not.toHaveBeenCalled();
    expect(nodes.model).not.toHaveBeenCalled();
    expect(nodes.validate_and_persist).not.toHaveBeenCalled();
  });
});
