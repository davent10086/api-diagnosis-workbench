import { createHash, randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { cases, evidenceAssets } from "@/db/schema";

const MAX_BYTES = 10 * 1024 * 1024;
const allowedTypes = new Set(["application/json", "text/plain", "image/png", "image/jpeg"]);
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
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES)
    return NextResponse.json({ error: "文件必须介于 1 B 和 10 MB 之间。" }, { status: 400 });
  if (!allowedTypes.has(file.type))
    return NextResponse.json({ error: "只支持 JSON、TXT、PNG 和 JPEG 文件。" }, { status: 415 });
  const { id } = await params;
  const [caseRecord] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.id, id))
    .limit(1);
  if (!caseRecord) return NextResponse.json({ error: "案件不存在。" }, { status: 404 });
  let data = Buffer.from(await file.arrayBuffer());
  if (
    file.type === "image/png" &&
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return NextResponse.json({ error: "PNG 文件签名无效。" }, { status: 415 });
  if (file.type === "image/jpeg" && (data[0] !== 255 || data[1] !== 216 || data[2] !== 255))
    return NextResponse.json({ error: "JPEG 文件签名无效。" }, { status: 415 });
  let redactionStatus = "manual_review_required";
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
  const root = join(process.cwd(), "storage");
  const path = join(root, storedName);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path, data, { flag: "wx" });
    const [asset] = await db
      .insert(evidenceAssets)
      .values({
        caseId: id,
        filePath: join("storage", storedName),
        fileHash: createHash("sha256").update(data).digest("hex"),
        evidenceType: "attachment",
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
    await rm(path, { force: true }).catch(() => undefined);
    return NextResponse.json({ error: "无法保存证据。" }, { status: 503 });
  }
}
