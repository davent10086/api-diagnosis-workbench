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
const allowedTypes = new Set([
  "application/json",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
function validWebp(data: Buffer) {
  return data.length >= 12 && data.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    data.subarray(8, 12).equals(Buffer.from("WEBP"));
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BYTES + 100_000)
    return NextResponse.json({ error: "上传请求超过 10 MB 限制。" }, { status: 413 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "无效的上传表单。" }, { status: 400 });
  }
  const file = form.get("file");
  const evidenceType =
    typeof form.get("evidenceType") === "string"
      ? String(form.get("evidenceType")).slice(0, 40)
      : "attachment";
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES)
    return NextResponse.json({ error: "文件必须介于 1 B 和 10 MB 之间。" }, { status: 400 });
  if (!allowedTypes.has(file.type))
    return NextResponse.json({ error: "只支持 JSON、TXT、PNG 和 JPEG 文件。" }, { status: 415 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });
  let caseRecord;
  try {
    [caseRecord] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, id)).limit(1);
  } catch {
    return NextResponse.json({ error: "数据库暂不可用。" }, { status: 503 });
  }
  if (!caseRecord) return NextResponse.json({ error: "案件不存在。" }, { status: 404 });
  let data = Buffer.from(await file.arrayBuffer());
  if (
    file.type === "image/png" &&
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return NextResponse.json({ error: "PNG 文件签名无效。" }, { status: 415 });
  if (file.type === "image/jpeg" && (data[0] !== 255 || data[1] !== 216 || data[2] !== 255))
    return NextResponse.json({ error: "JPEG 文件签名无效。" }, { status: 415 });
  if (file.type === "image/webp" && !validWebp(data))
    return NextResponse.json({ error: "WEBP 文件签名无效。" }, { status: 415 });
  // Text is redacted server-side. Images are intentionally retained and made
  // available to the vision diagnosis flow without a separate confirmation step.
  let redactionStatus = file.type.startsWith("image/") ? "direct_upload" : "redacted";
  if (file.type === "application/json") {
    try {
      const { redactValue } = await import("@/lib/redaction");
      data = Buffer.from(
        JSON.stringify(redactValue(JSON.parse(data.toString("utf8"))), null, 2),
        "utf8",
      );
      redactionStatus = "redacted";
    } catch {
      return NextResponse.json({ error: "JSON 文件内容无效。" }, { status: 400 });
    }
  } else if (file.type === "text/plain") {
    const { redact } = await import("@/lib/redaction");
    data = Buffer.from(redact(data.toString("utf8")), "utf8");
    redactionStatus = "redacted";
  }
  const safeName = basename(file.name).replace(/[^\w.\-]/g, "_");
  const storedName = `${randomUUID()}-${safeName || "evidence"}`;
  let path: string | undefined;
  try {
    const root = storageRoot();
    path = join(root, storedName);
    await mkdir(root, { recursive: true });
    await writeFile(path, data, { flag: "wx" });
    const [asset] = await db
      .insert(evidenceAssets)
      .values({
        caseId: id,
        filePath: storageFilePath(storedName),
        fileHash: createHash("sha256").update(data).digest("hex"),
        evidenceType,
        redactionStatus,
        extraction: {
          originalName: file.name.slice(0, 255),
          mimeType: file.type,
          size: data.length,
        },
      })
      .returning({ id: evidenceAssets.id });
    return NextResponse.json(asset, { status: 201 });
  } catch {
    if (path) await rm(path, { force: true }).catch(() => undefined);
    return NextResponse.json({ error: "无法保存证据。" }, { status: 503 });
  }
}
