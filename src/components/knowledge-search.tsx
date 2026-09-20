"use client";
import { FormEvent, useState } from "react";
import { Search, LoaderCircle, ExternalLink } from "lucide-react";
type Hit = {
  id: string;
  title: string;
  vendor: string;
  category: string | null;
  sourceUrl: string;
  body: string;
  score: number;
};
type Meta = { fallbackToAll: boolean; vendorHitCount: number; fallbackHitCount: number; backend: string };
export function KnowledgeSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Hit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError("");
    setSearched(true);
    try {
      const r = await fetch(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setItems(data.items);
      setMeta(data.meta ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "\u68c0\u7d22\u5931\u8d25\u3002");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="mt-5">
      <form className="flex gap-2" onSubmit={submit}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 rounded-md border bg-white px-3 py-2 text-sm"
          placeholder={
            "\u8f93\u5165 429\u3001ValidationException\u3001\u6d41\u5f0f\u4e2d\u65ad\u6216\u5b57\u6bb5\u540d"
          }
        />
        <button className="btn btn-primary" disabled={loading}>
          {loading ? <LoaderCircle className="animate-spin" size={16} /> : <Search size={16} />}
          {"\u68c0\u7d22"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-orange-700">{error}</p>}
      {!loading && !error && !searched && items.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          {
            "\u8f93\u5165\u5173\u952e\u8bcd\u540e\u8fd4\u56de\u5b98\u65b9\u6587\u6863\u7247\u6bb5\u3002"
          }
        </p>
      )}
      {!loading && !error && searched && items.length === 0 && (
        <p className="mt-4 text-sm text-muted">未找到匹配的本地文档。可先导入包含该关键词的知识库资料。</p>
      )}
      {!loading && !error && searched && meta?.fallbackToAll && (
        <p className="mt-3 text-sm text-blue-700">供应商内未命中，已回退全库，命中 {meta.fallbackHitCount} 条。</p>
      )}
      {!loading && !error && searched && !meta?.fallbackToAll && meta && items.length === 0 && (
        <p className="mt-3 text-sm text-muted">未命中本地文档（使用 {meta.backend} 检索）。</p>
      )}
      {items.map((x) => (
        <article className="border-b border-slate-200 py-3" key={x.id}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <a
                className="inline-flex items-center gap-1 font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                href={x.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {x.title}
                <ExternalLink size={14} aria-hidden="true" />
                <span className="sr-only">（在新窗口打开原文）</span>
              </a>
              <p className="mt-1 text-xs text-muted">
                {x.vendor} · {x.category ?? "-"} · {x.score.toFixed(2)}
              </p>
            </div>
            {x.sourceUrl && <a href={x.sourceUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-blue-700 hover:underline">查看原文</a>}
          </div>
          <p className="mt-2 line-clamp-3 text-sm text-slate-600">
            {x.body.replace(/^---[\s\S]*?---/, "")}
          </p>
        </article>
      ))}
    </div>
  );
}
