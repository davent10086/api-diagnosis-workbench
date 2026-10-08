import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { recognizeImage } from "../../src/lib/diagnosis-image";
import { imageRuleFindings } from "../../src/lib/image-evidence";
import { pool } from "../../src/db/client";
import { z } from "zod";

// Explicit live opt-in. Reads the selected files; writes only an ignored local result.
async function main() {
  if (process.env.RUN_LIVE_VISION_TESTS !== "1") throw new Error("Set RUN_LIVE_VISION_TESTS=1 to authorize sending selected screenshots to the configured vision provider.");
  const root = process.argv[2];
  if (!root) throw new Error("Pass the local error screenshot directory.");
  // Keep private filenames, request IDs and expected values in an ignored local manifest.
  const manifest = process.argv[3] || "test-results/vision-error-cases.json";
  const samples = z.array(z.object({ file: z.string(), required: z.array(z.string()), forbiddenStatus: z.boolean() })).parse(JSON.parse(await readFile(manifest, "utf8")))
    .filter((sample) => !process.env.VISION_SAMPLE_FILTER || sample.file.includes(process.env.VISION_SAMPLE_FILTER));
  if (!samples.length) throw new Error("No matching screenshot samples in the local manifest.");
  const results = [];
  for (const sample of samples) {
    try {
    const result = await recognizeImage(await readFile(resolve(root, sample.file)), "image/png");
    const text = (result.fields ?? []).join("\n").replace(/,/g, "");
    const missing = sample.required.filter((value) => !text.includes(value));
    const inventedStatus = sample.forbiddenStatus && (result.fields ?? []).some((field) => /(?:http.*(?:status|状态)|状态码|status_code)\s*[:=：]\s*[1-5]\d{2}/i.test(field));
    const inventedRetryCount = (result.fields ?? []).some((field) => /(?:retry[_\s-]*count|重试次数)\s*[:=：]\s*\d+/i.test(field));
    const passed = result.status === "completed" && missing.length === 0 && !inventedStatus && !inventedRetryCount && Boolean(result.observations?.length);
    results.push({ file: sample.file, passed, missing, inventedStatus, inventedRetryCount, result, candidateRules: imageRuleFindings({}, [{ id: "test-image", ...result }], []) });
    console.log(JSON.stringify({ file: sample.file, passed, missingCount: missing.length, inventedStatus, inventedRetryCount, fieldCount: result.fields?.length ?? 0 }));
    if (!passed) process.exitCode = 1;
    } catch (error) {
      results.push({ file: sample.file, passed: false, error: error instanceof Error ? error.message : "Image recognition failed" });
      console.log(JSON.stringify({ file: sample.file, passed: false, extractionFailed: true }));
      process.exitCode = 1;
    }
  }
  await mkdir("test-results", { recursive: true });
  const suffix = process.env.VISION_SAMPLE_FILTER ? `-${process.env.VISION_SAMPLE_FILTER.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
  const output = join("test-results", `vision-error-eval${suffix}.json`);
  await writeFile(output, JSON.stringify({ model: process.env.QWEN_VISION_MODEL || "qwen-vl-max", results }, null, 2), "utf8");
  console.log(`Saved local evaluation: ${output}`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Vision evaluation failed"); process.exitCode = 1; }).finally(() => pool.end());
