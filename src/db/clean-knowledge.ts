import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const sourceRoot = process.env.KNOWLEDGE_SOURCE_PATH ?? "C:/Users/EDY/Desktop/work/llm-official-documentation";
const outputRoot = process.env.KNOWLEDGE_CLEAN_PATH ?? "knowledge/official-clean";
const ignoredFiles = new Set(["README.md", "KNOWLEDGE-BASE.md", "CONVENTIONS.md", "USAGE.md"]);
const ignoredDirectories = new Set([".claude", ".git", "node_modules"]);

type Report = {
  sourceRoot: string;
  outputRoot: string;
  scanned: number;
  kept: number;
  skipped: Record<string, number>;
  skippedFiles: Array<{ path: string; reason: string }>;
  vendors: Record<string, number>;
};

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : markdownFiles(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
}

function frontmatter(raw: string) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { fields, body: raw.slice(match[0].length).trim() };
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

async function main() {
  const source = await stat(sourceRoot).catch(() => null);
  if (!source?.isDirectory()) throw new Error(`Knowledge source directory does not exist: ${sourceRoot}`);

  const report: Report = { sourceRoot, outputRoot, scanned: 0, kept: 0, skipped: {}, skippedFiles: [], vendors: {} };
  const knownContent = new Set<string>();
  const files = await markdownFiles(sourceRoot);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  for (const file of files) {
    report.scanned++;
    if (ignoredFiles.has(file.split(/[\\/]/).at(-1) ?? "")) {
      report.skipped["non-knowledge-file"] = (report.skipped["non-knowledge-file"] ?? 0) + 1;
      report.skippedFiles.push({ path: relative(sourceRoot, file), reason: "non-knowledge-file" });
      continue;
    }
    const parsed = frontmatter(await readFile(file, "utf8"));
    const sourceUrl = parsed?.fields.get("source");
    if (!parsed || !sourceUrl) {
      report.skipped["missing-source-frontmatter"] = (report.skipped["missing-source-frontmatter"] ?? 0) + 1;
      report.skippedFiles.push({ path: relative(sourceRoot, file), reason: "missing-source-frontmatter" });
      continue;
    }
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      report.skipped["invalid-source-url"] = (report.skipped["invalid-source-url"] ?? 0) + 1;
      report.skippedFiles.push({ path: relative(sourceRoot, file), reason: "invalid-source-url" });
      continue;
    }
    if (parsed.body.length < 30) {
      report.skipped["too-short"] = (report.skipped["too-short"] ?? 0) + 1;
      report.skippedFiles.push({ path: relative(sourceRoot, file), reason: "too-short" });
      continue;
    }
    const fingerprint = createHash("sha256").update(parsed.body).digest("hex");
    if (knownContent.has(fingerprint)) {
      report.skipped["duplicate-content"] = (report.skipped["duplicate-content"] ?? 0) + 1;
      report.skippedFiles.push({ path: relative(sourceRoot, file), reason: "duplicate-content" });
      continue;
    }
    knownContent.add(fingerprint);

    const relativePath = relative(sourceRoot, file).replace(/\\/g, "/");
    const vendor = relativePath.split("/")[0];
    const outputFile = join(outputRoot, vendor, safeFileName(relativePath.slice(vendor.length + 1)));
    const fetchedAt = parsed.fields.get("fetched_at");
    const metadata = ["---", `source: ${sourceUrl}`, fetchedAt ? `fetched_at: ${fetchedAt}` : "", "---", ""].filter(Boolean).join("\n");
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${metadata}\n${parsed.body}\n`, "utf8");
    report.kept++;
    report.vendors[vendor] = (report.vendors[vendor] ?? 0) + 1;
  }

  await writeFile(join(outputRoot, "CLEANING-REPORT.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    join(outputRoot, "KNOWLEDGE-BASE.md"),
    `# Clean official LLM documentation\n\nGenerated from: ${sourceRoot}\n\nKept: ${report.kept}; scanned: ${report.scanned}. See CLEANING-REPORT.json for details.\n`,
    "utf8",
  );
  console.log(`Cleaned ${report.kept}/${report.scanned} documents into ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
