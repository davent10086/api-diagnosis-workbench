import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { documentChunks } from "@/db/schema";

export type KnowledgeHit = { id:string; title:string; vendor:string; category:string|null; sourceUrl:string; body:string; score:number };
export async function searchKnowledge(query:string,vendor?:string):Promise<KnowledgeHit[]> {
  const keyword=query.trim(); if(!keyword) return [];
  const filters=vendor ? and(eq(documentChunks.vendor,vendor),sql`${documentChunks.body} &@ ${keyword}`) : sql`${documentChunks.body} &@ ${keyword}`;
  return db.select({id:documentChunks.id,title:documentChunks.title,vendor:documentChunks.vendor,category:documentChunks.category,sourceUrl:documentChunks.sourceUrl,body:documentChunks.body,score:sql<number>`pgroonga_score(tableoid, ctid)`}).from(documentChunks).where(filters).orderBy(desc(sql`pgroonga_score(tableoid, ctid)`)).limit(12);
}
