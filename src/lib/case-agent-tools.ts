import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createDiagnosisTools,
  runDiagnosisRules,
  searchDiagnosisKnowledge,
  validateDiagnosisEvidence,
  type DiagnosisToolAsset,
} from "./diagnosis-tools";
import { adjudicateReport } from "./diagnosis-quality";
import type { AiReport, ReasoningEffort } from "./diagnosis-model";
import type { Finding, Trace } from "./types";
import type { ImageExtraction, ImageIssue } from "./image-evidence";
import type { TextEvidence } from "./diagnosis-retrieval";
import type { KnowledgeHit } from "./knowledge";
import { createRequestLogTool } from "./request-log-tool";
import { locationInputSchema } from "./request-location-types";
import { redactTrace } from "./redaction";

export const agentLogScopeSchema = z
  .object({
    username: locationInputSchema.shape.username,
    scopeConfirmed: z.literal(true),
    confirmed: locationInputSchema.shape.confirmed,
  })
  .strict();
export type AgentLogScope = z.infer<typeof agentLogScopeSchema>;

export function createCaseAgentTools(context: {
  trace: Trace;
  assets: DiagnosisToolAsset[];
  model: string;
  reasoningEffort: ReasoningEffort;
  logScope?: AgentLogScope;
}) {
  const trace = redactTrace(context.trace);
  const base = createDiagnosisTools(context);
  const texts = new Map<string, TextEvidence>();
  const images = new Map<string, ImageExtraction & { id: string; status: "completed" }>();
  const imageAttempts = new Set<string>();
  const textAttempts = new Set<string>();
  const failures = new Map<string, ImageIssue>();
  const knowledge = new Map<string, KnowledgeHit>();
  let report: AiReport | undefined;
  let revision = 0,
    reportRevision = -1;
  const approvedImages = context.assets.filter(
    (asset) =>
      /\.(png|jpe?g|webp)$/i.test(asset.filePath) &&
      ["redacted", "direct_upload"].includes(asset.redactionStatus),
  );
  const approvedTexts = context.assets.filter(
    (asset) => /\.(txt|log|json)$/i.test(asset.filePath) && asset.redactionStatus === "redacted",
  );
  function invalidate() {
    revision++;
    report = undefined;
  }
  async function actualEvidence(signal?: AbortSignal) {
    const traceInput = {
      ...trace,
      logs: [...(trace.logs ?? []), ...[...texts.values()].map((item) => item.content)],
    };
    const deterministic = await runDiagnosisRules.invoke({ trace: traceInput }, { signal });
    const imageRules = await runDiagnosisRules.invoke(
      { trace: traceInput, images: [...images.values()], existingFindings: deterministic },
      { signal },
    );
    return {
      traceInput: trace,
      allFindings: [...deterministic, ...imageRules] as Finding[],
      successfulImages: [...images.values()],
      textEvidence: [...texts.values()],
      knowledge: [...knowledge.values()].slice(0, 5),
      imageIssues: approvedImages
        .filter((asset) => !images.has(asset.id))
        .map(
          (asset): ImageIssue =>
            failures.get(asset.id) ?? {
              id: asset.id,
              status: "skipped",
              reason: "Agent 未读取该图片，不得假设其内容。",
            },
        ),
    };
  }
  const read = tool(
    async ({ assetIds }, config) => {
      const ids = assetIds ?? approvedTexts.slice(0, 5).map((asset) => asset.id);
      if (new Set([...textAttempts, ...ids]).size > 5)
        throw new Error("本轮最多读取五份文本附件。");
      ids.forEach((id) => textAttempts.add(id));
      const output = await base.readDiagnosisTextEvidence.invoke(
        { assetIds: ids },
        { signal: config.signal },
      );
      ids.forEach((id) => texts.delete(id));
      output.forEach((item) => texts.set(item.id, item));
      invalidate();
      return output;
    },
    {
      name: "read_diagnosis_text_evidence",
      description: base.readDiagnosisTextEvidence.description,
      schema: base.readDiagnosisTextEvidence.schema,
    },
  );
  const extract = tool(
    async ({ assetIds }, config) => {
      if (new Set([...imageAttempts, ...assetIds]).size > 5)
        throw new Error("本轮最多识别五张图片。");
      assetIds.forEach((id) => imageAttempts.add(id));
      const output = await base.extractDiagnosisImages.invoke(
        { assetIds },
        { signal: config.signal },
      );
      const result = output.map((item, index) => {
        const id = assetIds[index];
        if (item.status === "completed") {
          images.set(id, { ...item, id, status: "completed" });
          failures.delete(id);
        } else {
          images.delete(id);
          failures.set(id, { id, status: item.status, reason: item.error ?? "无法读取图片。" });
        }
        return { ...item, id };
      });
      invalidate();
      return result;
    },
    {
      name: "extract_diagnosis_images",
      description: base.extractDiagnosisImages.description,
      schema: base.extractDiagnosisImages.schema,
    },
  );
  const rules = tool(async (_, config) => (await actualEvidence(config.signal)).allFindings, {
    name: "run_diagnosis_rules",
    description: "检查当前案件服务端 Trace 与本轮实际读取的文本、图片证据。不能传入或伪造 Trace。",
    schema: z.object({}).strict(),
  });
  const search = tool(
    async (input, config) => {
      const output = await searchDiagnosisKnowledge.invoke(input, { signal: config.signal });
      if (output.meta.backend === "unavailable") throw new Error("知识库检索不可用。");
      output.items.forEach((item) => knowledge.set(item.id, item));
      invalidate();
      return output;
    },
    {
      name: "search_diagnosis_knowledge",
      description: searchDiagnosisKnowledge.description,
      schema: searchDiagnosisKnowledge.schema,
    },
  );
  const generate = tool(
    async (_, config) => {
      report = undefined;
      reportRevision = -1;
      const evidence = await actualEvidence(config.signal);
      const generated = await base.generateDiagnosisReport.invoke(evidence, {
        signal: config.signal,
      });
      await validateDiagnosisEvidence.invoke(
        { ...evidence, report: generated },
        { signal: config.signal },
      );
      const blockers = [
        ...evidence.imageIssues.map((issue) => `image:${issue.id}：${issue.reason}`),
        ...approvedTexts
          .filter((asset) => !texts.has(asset.id))
          .map((asset) => `text:${asset.id}：该附件未读取或读取失败。`),
      ];
      const adjusted = {
        ...generated,
        missing_evidence: [...blockers, ...generated.missing_evidence].slice(0, 8),
      };
      const adjudication = adjudicateReport(adjusted, evidence.allFindings, blockers);
      report = adjusted;
      reportRevision = revision;
      return {
        ...adjusted,
        customer_message: adjudication.customerMessage,
        conclusion_status: adjudication.conclusionStatus,
        confirmation_blockers: adjudication.blockers,
      };
    },
    {
      name: "generate_diagnosis_report",
      description:
        "基于本轮实际读取的案件证据生成初步报告。服务端强制执行规则、引用校验和结论裁定；未读取附件会标记缺失，不能传入证据或模型配置。",
      schema: z.object({}).strict(),
    },
  );
  const validate = tool(
    async (_, config) => {
      if (!report || reportRevision !== revision)
        throw new Error("尚无基于当前证据的报告，请先生成或重新生成报告。");
      const evidence = await actualEvidence(config.signal);
      await validateDiagnosisEvidence.invoke({ ...evidence, report }, { signal: config.signal });
      return {
        valid: true,
        rootCauseConfirmed: false,
        note: "引用有效仍需人工核对，不能确认根因。",
      };
    },
    {
      name: "validate_diagnosis_evidence",
      description: "校验本轮最近生成的报告与实际案件证据；不能传入伪造的证据集合，也不能确认根因。",
      schema: z.object({}).strict(),
    },
  );
  const tools = [read, extract, rules, search, generate, validate];
  // This optional tool is only registered after an operator confirms scope.
  // Tool arguments and conversation text cannot enable it or alter its scope.
  if (context.logScope) {
    const scope = agentLogScopeSchema.parse(context.logScope);
    const logs = createRequestLogTool(scope);
    let requests = 0,
      reservedRows = 0;
    const scopedLogs = tool(
      async (input, config) => {
        if (requests >= 6 || reservedRows + input.pageSize > 500)
          throw new Error("本轮日志查询预算已用完。");
        const exact = Boolean(scope.confirmed.requestId || scope.confirmed.upstreamRequestId);
        if (
          !exact &&
          (input.start === undefined ||
            input.end === undefined ||
            input.end - input.start > 15 * 86400 ||
            input.end > Math.floor(Date.now() / 1000))
        )
          throw new Error("需要不超过十五天且不包含未来的时间范围。");
        requests++;
        reservedRows += input.pageSize;
        const output = await logs.invoke(input, { signal: config.signal });
        return {
          ...output,
          candidateOnly: true,
          note: "这些是当前账号的候选日志，未导入案件；必须到请求定位入口由人工确认后再作为案件证据。",
          remainingRequests: 6 - requests,
          remainingRowBudget: 500 - reservedRows,
        };
      },
      {
        name: logs.name,
        description: `${logs.description} 最多六次查询、五百条记录；除精确ID查询外，每次时间跨度最多十五天。日志仅作为待确认候选。`,
        schema: logs.schema,
      },
    );
    // All entries implement the same StructuredTool interface; schemas differ.
    return [...tools, scopedLogs];
  }
  return tools;
}
