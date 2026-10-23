import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosisTools,
  runDiagnosisRules,
  searchDiagnosisKnowledge,
  validateDiagnosisEvidence,
  type DiagnosisToolAsset,
} from "./diagnosis-tools";
import { searchKnowledgeQueries } from "./knowledge";
import { extractImages } from "./diagnosis-image";
import { generateDiagnosisReport, type AiReport } from "./diagnosis-model";
import { readTextEvidence } from "./diagnosis-retrieval";
import { storageFilePath } from "./storage";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

vi.mock("./knowledge", () => ({ searchKnowledgeQueries: vi.fn() }));
vi.mock("./diagnosis-image", () => ({ extractImages: vi.fn() }));
vi.mock("./diagnosis-model", async (original) => ({
  ...(await original<typeof import("./diagnosis-model")>()),
  generateDiagnosisReport: vi.fn(),
}));
vi.mock("./diagnosis-retrieval", async (original) => ({
  ...(await original<typeof import("./diagnosis-retrieval")>()),
  readTextEvidence: vi.fn(),
}));

describe("diagnosis knowledge tool", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns structured documents and retrieval metadata", async () => {
    const result = {
      items: [],
      meta: {
        vendor: "anthropic",
        fallbackToAll: false,
        vendorHitCount: 0,
        fallbackHitCount: 0,
        backend: "postgres-contains" as const,
      },
    };
    vi.mocked(searchKnowledgeQueries).mockResolvedValue(result);
    await expect(
      searchDiagnosisKnowledge.invoke({ queries: ["ValidationException"], vendor: "anthropic" }),
    ).resolves.toEqual(result);
    expect(searchKnowledgeQueries).toHaveBeenCalledWith(["ValidationException"], "anthropic");
  });

  it("rejects excessive or malformed queries before querying the database", async () => {
    await expect(
      searchDiagnosisKnowledge.invoke({ queries: Array(9).fill("429") }),
    ).rejects.toThrow();
    await expect(searchDiagnosisKnowledge.invoke({ queries: [""] })).rejects.toThrow();
    expect(searchKnowledgeQueries).not.toHaveBeenCalled();
  });
});

const report: AiReport = {
  summary: "上游返回限流。",
  root_cause: "可能配额不足。",
  severity: "medium",
  fault_layer: "provider",
  confirmed_evidence: ["trace:statusCode"],
  root_cause_evidence: ["trace:statusCode"],
  hypotheses: ["可能存在突发流量。"],
  missing_evidence: ["需要配额信息。"],
  next_actions: ["核对上游响应。"],
  customer_message: "正在核查。",
};
const evidence = {
  traceInput: { statusCode: 429 },
  allFindings: [],
  successfulImages: [],
  textEvidence: [],
  knowledge: [],
};
function asset(id: string, extension: string, redactionStatus = "redacted"): DiagnosisToolAsset {
  return {
    id,
    filePath: storageFilePath(`${id}.${extension}`),
    evidenceType: "customer_chat",
    redactionStatus,
    extraction: null,
  };
}
function tools(assets: DiagnosisToolAsset[] = []) {
  return createDiagnosisTools({ assets, model: "saved-model", reasoningEffort: "low" });
}

