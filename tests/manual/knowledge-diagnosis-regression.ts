import { knowledgeQueries } from "../../src/lib/diagnosis-retrieval";
import { searchKnowledgeQueries } from "../../src/lib/knowledge";
import { runRules } from "../../src/lib/rules";
import { pool } from "../../src/db/client";
import type { Trace } from "../../src/lib/types";

// Read-only regression against the imported local knowledge base; no model calls.
async function main() {
  const cases: { name: string; trace: Trace; expectedQuery: string; expectedExcerpt: RegExp }[] = [
    { name: "Bedrock exact tool compatibility", trace: { provider: "aws", route: "bedrock", statusCode: 400, clientRequest: { tools: [{ type: "web_search_20250305" }] }, upstreamResponse: { error: { type: "ValidationException", message: "tool is not supported" } } }, expectedQuery: "web_search_20250305", expectedExcerpt: /web_search_20250305[^\n]*not supported/i },
    { name: "Late throttling error", trace: { provider: "aws", logs: ["request_id=" + "x".repeat(250) + " ThrottlingException 429"] }, expectedQuery: "ThrottlingException", expectedExcerpt: /ThrottlingException/i },
    { name: "Numeric HTTP status", trace: { provider: "openai", statusCode: 429 }, expectedQuery: "429", expectedExcerpt: /429|rate.limit/i },
  ];
  for (const item of cases) {
    const queries = knowledgeQueries(item.trace, runRules(item.trace), []);
    const result = await searchKnowledgeQueries(queries.map((q) => q.value), item.trace.provider);
    const matched = queries.some((q) => q.value === item.expectedQuery) && result.items.some((hit) => item.expectedExcerpt.test(hit.excerpt ?? ""));
    console.log(JSON.stringify({ name: item.name, passed: matched, queries, titles: result.items.map((hit) => hit.title) }));
    if (!matched) process.exitCode = 1;
  }
  const plan = await pool.query("EXPLAIN SELECT id FROM document_chunks WHERE (coalesce(title, '') || ' ' || coalesce(category, '') || ' ' || coalesce(body, '')) &@ 'ValidationException'");
  console.log(JSON.stringify({ searchPlan: plan.rows }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Knowledge diagnosis regression failed");
  process.exitCode = 1;
}).finally(() => pool.end());
