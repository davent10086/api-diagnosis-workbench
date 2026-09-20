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
  } catch {
    return NextResponse.json({ error: "Unable to delete case." }, { status: 503 });
  }
}
