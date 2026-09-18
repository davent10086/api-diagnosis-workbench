import { NextResponse } from "next/server";
import { z } from "zod";
import { DiagnosisConflictError, DiagnosisNotFoundError, runDiagnosis } from "@/lib/diagnosis";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "案件 ID 无效。" }, { status: 400 });
  try {
    return NextResponse.json(await runDiagnosis(id, request.signal));
  } catch (error) {
    if (error instanceof DiagnosisNotFoundError)
      return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof DiagnosisConflictError)
      return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI 诊断失败。" }, { status: 503 });
  }
}
