import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createCaseAgentTools } from "./case-agent-tools";
import { generateDiagnosisReport, type AiReport } from "./diagnosis-model";
import { readTextEvidence } from "./diagnosis-retrieval";
import { extractImages } from "./diagnosis-image";
import { storageFilePath } from "./storage";

vi.mock("./diagnosis-model", async (original) => ({
  ...(await original<typeof import("./diagnosis-model")>()),
  generateDiagnosisReport: vi.fn(),
}));
vi.mock("./diagnosis-image", () => ({ extractImages: vi.fn() }));
vi.mock("./diagnosis-retrieval", async (original) => ({
  ...(await original<typeof import("./diagnosis-retrieval")>()),
  readTextEvidence: vi.fn(),
}));
const report: AiReport = {
  summary: "观察到限流。",
  root_cause: "可能是上游配额限制。",
  severity: "medium",
  fault_layer: "provider",
  confirmed_evidence: ["trace:statusCode"],
  root_cause_evidence: ["trace:statusCode"],
  hypotheses: ["可能是网关限制。"],
  missing_evidence: ["需要上游响应。"],
  next_actions: ["核对上游响应。"],
  customer_message: "正在核查。",
};
const assets = [
  {
    id: "text-a",
    filePath: storageFilePath("text-a.log"),
    evidenceType: "backend_log",
    redactionStatus: "redacted",
    extraction: null,
  },
  {
    id: "image-a",
    filePath: storageFilePath("image-a.png"),
    evidenceType: "customer_chat",
    redactionStatus: "direct_upload",
    extraction: null,
  },
];
function registry(logScope?: Parameters<typeof createCaseAgentTools>[0]["logScope"]) {
  return createCaseAgentTools({
    trace: { statusCode: 429, logs: ["HTTP 429"] },
    assets,
    model: "test-model",
    reasoningEffort: "high",
    logScope,
  });
}
function find(tools: StructuredToolInterface[], name: string) {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateDiagnosisReport).mockResolvedValue(report);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("server-bound autonomous tools", () => {
  it("exposes six tools initially and never allows callers to replace the server trace", async () => {
    const tools = registry();
    expect(tools).toHaveLength(6);
    await expect(
      find(tools, "run_diagnosis_rules").invoke({ trace: { statusCode: 200 } }),
    ).rejects.toThrow();
    const findings = await find(tools, "run_diagnosis_rules").invoke({});
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.arrayContaining([expect.stringContaining("429")]),
        }),
      ]),
    );
    expect(tools.some((entry) => entry.name === "search_request_logs")).toBe(false);
  });
  it("always validates reports against actual evidence and marks unread attachments as blockers", async () => {
    const tools = registry();
    await expect(
      find(tools, "generate_diagnosis_report").invoke({ allFindings: [] }),
    ).rejects.toThrow();
    const generated = await find(tools, "generate_diagnosis_report").invoke({});
    expect(generated).toMatchObject({
      conclusion_status: "provisional",
      confirmation_blockers: expect.arrayContaining([
        expect.stringContaining("image:image-a"),
        expect.stringContaining("text:text-a"),
      ]),
    });
    expect(generateDiagnosisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        traceInput: { statusCode: 429, logs: ["HTTP 429"] },
        successfulImages: [],
        textEvidence: [],
      }),
    );
    await expect(find(tools, "validate_diagnosis_evidence").invoke({})).resolves.toMatchObject({
      valid: true,
      rootCauseConfirmed: false,
    });
  });
  it("rejects fabricated report references and cannot validate a previous report after failed regeneration", async () => {
    const tools = registry();
    const generate = find(tools, "generate_diagnosis_report"),
      validate = find(tools, "validate_diagnosis_evidence");
    await generate.invoke({});
    vi.mocked(generateDiagnosisReport).mockResolvedValueOnce({
      ...report,
      confirmed_evidence: ["rule:invented"],
      root_cause_evidence: ["rule:invented"],
    });
    await expect(generate.invoke({})).rejects.toThrow("Invalid evidence reference");
    await expect(validate.invoke({})).rejects.toThrow("尚无基于当前证据");
  });
  it("uses real text tool results and invalidates a report when evidence changes", async () => {
    const tools = registry();
    await find(tools, "generate_diagnosis_report").invoke({});
    vi.mocked(readTextEvidence).mockResolvedValue([
      {
        id: "text-a",
        evidenceType: "backend_log",
        content: "actual uploaded evidence",
        truncated: false,
      },
    ]);
    await find(tools, "read_diagnosis_text_evidence").invoke({ assetIds: ["text-a"] });
    await expect(find(tools, "validate_diagnosis_evidence").invoke({})).rejects.toThrow(
      "尚无基于当前证据",
    );
    await find(tools, "generate_diagnosis_report").invoke({});
    expect(vi.mocked(generateDiagnosisReport).mock.lastCall?.[0].textEvidence[0].content).toBe(
      "actual uploaded evidence",
    );
  });
  it("does not keep stale successful image evidence after a failed reread", async () => {
    const tools = registry();
    const imageTool = find(tools, "extract_diagnosis_images");
    vi.mocked(extractImages)
      .mockResolvedValueOnce([{ status: "completed", fields: ["http_status_code=429"] }])
      .mockResolvedValueOnce([{ status: "failed", error: "unreadable" }]);
    await imageTool.invoke({ assetIds: ["image-a"] });
    await imageTool.invoke({ assetIds: ["image-a"] });
    const generated = await find(tools, "generate_diagnosis_report").invoke({});
    expect(vi.mocked(generateDiagnosisReport).mock.lastCall?.[0].successfulImages).toEqual([]);
    expect(generated.confirmation_blockers.join(" ")).toContain("unreadable");
  });
  it("only registers log search with explicit human scope and rejects scope overrides", async () => {
    vi.stubEnv("NEW_API_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NEW_API_ACCESS_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ success: true, data: { total: 0, items: [] } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const tools = registry({ username: "alice", scopeConfirmed: true, confirmed: {} });
    const logs = find(tools, "search_request_logs");
    const end = Math.floor(Date.now() / 1000);
    await logs.invoke({ start: end - 3600, end, page: 1, pageSize: 100 });
    expect(fetchMock.mock.calls[0][0].searchParams.get("username")).toBe("alice");
    await expect(
      logs.invoke({ start: end - 3600, end, page: 1, pageSize: 100, username: "mallory" }),
    ).rejects.toThrow();
    await expect(logs.invoke({ page: 1, pageSize: 100 })).rejects.toThrow("时间范围");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(() =>
      registry({ username: "alice", scopeConfirmed: false, confirmed: {} } as never),
    ).toThrow();
  });
  it("enforces log budgets in server code independently of model instructions", async () => {
    vi.stubEnv("NEW_API_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NEW_API_ACCESS_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ success: true, data: { total: 0, items: [] } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const logs = find(
      registry({ username: "alice", scopeConfirmed: true, confirmed: {} }),
      "search_request_logs",
    );
    const end = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++)
      await logs.invoke({ start: end - 3600, end, page: 1, pageSize: 100 });
    await expect(logs.invoke({ start: end - 3600, end, page: 1, pageSize: 100 })).rejects.toThrow(
      "预算",
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
