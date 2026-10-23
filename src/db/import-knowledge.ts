import { config } from "dotenv";
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import { db, pool } from "./client";
import { documentChunks } from "./schema";
import { eq } from "drizzle-orm";
config({ path: ".env.local" });
const root = process.env.KNOWLEDGE_BASE_PATH;
const vendorArgument = process.argv.find((argument) => argument.startsWith("--vendor="))?.slice(9);
type Chunk = {
  title: string;
  body: string;
  vendor: string;
  category: string;
  sourceUrl: string;
  priority: number;
  fetchedAt: Date;
};
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : e.name.endsWith(".md")
          ? [join(dir, e.name)]
          : [],
    ),
  );
  return nested.flat();
}
function parse(raw: string, file: string): Chunk[] {
  const meta = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const front = meta?.[1] ?? "";
  const source = front.match(/^source:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const fetched = front.match(/^fetched_at:\s*(.+)$/m)?.[1]?.trim();
  const fetchedAt = fetched ? new Date(fetched) : new Date();
  if (Number.isNaN(fetchedAt.getTime())) throw new Error(`知识文档抓取日期无效: ${file}`);
  const commit = front.match(/^github_commit:\s*(.+)$/m)?.[1]?.trim();
  const context = commit ? `来源版本：GitHub commit ${commit}。适用性需结合部署版本核对。\n\n` : "";
  const content = raw.slice(meta?.[0].length ?? 0);
  const parts = content.split(/(?=^#{1,3}\s+)/m).filter(Boolean);
  const vendor = file.split(/[\\/]/)[0].replaceAll("-", " ");
  return parts
    .flatMap((part, i) => {
      const lines = part.trim().split("\n");
      const heading = lines[0].replace(/^#+\s*/, "").trim();
      const body = part.trim();
      if (body.length <= 30) return [];
      const chunks: Chunk[] = [];
      for (let start = 0; start < body.length; start += 5000) {
        const partNumber = chunks.length + 1;
        chunks.push({
          title: `${commit ? "new-api · " : ""}${partNumber === 1 ? heading || file : `${heading || file} (part ${partNumber})`}`,
          body: context + body.slice(start, start + 5000),
          vendor,
          category: file.replace(/\.md$/, ""),
          sourceUrl: source,
          priority: i === 0 && partNumber === 1 ? 10 : 5,
          fetchedAt,
        });
      }
      return chunks;
    })
    .filter((x) => x.body.length > 0);
}
async function main() {
  if (!root) throw new Error("KNOWLEDGE_BASE_PATH 未配置");
  if (vendorArgument !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vendorArgument)) throw new Error("--vendor 必须是厂商目录名，例如 new-api");
  const paths = await files(vendorArgument ? join(root, vendorArgument) : root);
  const records: Chunk[] = [];
  let importedFiles = 0;
  for (const path of paths) {
    if (/(?:^|[\\/])(README|KNOWLEDGE-BASE)\.md$/i.test(path)) continue;
    const raw = await readFile(path, "utf8");
    const chunks = parse(raw, relative(root, path));
    if (!chunks.length) continue;
    for (const chunk of chunks) {
      try {
        const url = new URL(chunk.sourceUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
      } catch {
        throw new Error(`知识文档缺少有效 source URL: ${relative(root, path)}`);
      }
    }
    records.push(...chunks);
    importedFiles++;
  }
  if (!records.length) throw new Error("没有可导入的知识文档块；数据库保持不变。");
  await db.transaction(async (tx) => {
    if (vendorArgument) await tx.delete(documentChunks).where(eq(documentChunks.vendor, vendorArgument.replaceAll("-", " ")));
    else await tx.delete(documentChunks);
    for (let i = 0; i < records.length; i += 100) {
      await tx
        .insert(documentChunks)
        .values(records.slice(i, i + 100));
    }
  });
  console.log(`已导入 ${records.length} 个文档块，来源 ${importedFiles} 个 Markdown 文件。`);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
