import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentCaseNotFoundError, caseAgentInputSchema, runCaseAgent } from "@/lib/case-agent";

export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });
  const input = caseAgentInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return NextResponse.json({ error: "问题、历史或日志账号确认信息无效。" }, { status: 400 });
  try {
    const result = await runCaseAgent(
      id,
      input.data,
      AbortSignal.any([request.signal, AbortSignal.timeout(170000)]),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentCaseNotFoundError)
      return NextResponse.json({ error: error.message }, { status: 404 });
    if (request.signal.aborted)
      return NextResponse.json({ error: "自主分析已取消。" }, { status: 499 });
    return NextResponse.json(
      {
        error: "自主分析未完成，请检查百炼配置、模型工具调用支持情况或稍后重试；未生成已确认结论。",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
