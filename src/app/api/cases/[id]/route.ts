import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteCases } from "@/lib/delete-cases";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "Invalid case ID." }, { status: 400 });
  try {
    const deleted = await deleteCases([id]);
    return deleted
      ? NextResponse.json({ deleted: 1 })
      : NextResponse.json({ error: "Case not found." }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete case.";
    const safeMessage = /^Cannot delete a case while diagnosis is running\.$/.test(message)
      ? message
      : "Unable to delete case.";
    return NextResponse.json({ error: safeMessage }, { status: 503 });
  }
}
