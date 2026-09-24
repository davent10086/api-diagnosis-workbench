import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Top } from "@/components/app-shell";
import { ResumeCase } from "@/components/workbench/resume-case";
import { DiagnosisRunner } from "@/components/diagnosis-runner";
import { db } from "@/db/client";
import { DeleteCaseButton } from "@/components/delete-case-button";
import { DiagnosisLiveRefresh } from "@/components/diagnosis-live-refresh";
import { DiagnosisReview } from "@/components/diagnosis-review";
import {
  apiTraces,
  cases,
  citations,
  diagnosisRuns,
  diagnosisReviews,
  diagnosisWorkflowSteps,
  evidenceAssets,
  ruleFindings,
} from "@/db/schema";

export const dynamic = "force-dynamic";
export default async function Detail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ run?: string }> }) {
  const { id } = await params;
  const { run: selectedRunId } = await searchParams;
  let item;
  try {
    [item] = await db
      .select({
        id: cases.id,
        title: cases.title,
        status: cases.status,
        summary: cases.summary,
        finalConclusion: cases.finalConclusion,
      })
      .from(cases)
      .where(eq(cases.id, id))
      .limit(1);
  } catch {
    throw new Error("数据库不可用");
  }
  if (!item) notFound();
  const [findings, assets, traces, runs] = await Promise.all([
    db.select().from(ruleFindings).where(eq(ruleFindings.caseId, id)),
    db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, id)),
    db
      .select({ customerQuestion: apiTraces.customerQuestion, requestId: apiTraces.requestId, statusCode: apiTraces.statusCode, model: apiTraces.model })
      .from(apiTraces)
      .where(eq(apiTraces.caseId, id))
      .limit(1),
    db
      .select()
      .from(diagnosisRuns)
      .where(eq(diagnosisRuns.caseId, id))
      .orderBy(desc(diagnosisRuns.createdAt))
      .limit(20),
  ]);
  const latestRun = runs[0];
  const displayRun = runs.find((run) => run.id === selectedRunId) ?? latestRun;
  const runCitations = displayRun
    ? await db.select().from(citations).where(eq(citations.diagnosisId, displayRun.id))
    : [];
  const workflowSteps = displayRun
    ? await db
        .select()
        .from(diagnosisWorkflowSteps)
        .where(eq(diagnosisWorkflowSteps.diagnosisId, displayRun.id))
    : [];
  const reviews = displayRun ? await db.select().from(diagnosisReviews).where(eq(diagnosisReviews.diagnosisId, displayRun.id)).orderBy(desc(diagnosisReviews.createdAt)) : [];
  const aiReport =
    displayRun?.status === "completed" ? (displayRun.report as Record<string, unknown>) : null;
  return (
    <>
      <Top title="案件详情" />
      <div className="page max-w-5xl space-y-5">
        <section className="border-b border-slate-200 pb-5">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold">{item.title}</h1>
            <DeleteCaseButton caseId={id} />
          </div>
          <p className="hidden">
            状态：{caseStatusLabel(item.status)} · 置信度：
            {null}
          </p>
          <p className="mt-4">{item.summary}</p>
          <p className="mt-3 text-sm">{item.finalConclusion}</p>
          {traces[0] && <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
            {traces[0].requestId && <span>Request ID：<strong className="text-slate-900">{traces[0].requestId}</strong></span>}
            {traces[0].statusCode != null && <span>HTTP：<strong className="text-slate-900">{traces[0].statusCode}</strong></span>}
            {traces[0].model && <span>模型：{traces[0].model}</span>}
          </p>}
        </section>
        {traces[0]?.customerQuestion && (
          <section className="border-b border-slate-200 pb-5">
            <h2>客户问题</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{traces[0].customerQuestion}</p>
          </section>
        )}
        {item.status === "uploading" && <ResumeCase caseId={id} assetCount={assets.length} />}
        {item.status !== "uploading" && (
          <DiagnosisRunner caseId={id} latestStatus={latestRun?.status} />
        )}
        {latestRun?.status === "failed" && (
          <section className="border-l-2 border-amber-500 bg-amber-50 px-3 py-3 text-sm text-amber-800">
            最近一次 AI 诊断未完成：
            {String((latestRun.report as Record<string, unknown>).error ?? "模型调用失败。")}
            。规则结果仍可作为人工排障依据。
          </section>
        )}
        {runs.length > 0 && <section className="border-b border-slate-200 pb-5">
          <h2 className="font-semibold">诊断历史</h2>
          <div className="mt-2 flex flex-wrap gap-2">{runs.map((run) => <Link key={run.id} href={`/cases/${id}?run=${run.id}`} aria-current={displayRun?.id === run.id ? "page" : undefined} className={`rounded border px-3 py-2 text-xs ${displayRun?.id === run.id ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
            {run.createdAt.toLocaleString("zh-CN")} · {run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : "进行中"} · {run.model ?? "未知模型"}
          </Link>)}</div>
        </section>}
        {displayRun && (
          <p className="text-xs text-muted">
            模型：{displayRun.model ?? "-"} · 推理强度：{displayRun.reasoningEffort ?? "-"}
          </p>
        )}
        {displayRun && (
          <>
            <DiagnosisLiveRefresh active={latestRun?.status === "running"} />
            <ExecutionLog
              status={displayRun.status}
              durationMs={displayRun.durationMs}
              model={displayRun.model}
              findingCount={findings.length}
              assetCount={assets.length}
              citationCount={runCitations.length}
              retrieval={(displayRun.report as { retrieval?: Record<string, unknown> }).retrieval}
              workflowSteps={workflowSteps.map((step) => ({ nodeName: step.nodeName, status: step.status, summary: step.summary }))}
            />
          </>
        )}
        {aiReport && (
          <section className="panel overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="section-title">证据诊断报告</h2>
            </div>
            <div className="space-y-5 p-4">
              <div className="border-l-2 border-blue-600 bg-blue-50 px-3 py-3">
                <p className="font-semibold text-slate-800">{String(aiReport.summary)}</p>
                <p className="hidden">
                  置信度 {String(aiReport.confidence)}% · {faultLayerLabel(String(aiReport.fault_layer))}
                </p>
                <p className="mt-1 text-sm font-semibold text-blue-800">
                  结论状态：{String(aiReport.conclusion_status ?? "provisional") === "confirmed" ? "已确认" : String(aiReport.conclusion_status ?? "provisional") === "insufficient" ? "证据不足" : "初步判断，待人工确认"}
                </p>
              </div>
              <div>
                <h3 className="font-semibold">{String(aiReport.conclusion_status) === "confirmed" ? "根因判断" : "候选原因"}</h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-800">
                  {String(aiReport.root_cause)}
                </p>
              </div>
              <ReportList title="已确认的证据" items={aiReport.confirmed_evidence} evidenceIds={new Set(Array.isArray(aiReport.evidence_ledger) ? aiReport.evidence_ledger.map((entry: { id?: unknown }) => String(entry.id)) : [])} />
              <ReportList title="确认阻断项" items={aiReport.confirmation_blockers} />
              <ReportList title="待验证假设" items={aiReport.hypotheses} />
              <ReportList title="缺失证据" items={aiReport.missing_evidence} />
              <ReportList title="下一步操作" items={aiReport.next_actions} emphasize />
              <div>
                <h3 className="text-sm font-semibold">对外沟通建议</h3>
                <p className="mt-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                  {String(aiReport.customer_message)}
                </p>
              </div>
              <EvidenceLedger items={aiReport.evidence_ledger} />
              {reviews.length > 0 && <div className="rounded border border-slate-200 p-3 text-sm"><h3 className="font-semibold">复核记录</h3>{reviews.map((review) => <div key={review.id} className="mt-2 border-t border-slate-100 pt-2"><strong>{review.verdict === "confirmed" ? "已确认" : review.verdict === "rejected" ? "已驳回" : "已修正"}</strong> · {review.createdAt.toLocaleString("zh-CN")}{review.correctedRootCause && <p>修正根因：{review.correctedRootCause}</p>}{review.notes && <p>说明：{review.notes}</p>}</div>)}</div>}
              <DiagnosisReview caseId={id} diagnosisId={displayRun.id} />
              {runCitations.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold">官方资料引用</h3>
                  {runCitations.map((citation) => (
                    <a
                      className="mt-2 block border-b border-slate-100 py-2 text-sm text-blue-700 hover:text-blue-900"
                      href={citation.url}
                      target="_blank"
                      key={citation.id}
                    >
                      {citation.title}
                      <span className="ml-2 text-xs text-slate-400">{citation.vendor}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
        <section className="border-b border-slate-200 pb-5">
          <h2>已保存附件</h2>
          {assets.length === 0 ? (
            <p className="mt-2 text-sm text-muted">尚无附件。</p>
          ) : (
            assets.map((asset) => (
              <p className="mt-2 scroll-mt-24 text-sm" id={`asset-${asset.id}`} key={asset.id}>
                {asset.extraction &&
                typeof asset.extraction === "object" &&
                "originalName" in asset.extraction
                  ? String(asset.extraction.originalName)
                  : asset.filePath}{" "}
                {asset.extraction &&
                typeof asset.extraction === "object" &&
                "status" in asset.extraction &&
                asset.extraction.status === "failed" &&
                "error" in asset.extraction &&
                typeof asset.extraction.error === "string" ? (
                  <span className="ml-2 text-amber-700">图片提取失败：{asset.extraction.error}</span>
                ) : null}
                · {redactionStatusLabel(asset.redactionStatus)}
              </p>
            ))
          )}
        </section>
        <section className="border-b border-slate-200 pb-5">
          <h2>规则命中</h2>
          {findings.length === 0 ? (
            <p className="mt-3 text-sm text-muted">未命中规则。</p>
          ) : (
            findings.map((f) => (
              <div className="mt-3 rounded border-l-4 border-amber-400 bg-amber-50 p-3" key={f.id}>
                <b>{f.ruleId}</b>
                <p className="text-sm">{f.conclusion}</p>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}

function EvidenceLedger({ items }: { items: unknown }) {
  const values = Array.isArray(items) ? items as { id?: unknown; kind?: unknown; statement?: unknown }[] : [];
  if (!values.length) return null;
  return <div>
    <h3 className="text-sm font-semibold">证据账本</h3>
    <ul className="mt-2 divide-y divide-slate-100 rounded border border-slate-100">
      {values.map((item, index) => <li id={`evidence-${encodeURIComponent(String(item.id))}`} className="scroll-mt-24 p-2 text-xs text-slate-700" key={`${String(item.id)}-${index}`}><b>{evidenceKindLabel(String(item.kind))}</b> · {evidenceIdLabel(String(item.id))}<br />{String(item.statement)}</li>)}
    </ul>
  </div>;
}

const workflowNodeLabels: Record<string, string> = {
  prepare: "准备诊断资料",
  images: "图片证据提取",
  retrieval: "本地知识库检索",
  model: "模型诊断",
  adjudicate: "结论裁定",
  validate_and_persist: "校验并保存报告",
};
const workflowStatusLabels: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};
const caseStatusLabels: Record<string, string> = {
  draft: "草稿",
  uploading: "等待补充附件",
  completed: "已完成",
  analyzing: "AI 诊断中",
};
const redactionStatusLabels: Record<string, string> = {
  pending: "等待脱敏",
  redacted: "已脱敏",
  direct_upload: "图片原样上传",
};
const faultLayerLabels: Record<string, string> = {
  client: "客户端",
  gateway: "网关",
  adapter: "适配层",
  route: "路由层",
  provider: "服务商层",
  upstream: "上游服务",
  unknown: "未知",
};
const evidenceKindLabels: Record<string, string> = {
  fact: "事实",
  candidate: "候选证据",
  blocker: "确认阻断项",
};
const traceFieldLabels: Record<string, string> = {
  customerQuestion: "客户问题",
  requestId: "请求 ID",
  traceId: "Trace ID",
  upstreamRequestId: "上游请求 ID",
  provider: "服务商",
  route: "路由",
  model: "模型",
  statusCode: "HTTP 状态码",
  clientRequest: "客户端请求",
  transformedRequest: "转换后的请求",
  upstreamResponse: "上游响应",
  finalResponse: "最终响应",
  logs: "日志",
  sse: "SSE 事件",
};

function evidenceKindLabel(kind: string) {
  return evidenceKindLabels[kind] ?? kind;
}

function caseStatusLabel(status: string) {
  return caseStatusLabels[status] ?? status;
}

function redactionStatusLabel(status: string) {
  return redactionStatusLabels[status] ?? status;
}

function faultLayerLabel(layer: string) {
  return faultLayerLabels[layer] ?? layer;
}

function evidenceIdLabel(id: string) {
  const match = /^trace:([^.]+)(.*)$/.exec(id);
  if (match) return `追踪：${traceFieldLabels[match[1]] ?? match[1]}${match[2]}`;
  const prefixes: Record<string, string> = {
    rule: "规则",
    knowledge: "知识库",
    image: "图片",
    text: "文本证据",
  };
  const reference = /^([^:]+):(.*)$/.exec(id);
  return reference && prefixes[reference[1]] ? `${prefixes[reference[1]]}：${reference[2]}` : id;
}

function workflowSummaryLabel(summary: string) {
  if (summary === "case, trace and evidence loaded") return "案件、追踪信息和证据已加载";
  if (summary === "model report received") return "已收到模型诊断报告";
  if (summary === "report and citations saved") return "诊断报告和引用资料已保存";
  if (summary === "no supported images") return "没有可处理的图片";
  if (summary === "knowledge search unavailable") return "知识库检索不可用";
  if (summary === "resumed after worker interruption") return "后台任务中断后已恢复";
  if (summary === "upstream rate limited") return "上游服务触发限流";
  if (summary === "upstream timeout or cancellation") return "上游服务超时或任务已取消";
  if (summary === "upstream connection failed") return "上游服务连接失败";
  if (summary === "step failed") return "步骤执行失败";
  const images = /^(\d+) image\(s\) extracted; (\d+) failed and excluded from diagnosis$/.exec(summary);
  if (images) return `已提取 ${images[1]} 张图片；${images[2]} 张提取失败，未纳入诊断`;
  const imageSuccess = /^(\d+) image\(s\) extracted$/.exec(summary);
  if (imageSuccess) return `已提取 ${imageSuccess[1]} 张图片`;
  const documents = /^(\d+) document\(s\) selected$/.exec(summary);
  if (documents) return `已选取 ${documents[1]} 篇资料`;
  const adjudication = /^(confirmed|provisional|insufficient); (\d+) confirmation blocker\(s\)$/.exec(summary);
  if (adjudication) {
    const result = { confirmed: "已确认", provisional: "初步判断", insufficient: "证据不足" }[adjudication[1]];
    return `${result}；${adjudication[2]} 项确认阻断项`;
  }
  return summary;
}

function ReportList({ title, items, evidenceIds, emphasize = false }: { title: string; items: unknown; evidenceIds?: Set<string>; emphasize?: boolean }) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 divide-y divide-slate-100">
        {values.map((item, index) => (
          <li className={`py-2 text-sm leading-6 text-slate-700 ${emphasize ? "font-medium" : ""}`} key={index}>
            {(() => {
              const value = String(item);
              const reference = value.split(/[=\s]/, 1)[0];
              const sourceId = [...(evidenceIds ?? [])].filter((id) => reference.startsWith(id)).sort((a, b) => b.length - a.length)[0];
              return sourceId ? <a href={`#evidence-${encodeURIComponent(sourceId)}`} className="text-blue-700 underline-offset-2 hover:underline">{evidenceIdLabel(value)}</a> : evidenceIdLabel(value);
            })()}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecutionLog({
  status,
  durationMs,
  model,
  findingCount,
  assetCount,
  citationCount,
  retrieval,
  workflowSteps,
}: {
  status: string;
  durationMs: number | null;
  model: string | null;
  findingCount: number;
  assetCount: number;
  citationCount: number;
  retrieval?: Record<string, unknown>;
  workflowSteps: { nodeName: string; status: string; summary: string | null }[];
}) {
  const done = status === "completed";
  const failed = status === "failed" || status === "cancelled";
  const retrievalText = () => {
    if (!done) return "等待诊断完成";
    if (retrieval?.backend === "unavailable") return `检索不可用${retrieval.error ? `：${String(retrieval.error)}` : ""}；规则诊断仍已完成`;
    const vendorHits = Number(retrieval?.vendorHitCount ?? retrieval?.hitCount ?? 0);
    const fallbackHits = Number(retrieval?.fallbackHitCount ?? 0);
    const finalDocuments = Number(retrieval?.finalDocumentCount ?? retrieval?.hitCount ?? 0);
    return retrieval?.fallbackToAll
      ? `供应商命中 ${vendorHits}，已回退全库命中 ${fallbackHits}，最终引用 ${citationCount} 篇资料（送入模型 ${finalDocuments} 篇）`
      : `供应商命中 ${vendorHits}，最终引用 ${citationCount} 篇资料（送入模型 ${finalDocuments} 篇）`;
  };
  const steps = [
    ["规则检查", `命中 ${findingCount} 条规则`],
    ["证据收集", `${assetCount} 个文件`],
    [
      "本地文档检索",
      retrievalText(),
    ],
    [
      "模型诊断",
      model
        ? `${model}${durationMs === null ? " · 处理中" : ` · ${(durationMs / 1000).toFixed(1)} 秒`}`
        : "未配置模型",
    ],
    [
      "报告校验",
      failed ? "未通过，请查看失败原因" : done ? "结构化报告与证据引用校验通过" : "等待校验",
    ],
  ];
  return (
    <section className="panel p-4">
      <h2 className="section-title">诊断执行日志</h2>
      <p className="mt-1 text-xs text-muted">展示可审计执行节点，不展示或保存模型原始思维链。</p>
      <ol className="mt-4 space-y-3">
        {steps.map(([name, detail], index) => (
          <li className="flex gap-3 text-sm" key={name}>
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${failed ? "bg-red-100 text-red-700" : done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
            >
              {done ? "✓" : index + 1}
            </span>
            <span>
              <b className="font-medium text-slate-800">{name}</b>
              <span className="ml-2 text-slate-500">{detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {workflowSteps.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {workflowSteps.map((step) => (
            <p className="mt-1" key={step.nodeName}>
              {workflowNodeLabels[step.nodeName] ?? step.nodeName}：{workflowStatusLabels[step.status] ?? step.status}{step.summary ? ` · ${workflowSummaryLabel(step.summary)}` : ""}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
