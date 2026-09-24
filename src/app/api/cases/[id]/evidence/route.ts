import { createHash, randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { cases, evidenceAssets } from "@/db/schema";
import { storageFilePath, storageRoot } from "@/lib/storage";

const MAX_BYTES = 10 * 1024 * 1024;
const extensionType: Record<string, "application/json" | "text/plain" | "image/png" | "image/jpeg"> = {
  json: "application/json", txt: "text/plain", log: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

function detectedMimeType(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? extensionType[ext] : undefined;
}

function validImageSignature(mimeType: string, data: Buffer) {
  if (mimeType === "image/png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return data[0] === 255 && data[1] === 216 && data[2] === 255;
  return true;
}

function inferEvidenceType(filename: string, mimeType: string, data: Buffer) {
  const name = filename.toLowerCase();
  if (mimeType.startsWith("image/")) return "screenshot";
  if (name.includes("trace")) return "trace";
  if (name.includes("sse") || name.includes("stream")) return "sse";
  if (name.includes("request")) return "request";
  if (name.includes("response")) return "response";
  if (name.includes("log") || /\b(error|exception|warn|info|debug)\b/i.test(data.toString("utf8", 0, 8_192))) return "backend_log";
  return "other";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BYTES + 100_000) return NextResponse.json({ error: "上传请求超过 10 MB 限制。" }, { status: 413 });

  const form = await request.formData().catch(() => undefined);
  if (!form) return NextResponse.json({ error: "无效的上传表单。" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES)
    return NextResponse.json({ error: "文件必须介于 1 B 和 10 MB 之间。" }, { status: 400 });

  const mimeType = detectedMimeType(file);
  if (!mimeType) return NextResponse.json({ error: "仅支持 PNG、JPEG、JSON、TXT 和 LOG 文件。" }, { status: 415 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });

  const [caseRecord] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, id)).limit(1).catch(() => []);
  if (!caseRecord) return NextResponse.json({ error: "案件不存在或数据库暂不可用。" }, { status: 404 });

  let data = Buffer.from(await file.arrayBuffer());
  if (!validImageSignature(mimeType, data)) return NextResponse.json({ error: "图片内容与文件类型不匹配。" }, { status: 415 });

  const redactionStatus = mimeType.startsWith("image/") ? "direct_upload" : "redacted";
  if (mimeType === "application/json") {
    try {
      const { redactValue } = await import("@/lib/redaction");
      data = Buffer.from(JSON.stringify(redactValue(JSON.parse(data.toString("utf8"))), null, 2), "utf8");
    } catch {
      return NextResponse.json({ error: "JSON 文件内容无效。" }, { status: 400 });
    }
  } else if (mimeType === "text/plain") {
    const { redact } = await import("@/lib/redaction");
    data = Buffer.from(redact(data.toString("utf8")), "utf8");
  }

  const safeName = basename(file.name).replace(/[^\w.\-]/g, "_");
  const storedName = `${randomUUID()}-${safeName || "evidence"}`;
  const root = storageRoot();
  const path = join(root, storedName);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path, data, { flag: "wx" });
    const [asset] = await db.insert(evidenceAssets).values({
      caseId: id,
      filePath: storageFilePath(storedName),
      fileHash: createHash("sha256").update(data).digest("hex"),
      evidenceType: inferEvidenceType(file.name, mimeType, data),
      redactionStatus,
      extraction: { originalName: file.name.slice(0, 255), mimeType, size: data.length },
    }).returning({ id: evidenceAssets.id });
    return NextResponse.json({ ...asset, mimeType, evidenceType: inferEvidenceType(file.name, mimeType, data) }, { status: 201 });
  } catch {
    await rm(path, { force: true }).catch(() => undefined);
    return NextResponse.json({ error: "无法保存证据。" }, { status: 503 });
  }
}
