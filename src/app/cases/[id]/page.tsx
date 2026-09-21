import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Shell, Top } from "@/components/app-shell";
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
  diagnosisWorkflowSteps,
  evidenceAssets,
  ruleFindings,
} from "@/db/schema";

export const dynamic = "force-dynamic";
export default async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let item;
  try {
    [item] = await db
      .select({
        id: cases.id,
        title: cases.title,
        status: cases.status,
        summary: cases.summary,
        finalConclusion: cases.finalConclusion,
        confidence: cases.confidence,
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
      .select({ customerQuestion: apiTraces.customerQuestion })
      .from(apiTraces)
      .where(eq(apiTraces.caseId, id))
      .limit(1),
    db
      .select()
      .from(diagnosisRuns)
      .where(eq(diagnosisRuns.caseId, id))
      .orderBy(desc(diagnosisRuns.createdAt))
      .limit(1),
  ]);
  const latestRun = runs[0];
  const runCitations = latestRun
    ? await db.select().from(citations).where(eq(citations.diagnosisId, latestRun.id))
    : [];
  const workflowSteps = latestRun
    ? await db
        .select()
        .from(diagnosisWorkflowSteps)
        .where(eq(diagnosisWorkflowSteps.diagnosisId, latestRun.id))
    : [];
  const aiReport =
    latestRun?.status === "completed" ? (latestRun.report as Record<string, unknown>) : null;
  return (
    <Shell>
      <Top title="案件详情" />
      <div className="page max-w-5xl space-y-5">
        <section className="border-b border-slate-200 pb-5">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold">{item.title}</h1>
            <DeleteCaseButton caseId={id} />
          </div>
          <p className="mt-2 text-sm text-muted">
            状态：{item.status} · 置信度：
            {item.confidence === null ? "-" : `${Math.round(item.confidence * 100)}%`}
          </p>
          <p className="mt-4">{item.summary}</p>
          <p className="mt-3 text-sm">{item.finalConclusion}</p>
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
        {latestRun && (
          <p className="text-xs text-muted">
            模型：{latestRun.model ?? "-"} · 推理强度：{latestRun.reasoningEffort ?? "-"}
          </p>
        )}
        {latestRun && (
          <>
            <DiagnosisLiveRefresh active={latestRun.status === "running"} />
            <ExecutionLog
              status={latestRun.status}
              durationMs={latestRun.durationMs}
              model={latestRun.model}
              findingCount={findings.length}
              assetCount={assets.length}
              citationCount={runCitations.length}
              retrieval={(latestRun.report as { retrieval?: Record<string, unknown> }).retrieval}
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
                <p className="mt-2 text-sm text-blue-800">
                  置信度 {String(aiReport.confidence)}% · {String(aiReport.fault_layer)}
                </p>
                <p className="mt-1 text-sm font-semibold text-blue-800">
                  结论状态：{String(aiReport.conclusion_status ?? "provisional") === "confirmed" ? "已确认" : String(aiReport.conclusion_status ?? "provisional") === "insufficient" ? "证据不足" : "初步判断，待人工确认"}
                </p>
              </div>
              <div>
                <h3 className="font-semibold">{String(aiReport.conclusion_status) === "confirmed" ? "根因判断" : "候选原因"}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  {String(aiReport.root_cause)}
                </p>
              </div>
              <ReportList title="已确认的证据" items={aiReport.confirmed_evidence} />
              <ReportList title="确认阻断项" items={aiReport.confirmation_blockers} />
              <ReportList title="待验证假设" items={aiReport.hypotheses} />
              <ReportList title="缺失证据" items={aiReport.missing_evidence} />
              <ReportList title="下一步操作" items={aiReport.next_actions} />
              <div>
                <h3 className="text-sm font-semibold">对外沟通建议</h3>
                <p className="mt-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                  {String(aiReport.customer_message)}
                </p>
              </div>
              <EvidenceLedger items={aiReport.evidence_ledger} />
              <DiagnosisReview caseId={id} diagnosisId={latestRun.id} />
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
              <p className="mt-2 text-sm" key={asset.id}>
                {asset.extraction &&
                typeof asset.extraction === "object" &&
                "originalName" in asset.extraction
                  ? String(asset.extraction.originalName)
                  : asset.filePath}{" "}
                · {asset.redactionStatus}
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
    </Shell>
  );
}

function EvidenceLedger({ items }: { items: unknown }) {
  const values = Array.isArray(items) ? items as { id?: unknown; kind?: unknown; statement?: unknown }[] : [];
  if (!values.length) return null;
  return <div>
    <h3 className="text-sm font-semibold">证据账本</h3>
    <ul className="mt-2 divide-y divide-slate-100 rounded border border-slate-100">
      {values.map((item, index) => <li className="p-2 text-xs text-slate-700" key={`${String(item.id)}-${index}`}><b>{String(item.kind)}</b> · {String(item.id)}<br />{String(item.statement)}</li>)}
    </ul>
  </div>;
}

function ReportList({ title, items }: { title: string; items: unknown }) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 divide-y divide-slate-100">
        {values.map((item, index) => (
          <li className="py-2 text-sm leading-6 text-slate-700" key={index}>
            {String(item)}
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
              {step.nodeName}: {step.status}{step.summary ? ` · ${step.summary}` : ""}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
