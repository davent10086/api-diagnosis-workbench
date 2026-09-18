import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { cases } from "@/db/schema";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });
  try {
    const [item] = await db
      .update(cases)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(cases.id, id))
      .returning({ id: cases.id });
    return item
      ? NextResponse.json(item)
      : NextResponse.json({ error: "案件不存在。" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "数据库暂不可用。" }, { status: 503 });
  }
}