describe("standard diagnosis tools", () => {
  beforeEach(() => vi.resetAllMocks());

  it("exports six distinct, serializable tool schemas without exposing file paths or model configuration", () => {
    const definitions = Object.values(tools()).map((entry) => convertToOpenAITool(entry));
    expect(definitions.map((entry) => entry.function.name).sort()).toEqual(
      [
        "run_diagnosis_rules",
        "read_diagnosis_text_evidence",
        "extract_diagnosis_images",
        "search_diagnosis_knowledge",
        "generate_diagnosis_report",
        "validate_diagnosis_evidence",
      ].sort(),
    );
    expect(() => JSON.stringify(definitions)).not.toThrow();
    const read = definitions.find(
      (entry) => entry.function.name === "read_diagnosis_text_evidence",
    )!;
    expect(read.function.parameters).toHaveProperty("properties.assetIds");
    expect(read.function.parameters).not.toHaveProperty("properties.filePath");
    const generate = definitions.find(
      (entry) => entry.function.name === "generate_diagnosis_report",
    )!;
    expect(generate.function.parameters).not.toHaveProperty("properties.checkpoint");
    expect(generate.function.parameters).not.toHaveProperty("properties.model");
  });

  it("runs deterministic rules and keeps image-derived findings provisional", async () => {
    const findings = await runDiagnosisRules.invoke({ trace: { statusCode: 429 } });
    expect(findings.length).toBeGreaterThan(0);
    const images = await runDiagnosisRules.invoke({
      trace: {},
      images: [{ id: "image-a", status: "completed", fields: ["http_status_code=429"] }],
    });
    expect(images.length).toBeGreaterThan(0);
    expect(
      images.every((item) => item.needsMoreEvidence && item.ruleId.startsWith("image-image-a-")),
    ).toBe(true);
  });

  it("only forwards approved text assets from the bound case and preserves truncation metadata", async () => {
    const text = asset("text-a", "log");
    const result = [
      { id: text.id, evidenceType: text.evidenceType, content: "HTTP 429", truncated: true },
    ];
    vi.mocked(readTextEvidence).mockResolvedValue(result);
    await expect(
      tools([
        text,
        asset("pending", "txt", "pending"),
        asset("image-a", "png"),
      ]).readDiagnosisTextEvidence.invoke({}),
    ).resolves.toEqual(result);
    expect(readTextEvidence).toHaveBeenCalledWith([text]);
  });

  it("rejects foreign IDs, unapproved evidence, outside paths and raw path arguments before reading", async () => {
    const read = tools([
      asset("pending", "log", "pending"),
      { ...asset("outside", "txt"), filePath: "../outside.txt" },
    ]).readDiagnosisTextEvidence;
    for (const id of ["another-case-asset", "pending", "outside"]) {
      await expect(read.invoke({ assetIds: [id] })).rejects.toThrow("附件不可用于");
    }
    await expect(read.invoke({ filePath: "../outside.txt" } as never)).rejects.toThrow();
    expect(readTextEvidence).not.toHaveBeenCalled();
  });

  it("extracts approved images in requested order, propagates cancellation and preserves individual failures", async () => {
    const first = asset("a", "png", "direct_upload");
    const second = asset("b", "webp");
    const result = [
      { status: "failed" as const, error: "vision unavailable" },
      { status: "completed" as const, fields: ["http_status_code=429"] },
    ];
    vi.mocked(extractImages).mockResolvedValue(result);
    const controller = new AbortController();
    await expect(
      tools([first, second]).extractDiagnosisImages.invoke(
        { assetIds: ["b", "a"] },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(result);
    expect(extractImages).toHaveBeenCalledWith([second, first], 2, expect.any(AbortSignal));
  });

  it("rejects duplicate, excess and unapproved image IDs without invoking vision", async () => {
    const extract = tools([
      asset("a", "png"),
      asset("pending", "png", "pending"),
    ]).extractDiagnosisImages;
    for (const ids of [["a", "a"], Array(6).fill("a"), ["pending"], ["foreign"]]) {
      await expect(extract.invoke({ assetIds: ids })).rejects.toThrow();
    }
    expect(extractImages).not.toHaveBeenCalled();
  });

  it("uses server-bound model settings and saved reasoning when generating a report", async () => {
    const saved = { ...report, model_reasoning: "保存的分析。" };
    vi.mocked(generateDiagnosisReport).mockResolvedValue(saved);
    const generate = createDiagnosisTools({
      assets: [],
      model: "saved-model",
      reasoningEffort: "low",
      checkpoint: saved,
    }).generateDiagnosisReport;
    await expect(generate.invoke(evidence)).resolves.toEqual(saved);
    expect(generateDiagnosisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        ...evidence,
        model: "saved-model",
        reasoningEffort: "low",
        checkpoint: saved,
      }),
    );
    vi.mocked(generateDiagnosisReport).mockClear();
    await expect(
      generate.invoke({ ...evidence, model: "caller-override" } as never),
    ).rejects.toThrow();
    expect(generateDiagnosisReport).not.toHaveBeenCalled();
  });

  it("rejects malformed report-generation arguments before model execution", async () => {
    await expect(
      tools().generateDiagnosisReport.invoke({
        ...evidence,
        traceInput: { statusCode: "429" },
      } as never),
    ).rejects.toThrow();
    expect(generateDiagnosisReport).not.toHaveBeenCalled();
  });

  it("checks actual evidence and rejects fabricated or out-of-range citations", async () => {
    await expect(validateDiagnosisEvidence.invoke({ ...evidence, report })).resolves.toEqual({
      valid: true,
    });
    await expect(
      validateDiagnosisEvidence.invoke({
        ...evidence,
        report: { ...report, root_cause_evidence: ["trace:upstreamResponse"] },
      }),
    ).rejects.toThrow("Invalid evidence reference");
    const imageReport = {
      ...report,
      confirmed_evidence: ["image:a[1]"],
      root_cause_evidence: ["image:a[1]"],
    };
    await expect(
      validateDiagnosisEvidence.invoke({
        ...evidence,
        successfulImages: [{ id: "a", status: "completed", fields: ["HTTP 429"] }],
        report: imageReport,
      }),
    ).rejects.toThrow("Invalid evidence reference");
  });

  it("supports standard model ToolCall input and ToolMessage output", async () => {
    const result = await runDiagnosisRules.invoke({
      type: "tool_call",
      id: "call-rules",
      name: "run_diagnosis_rules",
      args: { trace: { statusCode: 429 } },
    });
    expect(result).toMatchObject({
      name: "run_diagnosis_rules",
      tool_call_id: "call-rules",
      status: "success",
    });
    expect(JSON.parse(result.content as string)).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: expect.any(String) })]),
    );
  });

  it("does not read files or call a model for cancelled invocations", async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = tools([asset("a", "png")]);
    await expect(
      registry.extractDiagnosisImages.invoke({ assetIds: ["a"] }, { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      registry.readDiagnosisTextEvidence.invoke({}, { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      registry.generateDiagnosisReport.invoke(evidence, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(extractImages).not.toHaveBeenCalled();
    expect(readTextEvidence).not.toHaveBeenCalled();
    expect(generateDiagnosisReport).not.toHaveBeenCalled();
  });
});
