import { and, desc, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { documentChunks } from "@/db/schema";
import { fuseKnowledgeResults, matchedExcerpt, searchTerms } from "./knowledge-ranking";

export type KnowledgeHit = {
  id: string;
  title: string;
  vendor: string;
  category: string | null;
  sourceUrl: string;
  body: string;
  score: number;
  excerpt?: string;
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
function likePattern(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }
function containsFilter(keyword: string, vendor?: string) {
  const match = or(ilike(documentChunks.title, likePattern(keyword)), ilike(documentChunks.body, likePattern(keyword)), ilike(documentChunks.category, likePattern(keyword)));
  return vendor ? and(ilike(documentChunks.vendor, vendor), match) : match;
}
function termVariants(term: string) {
  const translations: Record<string, string[]> = {
    compatibility: ["兼容"],
    authentication: ["鉴权"],
    timeout: ["超时"],
    throttling: ["限流"],
  };
  return [term, ...(translations[term.toLowerCase()] ?? [])];
}
function fallback(keyword: string, vendor?: string) {
  const terms = searchTerms(keyword);
  const termMatches = terms.map((term) => or(...termVariants(term).flatMap((variant) => [
    ilike(documentChunks.title, likePattern(variant)),
    ilike(documentChunks.category, likePattern(variant)),
    ilike(documentChunks.body, likePattern(variant)),
  ])));
  const coverage = terms.length
    ? sql<number>`${sql.join(termMatches.map((match) => sql`case when ${match} then 1 else 0 end`), sql` + `)}`
    : sql<number>`0`;
  // Multi-word queries should match more than one clue. A single common word
  // such as "context" must not make an unrelated page about "canceled" rank.
  const match = terms.length >= 2
    ? or(containsFilter(keyword), sql`${coverage} >= 2`)
    : or(containsFilter(keyword), ...termMatches);
  const filter = vendor ? and(ilike(documentChunks.vendor, vendor), match) : match;
  const termBoost = sql.join(
    terms.map((term) => sql` + case when ${documentChunks.title} ilike ${likePattern(term)} then 20 when ${documentChunks.category} ilike ${likePattern(term)} then 10 when ${documentChunks.body} ilike ${likePattern(term)} then 1 else 0 end`),
  );
  const boost = sql<number>`coalesce(${documentChunks.priority}, 0) + ${coverage} * 30 + case when ${documentChunks.title} ilike ${likePattern(keyword)} then 400 when ${documentChunks.body} ilike ${likePattern(keyword)} then 300 when ${documentChunks.category} ilike ${likePattern(keyword)} then 200 else 0 end${termBoost}`;
  return db.select({ id: documentChunks.id, title: documentChunks.title, vendor: documentChunks.vendor, category: documentChunks.category, sourceUrl: documentChunks.sourceUrl, body: documentChunks.body, score: boost }).from(documentChunks).where(filter).orderBy(desc(boost), documentChunks.id).limit(12);
}
async function queryOnce(keyword: string, vendor?: string): Promise<{ items: KnowledgeHit[]; backend: KnowledgeSearchMeta["backend"]; error?: string }> {
  // This immutable expression matches the PGroonga expression index in migration 0012.
  const text = sql<string>`(coalesce(${documentChunks.title}, '') || ' ' || coalesce(${documentChunks.category}, '') || ' ' || coalesce(${documentChunks.body}, ''))`;
  const filter = vendor ? and(ilike(documentChunks.vendor, vendor), sql`${text} &@ ${keyword}`) : sql`${text} &@ ${keyword}`;
  try {
    if (searchTerms(keyword).length >= 2) {
      const ranked = await fallback(keyword, vendor);
      if (ranked.length) return { items: ranked, backend: "postgres-contains" };
    }
    const exactBoost = sql<number>`case when ${documentChunks.title} ilike ${likePattern(keyword)} then 400 when ${documentChunks.body} ilike ${likePattern(keyword)} then 300 else 0 end`;
    const score = sql<number>`pgroonga_score(tableoid, ctid) + coalesce(${documentChunks.priority}, 0) + ${exactBoost}`;
    const items = await db.select({ id: documentChunks.id, title: documentChunks.title, vendor: documentChunks.vendor, category: documentChunks.category, sourceUrl: documentChunks.sourceUrl, body: documentChunks.body, score }).from(documentChunks).where(filter).orderBy(desc(score), documentChunks.id).limit(12);
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
    return { items: dedupe(all.items).map((hit) => ({ ...hit, excerpt: matchedExcerpt(hit.body, [keyword]) })), meta: { vendor: normalizedVendor, fallbackToAll: true, vendorHitCount: 0, fallbackHitCount: all.items.length, backend: all.backend, ...(all.error ? { error: all.error } : {}) } };
  }
  return { items: dedupe(scoped.items).map((hit) => ({ ...hit, excerpt: matchedExcerpt(hit.body, [keyword]) })), meta: { vendor: normalizedVendor ?? null, fallbackToAll: false, vendorHitCount: scoped.items.length, fallbackHitCount: 0, backend: scoped.backend } };
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
  const items = fuseKnowledgeResults(results.map((result) => result.items), uniqueQueries);
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
