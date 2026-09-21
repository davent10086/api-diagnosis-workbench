import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { diagnosisReviews, diagnosisRuns } from "@/db/schema";

const bodySchema = z.object({
  diagnosisId: z.string().uuid(),
  verdict: z.enum(["confirmed", "rejected", "corrected"]),
  correctedRootCause: z.string().trim().max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
}).superRefine((value, ctx) => {
  if (value.verdict === "corrected" && !value.correctedRootCause)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "correctedRootCause is required for corrected verdict" });
  if (value.verdict === "rejected" && !value.notes)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "notes is required for rejected verdict" });
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  if (!z.string().uuid().safeParse(caseId).success)
    return NextResponse.json({ error: "Invalid case ID." }, { status: 400 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Invalid review payload." }, { status: 400 });
  const [run] = await db.select({ id: diagnosisRuns.id }).from(diagnosisRuns)
    .where(and(eq(diagnosisRuns.id, parsed.data.diagnosisId), eq(diagnosisRuns.caseId, caseId))).limit(1);
  if (!run) return NextResponse.json({ error: "Diagnosis run not found." }, { status: 404 });
  const [review] = await db.insert(diagnosisReviews).values({
    diagnosisId: run.id,
    verdict: parsed.data.verdict,
    correctedRootCause: parsed.data.correctedRootCause,
    notes: parsed.data.notes,
  }).returning();
  return NextResponse.json(review, { status: 201 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  if (!z.string().uuid().safeParse(caseId).success)
    return NextResponse.json({ error: "Invalid case ID." }, { status: 400 });
  const rows = await db.select({ id: diagnosisReviews.id, diagnosisId: diagnosisReviews.diagnosisId, verdict: diagnosisReviews.verdict, correctedRootCause: diagnosisReviews.correctedRootCause, notes: diagnosisReviews.notes, createdAt: diagnosisReviews.createdAt })
    .from(diagnosisReviews).innerJoin(diagnosisRuns, eq(diagnosisReviews.diagnosisId, diagnosisRuns.id))
    .where(eq(diagnosisRuns.caseId, caseId)).orderBy(desc(diagnosisReviews.createdAt));
  return NextResponse.json(rows);
}
