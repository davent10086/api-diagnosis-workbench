import Link from "next/link";
import { desc } from "drizzle-orm";
import { Plus } from "lucide-react";
import { Shell, Top } from "@/components/app-shell";
import { db } from "@/db/client";
import { cases } from "@/db/schema";
import { ClearCasesButton } from "@/components/clear-cases-button";

export const dynamic = "force-dynamic";
export default async function Cases() {
  let items: (typeof cases.$inferSelect)[] = [];
  let unavailable = false;
  try {
    items = await db.select().from(cases).orderBy(desc(cases.createdAt)).limit(100);
  } catch {
    unavailable = true;
  }
  return (
    <Shell>
      <Top title="案件列表" />
      <div className="page">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="page-title">案件</h1>
            <p className="mt-1 text-sm text-muted">本地排障记录与诊断结论。</p>
          </div>
          <div className="flex gap-2">
            <ClearCasesButton />
            <Link className="btn btn-primary" href="/cases/new">
              <Plus size={16} />
              新建案件
            </Link>
          </div>
        </div>
        <div className="border border-slate-200 bg-white">
          {unavailable ? (
            <p className="text-sm text-red-700">数据库不可用。请完成迁移并检查 DATABASE_URL。</p>
          ) : items.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-slate-700">还没有排障案件</p>
              <p className="mt-1 text-sm text-muted">从一份 Trace 或日志开始创建记录。</p>
            </div>
          ) : (
            items.map((item) => (
              <Link
                href={`/cases/${item.id}`}
                className="list-row block transition hover:bg-slate-50"
                key={item.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <b className="text-sm font-semibold">{item.title}</b>
                  <span className="status-text">{item.status}</span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {item.summary ?? "无摘要"} · {item.createdAt.toLocaleString("zh-CN")}
                </p>
              </Link>
            ))
          )}
        </div>
      </div>
    </Shell>
  );
}
