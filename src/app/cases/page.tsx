import Link from "next/link";
import { and, count, desc, eq, exists, ilike, inArray, or } from "drizzle-orm";
import { Plus } from "lucide-react";
import { Top } from "@/components/app-shell";
import { ClearCasesButton } from "@/components/clear-cases-button";
import { db } from "@/db/client";
import { apiTraces, cases, diagnosisReviews, diagnosisRuns } from "@/db/schema";

export const dynamic = "force-dynamic";
const pageSize = 20;
const statuses = ["all", "uploading", "analyzing", "completed"] as const;

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 120);
  const status = statuses.includes(params.status as typeof statuses[number]) ? params.status! : "all";
  const requestedPage = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const condition = and(
    status === "all" ? undefined : eq(cases.status, status),
    q ? or(
      ilike(cases.title, pattern),
      exists(db.select({ id: apiTraces.id }).from(apiTraces).where(and(
        eq(apiTraces.caseId, cases.id),
        or(ilike(apiTraces.requestId, pattern), ilike(apiTraces.model, pattern)),
      ))),
    ) : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(cases).where(condition);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await db.select().from(cases).where(condition).orderBy(desc(cases.updatedAt), desc(cases.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const ids = rows.map((row) => row.id);
  const [traces, runs] = ids.length ? await Promise.all([
    db.select({ caseId: apiTraces.caseId, requestId: apiTraces.requestId, model: apiTraces.model, statusCode: apiTraces.statusCode }).from(apiTraces).where(inArray(apiTraces.caseId, ids)),
    db.select({ id: diagnosisRuns.id, caseId: diagnosisRuns.caseId, status: diagnosisRuns.status }).from(diagnosisRuns).where(inArray(diagnosisRuns.caseId, ids)).orderBy(desc(diagnosisRuns.createdAt)),
  ]) : [[], []];
  const traceByCase = new Map<string, typeof traces[number]>();
  for (const trace of traces) if (!traceByCase.has(trace.caseId)) traceByCase.set(trace.caseId, trace);
  const runByCase = new Map<string, typeof runs[number]>();
  for (const run of runs) if (!runByCase.has(run.caseId)) runByCase.set(run.caseId, run);
  const runIds = [...runByCase.values()].map((run) => run.id);
  const reviews = runIds.length ? await db.select({ diagnosisId: diagnosisReviews.diagnosisId, verdict: diagnosisReviews.verdict }).from(diagnosisReviews).where(inArray(diagnosisReviews.diagnosisId, runIds)).orderBy(desc(diagnosisReviews.createdAt)) : [];
  const reviewByRun = new Map<string, string>();
  for (const review of reviews) if (!reviewByRun.has(review.diagnosisId)) reviewByRun.set(review.diagnosisId, review.verdict);
  const pageHref = (nextPage: number) => `/cases?${new URLSearchParams({ ...(q ? { q } : {}), ...(status !== "all" ? { status } : {}), page: String(nextPage) })}`;

  return <>
    <Top title="案件列表" />
    <div className="page max-w-5xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">案件列表 <span className="text-sm font-normal text-muted">共 {total} 件</span></h1>
        <Link href="/cases/new" className="btn-primary inline-flex items-center gap-1"><Plus size={16} />新建案件</Link>
      </div>
      <form action="/cases" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <label className="min-w-52 flex-1 text-sm">搜索案件、Request ID 或模型
          <input name="q" defaultValue={q} className="mt-1 block w-full rounded border border-slate-300 px-3 py-2" placeholder="输入标题、Request ID 或模型" />
        </label>
        <label className="text-sm">案件状态
          <select name="status" defaultValue={status} className="mt-1 block w-full rounded border border-slate-300 px-3 py-2">
            <option value="all">全部</option><option value="uploading">待补证据</option><option value="analyzing">诊断中</option><option value="completed">已诊断</option>
          </select>
        </label>
        <button className="rounded bg-slate-800 px-4 py-2 text-sm text-white">查询</button>
      </form>
      {rows.length ? <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {rows.map((row) => {
          const trace = traceByCase.get(row.id);
          const run = runByCase.get(row.id);
          const label = row.status === "uploading" ? "待补证据" : run?.status === "failed" ? "诊断失败" : run?.status === "running" || row.status === "analyzing" ? "诊断中" : run?.status === "completed" ? ({ confirmed: "已人工确认", rejected: "已驳回", corrected: "已修正" }[reviewByRun.get(run.id) ?? ""] ?? "待复核") : "待诊断";
          return <Link href={`/cases/${row.id}`} key={row.id} className="block p-4 hover:bg-slate-50">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-slate-900">{row.title}</h2><span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{label}</span></div>
            {row.summary && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{row.summary}</p>}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              {trace?.requestId && <span>Request ID：<strong className="font-semibold text-slate-800">{trace.requestId}</strong></span>}
              {trace?.statusCode != null && <span>HTTP：<strong className="font-semibold text-slate-800">{trace.statusCode}</strong></span>}
              {trace?.model && <span>模型：{trace.model}</span>}
              <span>更新于 {row.updatedAt.toLocaleString("zh-CN")}</span>
            </div>
          </Link>;
        })}
      </div> : <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-muted">没有找到符合条件的案件。</p>}
      <div className="flex items-center justify-between text-sm"><span>第 {page} / {totalPages} 页</span><div className="flex gap-3">{page > 1 && <Link href={pageHref(page - 1)} className="text-blue-700">上一页</Link>}{page < totalPages && <Link href={pageHref(page + 1)} className="text-blue-700">下一页</Link>}</div></div>
      <details className="border-t border-slate-200 pt-4 text-sm text-muted"><summary className="cursor-pointer">案件管理</summary><div className="mt-3"><ClearCasesButton /></div></details>
    </div>
  </>;
}
