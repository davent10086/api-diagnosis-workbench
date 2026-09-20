import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { searchKnowledgeDetailed } from "@/lib/knowledge";
const schema = z.object({
  q: z.string().trim().min(1).max(200),
  vendor: z.string().trim().max(80).optional(),
});
export async function GET(request: NextRequest) {
  const parsed = schema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    vendor: request.nextUrl.searchParams.get("vendor") ?? undefined,
  });
  if (!parsed.success)
    return NextResponse.json({ error: "请输入 1–200 个字符的检索词。" }, { status: 400 });
  try {
    const result = await searchKnowledgeDetailed(parsed.data.q, parsed.data.vendor);
    if (result.meta.backend === "unavailable")
      return NextResponse.json({ items: result.items, meta: result.meta, error: "知识库暂不可用，请先运行迁移与导入命令。" }, { status: 503 });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "知识库暂不可用，请先运行迁移与导入命令。" },
      { status: 503 },
    );
  }
}
