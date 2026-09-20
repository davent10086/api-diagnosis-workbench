import { and, desc, ilike, sql } from "drizzle-orm";
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
export function normalizeKnowledgeVendor(vendor?: string) {
  return vendor?.trim().toLowerCase() || undefined;
}
export async function searchKnowledge(query: string, vendor?: string): Promise<KnowledgeHit[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const normalizedVendor = normalizeKnowledgeVendor(vendor);
  const fallbackFilters = normalizedVendor
    ? and(
        ilike(documentChunks.vendor, normalizedVendor),
        ilike(documentChunks.body, `%${keyword}%`),
      )
    : ilike(documentChunks.body, `%${keyword}%`);
  const fallback = () =>
    db
      .select({
        id: documentChunks.id,
        title: documentChunks.title,
        vendor: documentChunks.vendor,
        category: documentChunks.category,
        sourceUrl: documentChunks.sourceUrl,
        body: documentChunks.body,
        score: sql<number>`coalesce(${documentChunks.priority}, 0)`,
      })
      .from(documentChunks)
      .where(fallbackFilters)
      .orderBy(desc(documentChunks.priority))
      .limit(12);
  const pgroongaFilters = normalizedVendor
    ? and(ilike(documentChunks.vendor, normalizedVendor), sql`${documentChunks.body} &@ ${keyword}`)
    : sql`${documentChunks.body} &@ ${keyword}`;
  try {
    return await db
      .select({
        id: documentChunks.id,
        title: documentChunks.title,
        vendor: documentChunks.vendor,
        category: documentChunks.category,
        sourceUrl: documentChunks.sourceUrl,
        body: documentChunks.body,
        score: sql<number>`pgroonga_score(tableoid, ctid)`,
      })
      .from(documentChunks)
      .where(pgroongaFilters)
      .orderBy(desc(sql`pgroonga_score(tableoid, ctid)`))
      .limit(12);
  } catch {
    return fallback();
  }
}

export async function searchKnowledgeQueries(
  queries: string[],
  vendor?: string,
): Promise<KnowledgeHit[]> {
  // A diagnosis can yield many tokens from logs and JSON. Keep the most relevant
  // few and limit database concurrency so a single diagnosis cannot exhaust the
  // connection pool.
  const uniqueQueries = [
    ...new Set(queries.map((query) => query.trim()).filter((query) => query.length >= 3)),
  ].slice(0, 5);
  const results = await mapWithConcurrency(uniqueQueries, 2, (query) =>
    searchKnowledge(query, vendor).catch(() => [] as KnowledgeHit[]),
  );
  const ranked = new Map<string, { hit: KnowledgeHit; rank: number }>();
  for (const [queryIndex, hits] of results.entries()) {
    for (const [hitIndex, hit] of hits.entries()) {
      const rank = queryIndex * 100 + hitIndex;
      const existing = ranked.get(hit.id);
      if (!existing || rank < existing.rank) ranked.set(hit.id, { hit, rank });
    }
  }
  return [...ranked.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5)
    .map(({ hit }) => hit);
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
