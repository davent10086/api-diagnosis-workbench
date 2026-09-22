import { config } from "dotenv";

config({ path: ".env.local" });

type Scenario = {
  name: string;
  query: string;
  vendor: string;
  expectedTitle: RegExp;
};

const scenarios: Scenario[] = [
  { name: "OpenAI 速率限制", query: "429 rate limit", vendor: "openai", expectedTitle: /错误|error/i },
  { name: "Anthropic SSE", query: "streaming SSE event", vendor: "anthropic", expectedTitle: /stream|SSE/i },
  { name: "Gemini 批处理", query: "batchGenerateContent", vendor: "google gemini", expectedTitle: /batch/i },
  { name: "DeepSeek 错误码", query: "错误码 error code", vendor: "deepseek", expectedTitle: /错误|error/i },
  { name: "百炼嵌入", query: "embeddings 向量", vendor: "alibaba bailian", expectedTitle: /embedding/i },
  { name: "MiniMax 消息请求", query: "messages", vendor: "minimax", expectedTitle: /messages/i },
  { name: "Moonshot 限流", query: "rate limit", vendor: "moonshot", expectedTitle: /rate|limit|限速/i },
  { name: "火山 OpenAI 兼容", query: "OpenAI compatibility", vendor: "volcengine", expectedTitle: /openai/i },
  { name: "智谱鉴权", query: "API Key 鉴权", vendor: "zhipu", expectedTitle: /auth|key|鉴权/i },
  { name: "OpenRouter 模型路由", query: "model routing", vendor: "openrouter", expectedTitle: /routing|路由/i },
];

async function main() {
  const { searchKnowledgeDetailed } = await import("../../src/lib/knowledge");
  const { db } = await import("../../src/db/client");
  const { documentChunks } = await import("../../src/db/schema");
  const { count } = await import("drizzle-orm");
  const [{ total }] = await db.select({ total: count() }).from(documentChunks);
  const vendors = await db
    .select({ vendor: documentChunks.vendor, total: count() })
    .from(documentChunks)
    .groupBy(documentChunks.vendor)
    .orderBy(documentChunks.vendor);
  console.log(`Indexed chunks: ${total}`);
  console.table(vendors);
  const rows = [] as Array<Record<string, unknown>>;

  for (const scenario of scenarios) {
    const result = await searchKnowledgeDetailed(scenario.query, scenario.vendor);
    const top = result.items[0];
    const vendorMatched = top?.vendor.toLowerCase() === scenario.vendor;
    const topTitleMatched = Boolean(top && scenario.expectedTitle.test(top.title));
    const titleMatched = result.items.slice(0, 5).some((item) => scenario.expectedTitle.test(item.title));
    rows.push({
      scenario: scenario.name,
      query: scenario.query,
      expectedVendor: scenario.vendor,
      hitCount: result.items.length,
      topVendor: top?.vendor ?? "",
      topTitle: top?.title ?? "",
      topFiveTitles: result.items.slice(0, 5).map((item) => item.title).join(" | "),
      backend: result.meta.backend,
      fallbackToAll: result.meta.fallbackToAll,
      precisionAt1: Boolean(top) && vendorMatched && topTitleMatched,
      recallAt5: Boolean(top) && vendorMatched && titleMatched,
    });
  }

  console.table(rows);
  const precisionAt1 = rows.filter((row) => row.precisionAt1).length;
  const recallAt5 = rows.filter((row) => row.recallAt5).length;
  console.log(`Knowledge retrieval regression: Precision@1 ${precisionAt1}/${rows.length}; Recall@5 ${recallAt5}/${rows.length}`);
  if (recallAt5 !== rows.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
