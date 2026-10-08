import type { Finding, Trace } from "./types";

export type ConclusionStatus = "confirmed" | "provisional" | "insufficient";
export type EvidenceLedgerItem = {
  id: string;
  source: "trace" | "rule" | "text" | "image";
  kind: "fact" | "candidate" | "blocker";
  statement: string;
};

type ReportLike = {
  root_cause: string;
  confirmed_evidence: string[];
  hypotheses: string[];
  missing_evidence: string[];
  customer_message: string;
  root_cause_evidence?: string[];
};

export function parseEvidenceReference(value: string) {
  const match = /^(rule|trace|knowledge|image|text):([A-Za-z0-9_.-]+)(\[\d+\])?(?=$|[\s:=：,，；;])/.exec(value.trim());
  return match ? { source: match[1], id: match[2] + (match[3] ?? "") } : null;
}

export function buildEvidenceLedger(
  trace: Trace,
  findings: Finding[],
  textEvidence: { id: string; content: string }[],
  images: { id: string; fields?: string[]; summary?: string; observations?: { name: string; value: string; quote: string; location?: string }[] }[],
): EvidenceLedgerItem[] {
  const items: EvidenceLedgerItem[] = [];
  for (const [key, value] of Object.entries(trace)) {
    if (value !== undefined && value !== null && value !== "")
      items.push({ id: `trace:${key}`, source: "trace", kind: "fact", statement: `${key}=${typeof value === "string" ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500)}` });
  }
  for (const finding of findings)
    items.push({ id: `rule:${finding.ruleId}`, source: "rule", kind: finding.needsMoreEvidence ? "blocker" : "fact", statement: finding.conclusion });
  for (const text of textEvidence)
    items.push({ id: `text:${text.id}`, source: "text", kind: "candidate", statement: text.content.slice(0, 500) });
  for (const image of images) {
    items.push({ id: `image:${image.id}`, source: "image", kind: "candidate", statement: [image.summary, ...(image.fields ?? [])].filter(Boolean).join("; ").slice(0, 500) });
    for (const [index, field] of (image.fields ?? []).entries()) {
      const observation = image.observations?.find((item) => `${item.name}=${item.value}` === field);
      items.push({ id: `image:${image.id}[${index}]`, source: "image", kind: "candidate", statement: `${field}${observation ? `；原文：${observation.quote}${observation.location ? `；位置：${observation.location}` : ""}` : "；待结合原图核对"}`.slice(0, 1500) });
    }
  }
  return items;
}

export function adjudicateReport(
  report: ReportLike,
  findings: Finding[],
  additionalBlockers: string[] = [],
): { conclusionStatus: ConclusionStatus; blockers: string[]; customerMessage: string } {
  const blockers = [...additionalBlockers, ...findings.filter((item) => item.needsMoreEvidence).map((item) => `rule:${item.ruleId} — ${item.conclusion}`)];
  const definitiveRules = new Set(findings.filter((item) => !item.needsMoreEvidence).map((item) => item.ruleId));
  const rootCauseEvidence = report.root_cause_evidence ?? [];
  const rootCauseReferences = rootCauseEvidence.map(parseEvidenceReference);
  const confirmedReferences = new Set(report.confirmed_evidence.flatMap((item) => {
    const reference = parseEvidenceReference(item);
    return reference ? [`${reference.source}:${reference.id}`] : [];
  }));
  const rootCauseEvidenceIsConfirmed = rootCauseReferences.length > 0 && rootCauseReferences.every(
    (reference) => reference && confirmedReferences.has(`${reference.source}:${reference.id}`),
  );
  const hasDefinitiveRuleCitation = rootCauseReferences.some(
    (reference) => reference?.source === "rule" && definitiveRules.has(reference.id),
  );
  if (!report.confirmed_evidence.length)
    blockers.push("没有可追溯的已确认事实，不能确认根因。");
  if (!rootCauseEvidenceIsConfirmed)
    blockers.push("根因未绑定到已确认的具体证据；模型置信度不能替代证据链。");
  if (!hasDefinitiveRuleCitation)
    blockers.push("根因缺少可确定性规则支撑；文本、截图或知识库片段本身只能作为候选证据。");
  if (!report.hypotheses.length)
    blockers.push("未提供替代解释，无法完成反证检查。");
  // A citation proves that evidence was available, not that the model's prose
  // follows from it. Only a human review may confirm a root cause.
  if (blockers.length === 0)
    blockers.push("根因与规则结论的语义关系尚待人工复核。");
  const conclusionStatus: ConclusionStatus = report.confirmed_evidence.length
    ? "provisional"
    : "insufficient";
  const customerMessage = conclusionStatus === "provisional"
    ? `初步判断：${report.root_cause}。该判断尚待确认；建议先完成以下核查：${[...report.missing_evidence, ...blockers].slice(0, 3).join("；")}`
    : "当前证据不足以确认根因。请补充上游响应、关联请求 ID、完整日志或可读截图后再排查。";
  return { conclusionStatus, blockers, customerMessage };
}
