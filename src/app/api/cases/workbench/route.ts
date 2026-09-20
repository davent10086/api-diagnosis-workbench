import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { apiTraces, cases, ruleFindings } from "@/db/schema";
import { buildReport } from "@/lib/report";
import { runRules } from "@/lib/rules";
import { buildWorkbenchTrace } from "@/lib/workbench-trace";

const text = z.string().max(10_000).optional();
const traceText = z.string().max(512_000).optional();
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
    trace: traceText,
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
  let trace;
  try {
    trace = buildWorkbenchTrace({ question, metadata, advanced });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "追踪数据无效。" },
      { status: 400 },
    );
  }
  const findings = runRules(trace);
  const report = buildReport(trace, findings);
  try {
    const [item] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(cases)
        .values({ title, status: "uploading", summary: report.symptom, finalConclusion: report.external_message, confidence: report.confidence / 100 })
        .returning({ id: cases.id });
      await tx
        .insert(apiTraces)
        .values({
          caseId: created.id,
          customerQuestion: trace.customerQuestion,
          requestId: trace.requestId,
          traceId: trace.traceId,
          upstreamRequestId: trace.upstreamRequestId,
          provider: trace.provider,
          route: trace.route,
          model: trace.model,
          statusCode: trace.statusCode,
          retry: trace.retryCount === undefined ? undefined : { count: trace.retryCount, reason: trace.retryReason },
          clientRequest: trace.clientRequest,
          transformedRequest: trace.transformedRequest,
          upstreamResponse: trace.upstreamResponse,
          finalResponse: trace.finalResponse,
          logs: trace.logs,
          sse: trace.sse,
        });
      if (findings.length)
        await tx.insert(ruleFindings).values(
          findings.map((finding) => ({
            caseId: created.id,
            ruleId: finding.ruleId,
            severity: finding.severity,
            faultLayer: finding.faultLayer,
            evidence: finding.evidence,
            conclusion: finding.conclusion,
            needsMoreEvidence: finding.needsMoreEvidence,
          })),
        );
      return [created];
    });
    return NextResponse.json({ ...item, findings, report }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Unable to save workbench." }, { status: 503 });
  }
}
