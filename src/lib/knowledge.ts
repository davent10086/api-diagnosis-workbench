import { and, desc, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { documentChunks } from "@/db/schema";

export type KnowledgeHit = {
  id: string;
  title: string;
  vendor: string;
  category: string | null;
  sourceUrl: string;
  body: string;
  score: number;
};
export type KnowledgeSearchMeta = {
  vendor: string | null; fallbackToAll: boolean; vendorHitCount: number; fallbackHitCount: number;
  backend: "pgroonga" | "postgres-contains" | "unavailable"; error?: string;
};
export type KnowledgeSearchResult = { items: KnowledgeHit[]; meta: KnowledgeSearchMeta };
export function normalizeKnowledgeVendor(vendor?: string) {
  const normalized = vendor?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/(?:gemini|google)/.test(normalized)) return "google gemini";
  if (/(?:bedrock|aws)/.test(normalized)) return "aws";
  if (/(?:claude|anthropic)/.test(normalized)) return "anthropic";
  return normalized;
}
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "search failed";
  if (/relation .*does not exist|column .*does not exist/i.test(message)) return "knowledge tables are unavailable";
  if (/connection|connect|timeout|ECONN/i.test(message)) return "database connection unavailable";
  return "search backend unavailable";
}
function containsFilter(keyword: string, vendor?: string) {
  const match = or(ilike(documentChunks.title, `%${keyword}%`), ilike(documentChunks.body, `%${keyword}%`), ilike(documentChunks.category, `%${keyword}%`));
  return vendor ? and(ilike(documentChunks.vendor, vendor), match) : match;
}
function searchTerms(keyword: string) {
  const expanded = keyword.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [...new Set(expanded.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);
}
function fallback(keyword: string, vendor?: string) {
  const terms = searchTerms(keyword);
  const termMatches = terms.flatMap((term) => [
    ilike(documentChunks.title, `%${term}%`),
    ilike(documentChunks.category, `%${term}%`),
    ilike(documentChunks.body, `%${term}%`),
  ]);
  const match = or(containsFilter(keyword), ...termMatches);
  const filter = vendor ? and(ilike(documentChunks.vendor, vendor), match) : match;
  const termBoost = sql.join(
    terms.map((term) => sql` + case when ${documentChunks.title} ilike ${`%${term}%`} then 20 when ${documentChunks.category} ilike ${`%${term}%`} then 10 when ${documentChunks.body} ilike ${`%${term}%`} then 1 else 0 end`),
  );
  const boost = sql<number>`coalesce(${documentChunks.priority}, 0) + case when ${documentChunks.title} ilike ${`%${keyword}%`} then 40 when ${documentChunks.category} ilike ${`%${keyword}%`} then 20 else 0 end${termBoost}`;
  return db.select({ id: documentChunks.id, title: documentChunks.title, vendor: documentChunks.vendor, category: documentChunks.category, sourceUrl: documentChunks.sourceUrl, body: documentChunks.body, score: boost }).from(documentChunks).where(filter).orderBy(desc(boost)).limit(12);
}
async function queryOnce(keyword: string, vendor?: string): Promise<{ items: KnowledgeHit[]; backend: KnowledgeSearchMeta["backend"]; error?: string }> {
  const text = sql<string>`concat_ws(' ', ${documentChunks.title}, ${documentChunks.category}, ${documentChunks.body})`;
  const filter = vendor ? and(ilike(documentChunks.vendor, vendor), sql`${text} &@ ${keyword}`) : sql`${text} &@ ${keyword}`;
  try {
    const items = await db.select({ id: documentChunks.id, title: documentChunks.title, vendor: documentChunks.vendor, category: documentChunks.category, sourceUrl: documentChunks.sourceUrl, body: documentChunks.body, score: sql<number>`pgroonga_score(tableoid, ctid) + coalesce(${documentChunks.priority}, 0)` }).from(documentChunks).where(filter).orderBy(desc(sql`pgroonga_score(tableoid, ctid) + coalesce(${documentChunks.priority}, 0)`)).limit(12);
    if (items.length) return { items, backend: "pgroonga" };
    return { items: await fallback(keyword, vendor), backend: "postgres-contains" };
  } catch (pgError) {
    try { return { items: await fallback(keyword, vendor), backend: "postgres-contains" }; }
    catch (error) { return { items: [], backend: "unavailable", error: safeError(error ?? pgError) }; }
  }
}
function dedupe(items: KnowledgeHit[]) {
  const seen = new Set<string>();
  return items.filter((item) => { const key = `${item.sourceUrl}\u0000${item.title}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
export async function searchKnowledgeDetailed(query: string, vendor?: string): Promise<KnowledgeSearchResult> {
  const keyword = query.trim(); const normalizedVendor = normalizeKnowledgeVendor(vendor);
  if (!keyword) return { items: [], meta: { vendor: normalizedVendor ?? null, fallbackToAll: false, vendorHitCount: 0, fallbackHitCount: 0, backend: "postgres-contains" } };
  const scoped = await queryOnce(keyword, normalizedVendor);
  if (scoped.backend === "unavailable") return { items: [], meta: { vendor: normalizedVendor ?? null, fallbackToAll: false, vendorHitCount: 0, fallbackHitCount: 0, backend: "unavailable", error: scoped.error } };
  if (normalizedVendor && scoped.items.length === 0) {
    const all = await queryOnce(keyword);
    return { items: dedupe(all.items), meta: { vendor: normalizedVendor, fallbackToAll: true, vendorHitCount: 0, fallbackHitCount: all.items.length, backend: all.backend, ...(all.error ? { error: all.error } : {}) } };
  }
  return { items: dedupe(scoped.items), meta: { vendor: normalizedVendor ?? null, fallbackToAll: false, vendorHitCount: scoped.items.length, fallbackHitCount: 0, backend: scoped.backend } };
}
export async function searchKnowledge(query: string, vendor?: string): Promise<KnowledgeHit[]> { return (await searchKnowledgeDetailed(query, vendor)).items; }

export async function searchKnowledgeQueries(
  queries: string[],
  vendor?: string,
): Promise<KnowledgeSearchResult> {
  // A diagnosis can yield many tokens from logs and JSON. Keep the most relevant
  // few and limit database concurrency so a single diagnosis cannot exhaust the
  // connection pool.
  const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter((query) => query.length >= 2))].slice(0, 8);
  const results = await mapWithConcurrency(uniqueQueries, 2, (query) => searchKnowledgeDetailed(query, vendor));
  const ranked = new Map<string, { hit: KnowledgeHit; rank: number }>();
  for (const [queryIndex, result] of results.entries()) {
    for (const [hitIndex, hit] of result.items.entries()) {
      const rank = queryIndex * 100 + hitIndex;
      const existing = ranked.get(hit.id);
      if (!existing || rank < existing.rank) ranked.set(hit.id, { hit, rank });
    }
  }
  const items = [...ranked.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5)
    .map(({ hit }) => hit);
  const unavailable = results.length > 0 && results.every((result) => result.meta.backend === "unavailable");
  return { items, meta: { vendor: normalizeKnowledgeVendor(vendor) ?? null, fallbackToAll: results.some((result) => result.meta.fallbackToAll), vendorHitCount: results.reduce((n, result) => n + result.meta.vendorHitCount, 0), fallbackHitCount: results.reduce((n, result) => n + result.meta.fallbackHitCount, 0), backend: unavailable ? "unavailable" : results.some((result) => result.meta.backend === "pgroonga") ? "pgroonga" : "postgres-contains", ...(unavailable ? { error: results.find((result) => result.meta.error)?.meta.error ?? "search backend unavailable" } : {}) } };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
