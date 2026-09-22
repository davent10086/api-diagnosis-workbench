import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { apiTraces, cases, ruleFindings } from "@/db/schema";
import { runRules } from "@/lib/rules";
import { buildReport } from "@/lib/report";
import { redactTrace } from "@/lib/redaction";
import { deleteCases } from "@/lib/delete-cases";

const shortString = z.string().max(10_000);
const traceSchema = z
  .object({
    customerQuestion: shortString.optional(),
    requestId: z.string().max(200).optional(),
    traceId: z.string().max(200).optional(),
    upstreamRequestId: z.string().max(200).optional(),
    provider: z.string().max(100).optional(),
    route: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    retryCount: z.number().int().min(0).max(100).optional(),
    retryReason: shortString.optional(),
    clientRequest: z.record(z.unknown()).optional(),
    transformedRequest: z.record(z.unknown()).optional(),
    upstreamResponse: z.record(z.unknown()).optional(),
    finalResponse: z.record(z.unknown()).optional(),
    logs: z.array(shortString).max(100).optional(),
    sse: z.array(shortString).max(1_000).optional(),
  })
  .refine((value) => JSON.stringify(value).length <= 512_000, "追踪数据过大。");
const createSchema = z.object({ title: z.string().trim().min(1).max(200), trace: traceSchema });

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 600_000)
    return NextResponse.json({ error: "追踪数据超过 600 KB 限制。" }, { status: 413 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON。" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "案件或追踪数据无效。" }, { status: 400 });
  const trace = redactTrace(parsed.data.trace);
  const findings = runRules(trace);
  const report = buildReport(trace, findings);
  try {
    const result = await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(cases)
        .values({
          title: parsed.data.title,
          status: "uploading",
          summary: report.symptom,
          finalConclusion: report.external_message,
        })
        .returning({ id: cases.id });
      await tx.insert(apiTraces).values({
        caseId: item.id,
        customerQuestion: trace.customerQuestion,
        requestId: trace.requestId,
        traceId: trace.traceId,
        upstreamRequestId: trace.upstreamRequestId,
        provider: trace.provider,
        route: trace.route,
        model: trace.model,
        statusCode: trace.statusCode,
        retry:
          trace.retryCount === undefined
            ? undefined
            : { count: trace.retryCount, reason: trace.retryReason },
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
            caseId: item.id,
            ruleId: finding.ruleId,
            severity: finding.severity,
            faultLayer: finding.faultLayer,
            evidence: finding.evidence,
            conclusion: finding.conclusion,
            needsMoreEvidence: finding.needsMoreEvidence,
          })),
        );
      return item;
    });
    return NextResponse.json({ id: result.id, findings, report }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "无法保存案件，请确认数据库迁移已完成。" }, { status: 503 });
  }
}

function deleteErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to clear cases.";
  const safeMessage = /^Cannot delete a case while diagnosis is running\.$/.test(message)
    ? message
    : "Unable to clear cases.";
  return NextResponse.json({ error: safeMessage }, { status: 503 });
}

export async function DELETE() {
  try {
    const items = await db.select({ id: cases.id }).from(cases);
    await deleteCases(items.map((item) => item.id));
    return NextResponse.json({ deleted: items.length });
  } catch (error) {
    return deleteErrorResponse(error);
  }
}
