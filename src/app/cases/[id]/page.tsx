import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Shell, Top } from "@/components/app-shell";
import { ResumeCase } from "@/components/workbench/resume-case";
import { DiagnosisRunner } from "@/components/diagnosis-runner";
import { db } from "@/db/client";
import { apiTraces, cases, citations, diagnosisRuns, evidenceAssets, ruleFindings } from "@/db/schema";

export const dynamic = "force-dynamic";
export default async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let item;
  try {
    [item] = await db.select().from(cases).where(eq(cases.id, id)).limit(1);
  } catch {
    throw new Error("数据库不可用");
  }
  if (!item) notFound();
  const [findings, assets, traces, runs] = await Promise.all([
    db.select().from(ruleFindings).where(eq(ruleFindings.caseId, id)),
    db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, id)),
    db.select().from(apiTraces).where(eq(apiTraces.caseId, id)).limit(1),
    db.select().from(diagnosisRuns).where(eq(diagnosisRuns.caseId, id)),
  ]);
  const latestRun = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const runCitations = latestRun
    ? await db.select().from(citations).where(eq(citations.diagnosisId, latestRun.id))
    : [];
  const aiReport = latestRun?.status === "completed" ? (latestRun.report as Record<string, unknown>) : null;
  return (
    <Shell>
      <Top title="案件详情" />
      <div className="page max-w-5xl space-y-5">
        <section className="border-b border-slate-200 pb-5">
          <h1 className="text-xl font-bold">{item.title}</h1>
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
        {item.status !== "uploading" && <DiagnosisRunner caseId={id} latestStatus={latestRun?.status} />}
        {latestRun?.status === "failed" && (
          <section className="border-l-2 border-amber-500 bg-amber-50 px-3 py-3 text-sm text-amber-800">
            最近一次 AI 诊断未完成：{String((latestRun.report as Record<string, unknown>).error ?? "模型调用失败。")}。规则结果仍可作为人工排障依据。
          </section>
        )}
        {aiReport && (
          <section className="panel overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3"><h2 className="section-title">证据诊断报告</h2></div>
            <div className="space-y-5 p-4">
              <div className="border-l-2 border-blue-600 bg-blue-50 px-3 py-3"><p className="font-semibold text-slate-800">{String(aiReport.summary)}</p><p className="mt-2 text-sm text-blue-800">置信度 {String(aiReport.confidence)}% · {String(aiReport.fault_layer)}</p></div>
              <div><h3 className="font-semibold">根因判断</h3><p className="mt-2 text-sm leading-6 text-slate-700">{String(aiReport.root_cause)}</p></div>
              <ReportList title="已确认的证据" items={aiReport.confirmed_evidence} />
              <ReportList title="待验证假设" items={aiReport.hypotheses} />
              <ReportList title="缺失证据" items={aiReport.missing_evidence} />
              <ReportList title="下一步操作" items={aiReport.next_actions} />
              <div><h3 className="text-sm font-semibold">对外沟通建议</h3><p className="mt-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">{String(aiReport.customer_message)}</p></div>
              {runCitations.length > 0 && <div><h3 className="text-sm font-semibold">官方资料引用</h3>{runCitations.map((citation) => <a className="mt-2 block border-b border-slate-100 py-2 text-sm text-blue-700 hover:text-blue-900" href={citation.url} target="_blank" key={citation.id}>{citation.title}<span className="ml-2 text-xs text-slate-400">{citation.vendor}</span></a>)}</div>}
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

function ReportList({ title, items }: { title: string; items: unknown }) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return null;
  return <div><h3 className="text-sm font-semibold">{title}</h3><ul className="mt-2 divide-y divide-slate-100">{values.map((item, index) => <li className="py-2 text-sm leading-6 text-slate-700" key={index}>{String(item)}</li>)}</ul></div>;
}
