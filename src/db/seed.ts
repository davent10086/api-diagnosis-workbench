import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { cases, documentChunks } from "./schema";
config({ path: ".env.local" });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 未配置");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
async function seed() {
  const documents = [
    {
      title: "Amazon Bedrock Converse API 工具使用",
      body: "Tool use must be supported by the selected model.",
      vendor: "AWS",
      category: "工具",
      priority: 10,
      sourceUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html",
    },
    {
      title: "Anthropic Messages streaming",
      body: "Server-sent events stream message content blocks.",
      vendor: "Anthropic",
      category: "SSE",
      priority: 10,
      sourceUrl: "https://docs.anthropic.com/en/api/messages-streaming",
    },
    {
      title: "OpenAI error codes",
      body: "429 indicates rate limit or quota conditions.",
      vendor: "OpenAI",
      category: "错误码",
      priority: 9,
      sourceUrl: "https://platform.openai.com/docs/guides/error-codes",
    },
    {
      title: "Gemini API troubleshooting",
      body: "Troubleshooting common API request errors.",
      vendor: "Google",
      category: "排障",
      priority: 8,
      sourceUrl: "https://ai.google.dev/gemini-api/docs/troubleshooting",
    },
    {
      title: "HTTP 缓存排障",
      body: "排查缓存时，应同时记录 Cache-Control、Age、ETag、Vary 与响应中的 cache status。确认请求是否命中缓存（cache HIT）或未命中（cache MISS），并比较 URL、方法、认证信息和请求头是否改变了缓存键。",
      vendor: "MDN",
      category: "缓存",
      priority: 9,
      sourceUrl: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",
    },
  ];
  for (const document of documents) {
    const exists = await db
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .where(eq(documentChunks.sourceUrl, document.sourceUrl))
      .limit(1);
    if (!exists.length) await db.insert(documentChunks).values(document);
  }
  const examples = [
    {
      title: "Bedrock web_search_20250305 不兼容",
      status: "completed",
      summary: "ValidationException",
      finalConclusion: "工具不兼容",
      confidence: 0.92,
    },
    {
      title: "SSE stop 缺少 start",
      status: "completed",
      summary: "SSE lifecycle",
      confidence: 0.85,
    },
    {
      title: "502 + context canceled",
      status: "needs_evidence",
      summary: "需区分网关与上游",
      confidence: 0.55,
    },
  ] as const;
  for (const example of examples) {
    const exists = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.title, example.title))
      .limit(1);
    if (!exists.length) await db.insert(cases).values(example);
  }
  console.log("Seed 完成");
  await pool.end();
}
seed().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
