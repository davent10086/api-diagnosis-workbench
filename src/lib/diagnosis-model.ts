import { z } from "zod";
import { buildEvidenceLedger } from "@/lib/diagnosis-quality";
import type { ImageExtraction } from "@/lib/diagnosis-image";
import type { TextEvidence } from "@/lib/diagnosis-retrieval";
import type { Finding, Trace } from "@/lib/types";

const reportTextItem = z.preprocess((value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "source" in value && "reference" in value) {
    const item = value as { source?: unknown; reference?: unknown };
    if (typeof item.source === "string" && typeof item.reference === "string")
      return `${item.source}:${item.reference}`;
  }
  return value;
}, z.string().max(1000));
export const reportSchema = z.object({
  summary: z.string().min(1).max(4000),
  root_cause: z.string().min(1).max(4000),
  severity: z.enum(["critical", "high", "medium", "low"]),
  fault_layer: z.enum(["client", "gateway", "adapter", "route", "provider", "upstream", "unknown"]),
  confirmed_evidence: z.array(reportTextItem).max(12),
  hypotheses: z.array(reportTextItem).max(8),
  missing_evidence: z.array(reportTextItem).max(8),
  next_actions: z.array(reportTextItem).min(1).max(8),
  customer_message: z.string().min(1).max(2000),
  root_cause_evidence: z.array(reportTextItem).max(6).default([]),
});
export type AiReport = z.infer<typeof reportSchema>;
export const reasoningEfforts = ["low", "high", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

type EvidenceContext = {
  ruleIds: Set<string>;
  knowledgeIds: Set<string>;
  imageIds: Set<string>;
  traceReferences: Set<string>;
  textEvidenceIds: Set<string>;
};
type OpenAICompatibleResponse = {
  choices?: { message?: { content?: unknown } }[];
  error?: { code?: string; message?: string; type?: string };
};
const MODEL_REQUEST_TIMEOUT_MS = Math.min(
  180_000,
  Math.max(10_000, Number(process.env.DASHSCOPE_REQUEST_TIMEOUT_MS) || 90_000),
);
export function parseAiReport(raw: string): AiReport {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return reportSchema.parse(JSON.parse(json));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown validation error";
    throw new Error(`Invalid AI diagnosis report: ${message}`);
  }
}
export function isChineseReport(report: AiReport) {
  const readableText = [
    report.summary,
    report.root_cause,
    report.customer_message,
    ...report.confirmed_evidence,
    ...report.hypotheses,
    ...report.missing_evidence,
    ...report.next_actions,
  ];
  return readableText.every((item) => /[\u3400-\u9fff]/.test(item));
}
export function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Request cancelled", "AbortError");
}
export function validateEvidence(report: AiReport, context: EvidenceContext) {
  for (const evidence of [...report.confirmed_evidence, ...report.root_cause_evidence]) {
    const [source, rawReference] = evidence.split(":", 2);
    const reference = rawReference?.split(/[=\s]/, 1)[0]?.replace(/\[\d+\].*$/, "");
    const matches = (values: Set<string>) =>
      Boolean(reference && [...values].some((value) => reference.startsWith(value)));
    if (
      !(
        (source === "rule" && matches(context.ruleIds)) ||
        (source === "knowledge" && matches(context.knowledgeIds)) ||
        (source === "image" && matches(context.imageIds)) ||
        (source === "text" && matches(context.textEvidenceIds)) ||
        (source === "trace" && matches(context.traceReferences))
      )
    )
      throw new Error(`Invalid evidence reference: ${evidence}`);
  }
}
function config() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("百炼模型未配置：请设置 DASHSCOPE_API_KEY。");
  const legacyBase = process.env.DASHSCOPE_BASE_URL?.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_COMPAT_BASE_URL || legacyBase || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
  };
}
export function parseOpenAICompatibleContent(body: OpenAICompatibleResponse) {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "",
      )
      .join("");
    if (text) return text;
  }
  throw new Error("OpenAI 兼容接口未返回正文。");
}
async function openAICompatibleAttempt(
  model: string,
  messages: unknown[],
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { baseUrl, apiKey } = config();
  assertNotAborted(signal);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false, ...parameters }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as OpenAICompatibleResponse;
  if (!response.ok)
    throw new Error(
      `模型请求失败 (HTTP ${response.status}${body.error?.code ? ` / ${body.error.code}` : ""}): ${body.error?.message || "request rejected"}`,
    );
  return parseOpenAICompatibleContent(body);
}
function retryableModelFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|abort/i.test(message)) return false;
  return /HTTP (429|5\d\d)|fetch failed|ECONN|network|timeout/i.test(message);
}
async function waitForRetry(delayMs: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Request cancelled", "AbortError"));
    }, { once: true });
  });
}
export async function openAICompatibleCompletion(
  model: string,
  messages: unknown[],
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await openAICompatibleAttempt(model, messages, parameters, signal); }
    catch (error) {
      lastError = error;
      if (attempt === 2 || !retryableModelFailure(error) || signal?.aborted) throw error;
      await waitForRetry(500 * 2 ** attempt + Math.floor(Math.random() * 250), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型请求失败。");
}

export async function generateDiagnosisReport({
  traceInput, allFindings, successfulImages, textEvidence, knowledge,
  reasoningEffort, model, checkpoint, signal,
}: {
  traceInput: Trace;
  allFindings: Finding[];
  successfulImages: ({ id: string } & ImageExtraction)[];
  textEvidence: TextEvidence[];
  knowledge: { id: string; title: string; sourceUrl: string; body: string }[];
  reasoningEffort: ReasoningEffort;
  model: string;
  checkpoint?: AiReport;
  signal?: AbortSignal;
}): Promise<AiReport> {
    // Historical model conclusions are not evidence. Do not feed them back into
    // a new diagnosis, otherwise one wrong conclusion can anchor later cases.
    const prompt = {
      trace: traceInput,
      rules: allFindings.map(
        ({ ruleId, severity, faultLayer, evidence, conclusion, needsMoreEvidence }) => ({
          ruleId,
          severity,
          faultLayer,
          evidence,
          conclusion,
          needsMoreEvidence,
        }),
      ),
      imageEvidence: successfulImages,
      textEvidence,
      knowledge: knowledge.slice(0, 5).map((x) => ({
        id: x.id,
        title: x.title,
        url: x.sourceUrl,
        excerpt: x.body.slice(0, 1200),
      })),
      evidenceLedger: buildEvidenceLedger(traceInput, allFindings, textEvidence, successfulImages),
      instructions:
        "仅依据所提供的证据进行诊断，不能将推测写成已确认的根因。所有 needsMoreEvidence 规则都是确认阻断项，必须在 missing_evidence 中说明。文本、截图和知识库片段只能支持候选，除非存在对应的确定性 rule 证据。必须至少提出一个替代解释；无法排除时写入 hypotheses。summary、root_cause、confirmed_evidence 中的说明、hypotheses、missing_evidence、next_actions 和 customer_message 的所有可读文本必须使用简体中文。错误码、请求 ID、Trace ID、模型名、API 字段名、URL、引用的原始日志片段和证据引用前缀必须保持原样。confirmed_evidence 必须使用 rule:<id>、trace:<field>、image:<id>、text:<id> 或 knowledge:<id> 形式的引用；knowledge 引用可在 ID 后附中文说明。缺少证据支撑的结论必须写入 hypotheses。confirmed_evidence、hypotheses、missing_evidence 和 next_actions 中的每一项都必须是纯字符串，不能是对象。仅输出 JSON，字段为 summary、root_cause、severity、fault_layer、confirmed_evidence、hypotheses、missing_evidence、next_actions、customer_message。",
    };
    const messages = [
      {
        role: "system",
        content:
          "你是一名严谨的 API 排障工程师。只可根据输入证据得出结论，不得将假设表述为已确认根因。所有面向读者的分析、建议和客户回复必须使用简体中文；错误码、请求 ID、Trace ID、模型名、API 字段名、URL 及原始证据必须保持原样。输出必须是符合用户要求字段的 JSON 对象，除 JSON 外不要输出任何内容。",
      },
      { role: "user", content: JSON.stringify(prompt) },
      {
        role: "user",
        content:
          "输出中必须包含 root_cause_evidence 数组。它只能引用 confirmed_evidence 中已有的 rule:<id>、trace:<field>、text:<id>、image:<id> 或 knowledge:<id>，且每一项必须直接支持 root_cause。",
      },
    ];
    const parameters = {
      reasoning_effort: reasoningEffort,
      response_format: { type: "json_object" },
    };
    let report = checkpoint
      ? reportSchema.parse(checkpoint)
      : undefined;
    if (!report) {
      const raw = await openAICompatibleCompletion(
        model,
        messages,
        parameters,
        signal,
      );
      try {
        report = parseAiReport(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 1200) : "Invalid report schema";
        const corrected = await openAICompatibleCompletion(
          model,
          [
            ...messages,
            {
              role: "user",
              content:
                `The previous JSON failed schema validation: ${reason}. Return the complete JSON again. severity must be exactly one of critical, high, medium, low; never use unknown, none, or other values.`,
            },
          ],
          parameters,
          signal,
        );
        report = parseAiReport(corrected);
      }
    }
    if (!isChineseReport(report)) {
      const retry = await openAICompatibleCompletion(
        model,
        [
          ...messages,
          {
            role: "user",
            content:
              "上一份输出因包含非中文的说明性报告文本而被拒绝。请重新生成完整 JSON。summary、root_cause、confirmed_evidence、hypotheses、missing_evidence、next_actions 与 customer_message 中每一项必须包含简体中文说明；仅技术标识符、原始日志和证据引用可保留原文。",
          },
        ],
        parameters,
        signal,
      );
      report = parseAiReport(retry);
      if (!isChineseReport(report))
        throw new Error("Qwen 未返回中文诊断报告，请稍后重试或检查模型配置。");
    }
    return report;
}
