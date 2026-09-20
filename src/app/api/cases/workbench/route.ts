import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { apiTraces, cases } from "@/db/schema";

const text = z.string().max(10_000).optional();
const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  question: text,
  metadata: z.object({
    provider: z.string().max(100),
    model: z.string().max(200),
    route: z.string().max(500),
    statusCode: z.string().max(3),
    requestId: z.string().max(200),
    upstreamRequestId: z.string().max(200),
    occurredAt: z.string().max(100),
  }),
  advanced: z.object({
    trace: text,
    requestHeaders: text,
    response: text,
    sse: text,
    context: text,
  }),
});
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid workbench payload." }, { status: 400 });
  const { title, question, metadata, advanced } = parsed.data;
  try {
    const [item] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(cases)
        .values({ title, status: "uploading", summary: question || null })
        .returning({ id: cases.id });
      await tx
        .insert(apiTraces)
        .values({
          caseId: created.id,
          customerQuestion: question || null,
          requestId: metadata.requestId || null,
          traceId: advanced.trace ? "advanced-trace" : null,
          upstreamRequestId: metadata.upstreamRequestId || null,
          provider: metadata.provider || null,
          route: metadata.route || null,
          model: metadata.model || null,
          statusCode: metadata.statusCode ? Number(metadata.statusCode) : null,
          clientRequest: advanced.requestHeaders ? { raw: advanced.requestHeaders } : null,
          upstreamResponse: advanced.response ? { raw: advanced.response } : null,
          sse: advanced.sse ? [advanced.sse] : null,
          logs: advanced.context ? [advanced.context] : null,
        });
      return [created];
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Unable to save workbench." }, { status: 503 });
  }
}
