import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { evidenceAssets } from "@/db/schema";
import { isManagedStoragePath } from "@/lib/storage";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await params;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(assetId).success)
    return NextResponse.json({ error: "案件或附件 ID 无效。" }, { status: 400 });
  const [asset] = await db.select().from(evidenceAssets).where(and(eq(evidenceAssets.caseId, id), eq(evidenceAssets.id, assetId))).limit(1);
  const ext = asset?.filePath.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : undefined;
  if (!asset || !mime || !isManagedStoragePath(asset.filePath)) return NextResponse.json({ error: "未找到图片附件。" }, { status: 404 });
  try {
    const data = await readFile(resolve(process.cwd(), asset.filePath));
    return new Response(new Uint8Array(data), { headers: { "Content-Type": mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "图片文件不存在或暂时无法读取。" }, { status: 404 });
  }
}
