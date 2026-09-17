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
export function KnowledgeSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Hit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "\u68c0\u7d22\u5931\u8d25\u3002");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="panel mt-5 p-4">
      <form className="flex gap-2" onSubmit={submit}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 rounded border p-3"
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
      {!loading && !error && items.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          {
            "\u8f93\u5165\u5173\u952e\u8bcd\u540e\u8fd4\u56de\u5b98\u65b9\u6587\u6863\u7247\u6bb5\u3002"
          }
        </p>
      )}
      {items.map((x) => (
        <article className="mt-3 rounded-lg border p-3" key={x.id}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <b>{x.title}</b>
              <p className="mt-1 text-xs text-muted">
                {x.vendor} · {x.category ?? "-"} · {x.score.toFixed(2)}
              </p>
            </div>
            {x.sourceUrl && (
              <a href={x.sourceUrl} target="_blank" className="text-blue-700">
                <ExternalLink size={16} />
              </a>
            )}
          </div>
          <p className="mt-2 line-clamp-3 text-sm text-slate-600">
            {x.body.replace(/^---[\s\S]*?---/, "")}
          </p>
        </article>
      ))}
    </div>
  );
}
