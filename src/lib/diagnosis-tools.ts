import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchKnowledgeQueries } from "./knowledge";
import { runRules } from "./rules";
import { extractImages } from "./diagnosis-image";
import { imageRuleFindings, MAX_MODEL_IMAGES } from "./image-evidence";
import { readTextEvidence, traceReferenceSet } from "./diagnosis-retrieval";
import {
  assertNotAborted,
  generateDiagnosisReport,
  reportSchema,
  validateEvidence,
  type AiReport,
  type ReasoningEffort,
} from "./diagnosis-model";
import { diagnosisEvidenceSchema, ruleToolSchema } from "./diagnosis-tool-schemas";
import { isManagedStoragePath } from "./storage";

export const runDiagnosisRules = tool(
  async ({ trace, images, existingFindings }) =>
    images ? imageRuleFindings(trace, images, existingFindings ?? []) : runRules(trace),
  {
    name: "run_diagnosis_rules",
    description:
      "执行 API 请求与日志的确定性规则检查；提供图片证据时返回待人工核对的图片派生规则。",
    schema: ruleToolSchema,
  },
);

export const validateDiagnosisEvidence = tool(
  async ({ report, traceInput, allFindings, successfulImages, textEvidence, knowledge }) => {
    validateEvidence(report, {
      ruleIds: new Set(allFindings.map((item) => item.ruleId)),
      knowledgeIds: new Set(knowledge.slice(0, 5).map((item) => item.id)),
      imageIds: new Set(
        successfulImages.flatMap((item) => [
          item.id,
          ...(item.fields ?? []).map((_, index) => `${item.id}[${index}]`),
        ]),
      ),
      textEvidenceIds: new Set(textEvidence.map((item) => item.id)),
      traceReferences: traceReferenceSet(traceInput),
    });
    return { valid: true as const };
  },
  {
    name: "validate_diagnosis_evidence",
    description:
      "校验报告引用是否存在于所提供的案件证据；虚构或无效引用会抛出错误。通过仅代表引用存在，不代表根因已确认。",
    schema: diagnosisEvidenceSchema.omit({ imageIssues: true }).extend({ report: reportSchema }),
  },
);

export type DiagnosisToolAsset = {
  id: string;
  filePath: string;
  evidenceType: string;
  redactionStatus: string;
  extraction: unknown;
};

// File paths, model configuration and saved checkpoints are trusted run context,
// never tool arguments. Only IDs from this case's loaded assets can be selected.
export function createDiagnosisTools(context: {
  assets: DiagnosisToolAsset[];
  model: string;
  reasoningEffort: ReasoningEffort;
  checkpoint?: AiReport;
}) {
  const assets = new Map(context.assets.map((asset) => [asset.id, { ...asset }]));
  function selectAssets(ids: string[], kind: "text" | "image") {
    return ids.map((id) => {
      const asset = assets.get(id);
      const allowed =
        asset &&
        isManagedStoragePath(asset.filePath) &&
        (kind === "text"
          ? asset.redactionStatus === "redacted" && /\.(json|txt|log)$/i.test(asset.filePath)
          : (asset.redactionStatus === "redacted" || asset.redactionStatus === "direct_upload") &&
            /\.(png|jpe?g|webp)$/i.test(asset.filePath));
      if (!allowed)
        throw new Error(`附件不可用于${kind === "text" ? "文本读取" : "图片识别"}：${id}`);
      return asset;
    });
  }
  const assetIds = z
    .array(z.string().min(1))
    .max(MAX_MODEL_IMAGES)
    .refine((ids) => new Set(ids).size === ids.length, "附件 ID 不可重复");
  const readDiagnosisTextEvidence = tool(
    async ({ assetIds: ids }, config) => {
      assertNotAborted(config.signal);
      const selected =
        ids ??
        [...assets.values()]
          .filter(
            (asset) =>
              asset.redactionStatus === "redacted" && /\.(json|txt|log)$/i.test(asset.filePath),
          )
          .slice(0, 5)
          .map((asset) => asset.id);
      const result = await readTextEvidence(selectAssets(selected, "text"));
      assertNotAborted(config.signal);
      return result;
    },
    {
      name: "read_diagnosis_text_evidence",
      description:
        "读取当前案件已脱敏的 JSON、TXT 或 LOG 附件。省略附件 ID 时读取前五份，返回文本与截断标记。",
      schema: z.object({ assetIds: assetIds.optional() }).strict(),
    },
  );
  const extractDiagnosisImages = tool(
    async ({ assetIds: ids }, config) => {
      assertNotAborted(config.signal);
      const result = await extractImages(selectAssets(ids, "image"), 2, config.signal);
      assertNotAborted(config.signal);
      return result;
    },
    {
      name: "extract_diagnosis_images",
      description:
        "识别当前案件的图片附件，最多五张；返回与输入 ID 顺序对应的识别结果，保留失败与无法辨认状态。",
      schema: z.object({ assetIds }).strict(),
    },
  );
  const generateDiagnosisReportTool = tool(
    async (evidence, config) => {
      assertNotAborted(config.signal);
      const report = await generateDiagnosisReport({
        ...evidence,
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        checkpoint: context.checkpoint,
        signal: config.signal,
      });
      assertNotAborted(config.signal);
      return report;
    },
    {
      name: "generate_diagnosis_report",
      description:
        "根据案件 Trace、规则、截图、文本和知识库生成中文结构化诊断报告；模型与恢复断点由服务端配置，报告仍需校验和人工审核。",
      schema: diagnosisEvidenceSchema.strict(),
    },
  );
  return {
    runDiagnosisRules,
    readDiagnosisTextEvidence,
    extractDiagnosisImages,
    searchDiagnosisKnowledge,
    generateDiagnosisReport: generateDiagnosisReportTool,
    validateDiagnosisEvidence,
  };
}

export const searchDiagnosisKnowledge = tool(
  async ({ queries, vendor }) => searchKnowledgeQueries(queries, vendor),
  {
    name: "search_diagnosis_knowledge",
    description: "检索 API 排障知识库，返回来源、相关片段与检索状态；知识库内容仅作为候选证据。",
    schema: z.object({
      queries: z
        .array(z.string().min(1).max(200))
        .max(8)
        .describe("从请求、错误日志、规则和截图提取的检索词"),
      vendor: z.string().optional().describe("案件中的上游提供商；未指定时检索全部提供商"),
    }),
  },
);
