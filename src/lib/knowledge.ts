import { and, desc, eq, ilike, sql } from "drizzle-orm";
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
export async function searchKnowledge(query: string, vendor?: string): Promise<KnowledgeHit[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const fallbackFilters = vendor
    ? and(eq(documentChunks.vendor, vendor), ilike(documentChunks.body, `%${keyword}%`))
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
  const pgroongaFilters = vendor
    ? and(eq(documentChunks.vendor, vendor), sql`${documentChunks.body} &@ ${keyword}`)
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
