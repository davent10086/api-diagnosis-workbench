import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { evidenceAssets } from "@/db/schema";
import { assertNotAborted, openAICompatibleCompletion } from "@/lib/diagnosis-model";

export type ImageExtraction = {
  status: "completed" | "failed";
  error?: string;
  fields?: string[];
  summary?: string;
};

export async function extractImage(
  asset: { id: string; filePath: string; extraction: unknown },
  signal?: AbortSignal,
) {
  const existing = asset.extraction as ImageExtraction | null;
  if (existing?.status === "completed") return existing;
  try {
    const data = await readFile(resolve(process.cwd(), asset.filePath));
    const mime = asset.filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const content = await openAICompatibleCompletion(
      process.env.QWEN_VISION_MODEL || "qwen-vl-max",
      [
        {
          role: "system",
          content:
            "你是 API 排障证据提取助手。仅提取图片中实际可见的 API 排障事实，不要推测或补全。所有说明性文本必须使用简体中文；错误码、时间戳、请求 ID、Trace ID、接口地址、模型名和原始日志片段必须保持原样。仅输出包含 summary 和 fields 的 JSON 对象。",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请提取图片中可见的错误码、时间戳、请求 ID、Trace ID、接口地址、HTTP 状态码和日志线索。summary 与 fields 中的说明使用简体中文；技术标识符和原始日志片段保持原样。",
            },
            { type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}` } },
          ],
        },
      ],
      { response_format: { type: "json_object" } },
      signal,
    );
    const fieldValue = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])).max(30),
    ]);
    const parsed = z
      .object({
        summary: z.string().max(3000),
        fields: z.union([
          z.array(z.string().max(500)).max(30),
          z.record(fieldValue).refine(
            (value) => Object.keys(value).length <= 30,
            "too many fields",
          ),
        ]),
      })
      .parse(JSON.parse(content));
    const fields = Array.isArray(parsed.fields)
      ? parsed.fields
      : Object.entries(parsed.fields).flatMap(([key, value]) =>
          value === null
            ? []
            : [`${key}=${(Array.isArray(value) ? value.join("；") : String(value)).slice(0, 450)}`],
        );
    const result: ImageExtraction = { status: "completed", summary: parsed.summary, fields };
    await db
      .update(evidenceAssets)
      .set({ extraction: result })
      .where(eq(evidenceAssets.id, asset.id));
    return result;
  } catch (error) {
    const result: ImageExtraction = {
      status: "failed",
      error: error instanceof Error ? error.message : "Image extraction failed.",
    };
    await db
      .update(evidenceAssets)
      .set({ extraction: result })
      .where(eq(evidenceAssets.id, asset.id));
    return result;
  }
}

export async function extractImages(
  assets: { id: string; filePath: string; extraction: unknown }[],
  concurrency: number,
  signal?: AbortSignal,
) {
  const results = new Array<ImageExtraction>(assets.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, async () => {
    while (nextIndex < assets.length) {
      const index = nextIndex++;
      assertNotAborted(signal);
      results[index] = await extractImage(assets[index], signal);
    }
  }));
  return results;
}
