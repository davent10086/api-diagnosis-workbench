import { count, desc, eq } from "drizzle-orm";
import { Top } from "@/components/app-shell";
import { db } from "@/db/client";
import { diagnosisReviews, diagnosisRuns } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function QualityPage() {
  let reviews: { verdict: string; total: number }[] = [];
  let recent: { verdict: string; correctedRootCause: string | null; notes: string | null; createdAt: Date; diagnosisId: string }[] = [];
  try {
    reviews = await db.select({ verdict: diagnosisReviews.verdict, total: count() }).from(diagnosisReviews).groupBy(diagnosisReviews.verdict);
    recent = await db.select({ verdict: diagnosisReviews.verdict, correctedRootCause: diagnosisReviews.correctedRootCause, notes: diagnosisReviews.notes, createdAt: diagnosisReviews.createdAt, diagnosisId: diagnosisReviews.diagnosisId })
      .from(diagnosisReviews).innerJoin(diagnosisRuns, eq(diagnosisReviews.diagnosisId, diagnosisRuns.id))
      .orderBy(desc(diagnosisReviews.createdAt)).limit(20);
  } catch {
    // The page remains usable before the migration is applied.
  }
  const metrics = new Map(reviews.map((row) => [row.verdict, Number(row.total)]));
  const total = [...metrics.values()].reduce((sum, value) => sum + value, 0);
  return <><Top title="诊断质量" /><div className="page max-w-5xl space-y-5">
    <section className="panel p-4"><h1 className="section-title">人工复核质量</h1><p className="mt-1 text-sm text-muted">仅统计人工裁定；用于发现高频误诊和补齐回归样例。</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="已复核" value={total} /><Metric label="确认" value={metrics.get("confirmed") ?? 0} /><Metric label="驳回" value={metrics.get("rejected") ?? 0} /><Metric label="已修正" value={metrics.get("corrected") ?? 0} />
      </div>
    </section>
    <section className="panel p-4"><h2 className="section-title">最近裁定</h2>{recent.length ? <ul className="mt-3 divide-y">{recent.map((row) => <li className="py-3 text-sm" key={`${row.diagnosisId}-${row.createdAt.toISOString()}`}><b>{row.verdict}</b><span className="ml-2 text-muted">{row.createdAt.toLocaleString("zh-CN")}</span>{row.correctedRootCause && <p className="mt-1">修正根因：{row.correctedRootCause}</p>}{row.notes && <p className="mt-1">说明：{row.notes}</p>}</li>)}</ul> : <p className="mt-3 text-sm text-muted">暂无人工复核记录。运行迁移后可开始收集质量数据。</p>}</section>
  </div></>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded border bg-slate-50 p-3"><p className="text-xs text-muted">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
}
