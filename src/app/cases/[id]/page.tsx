import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Shell, Top } from "@/components/app-shell";
import { ResumeCase } from "@/components/workbench/resume-case";
import { db } from "@/db/client";
import { cases, evidenceAssets, ruleFindings } from "@/db/schema";

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
  const [findings, assets] = await Promise.all([
    db.select().from(ruleFindings).where(eq(ruleFindings.caseId, id)),
    db.select().from(evidenceAssets).where(eq(evidenceAssets.caseId, id)),
  ]);
  return (
    <Shell>
      <Top title="案件详情" />
      <div className="max-w-4xl space-y-4 p-6">
        <section className="panel p-4">
          <h1 className="text-xl font-bold">{item.title}</h1>
          <p className="mt-2 text-sm text-muted">
            状态：{item.status} · 置信度：
            {item.confidence === null ? "-" : `${Math.round(item.confidence * 100)}%`}
          </p>
          <p className="mt-4">{item.summary}</p>
          <p className="mt-3 text-sm">{item.finalConclusion}</p>
        </section>
        {item.status === "uploading" && <ResumeCase caseId={id} assetCount={assets.length} />}
        <section className="panel p-4">
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
        <section className="panel p-4">
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
