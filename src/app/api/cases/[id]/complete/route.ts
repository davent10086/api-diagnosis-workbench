import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { cases } from "@/db/schema";
import { caseStatus } from "@/lib/case-status";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });
  try {
    const [item] = await db
      .update(cases)
      .set({ status: caseStatus.completed, updatedAt: new Date() })
      .where(and(eq(cases.id, id), eq(cases.status, caseStatus.uploading)))
      .returning({ id: cases.id });
    if (item) return NextResponse.json(item);
    const [existing] = await db.select({ status: cases.status }).from(cases).where(eq(cases.id, id)).limit(1);
    return existing
      ? NextResponse.json({ error: "案件当前状态不能完成。" }, { status: 409 })
      : NextResponse.json({ error: "案件不存在。" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "数据库暂不可用。" }, { status: 503 });
  }
}
