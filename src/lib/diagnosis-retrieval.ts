import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageExtraction } from "@/lib/diagnosis-image";
import type { Finding, Trace } from "@/lib/types";

export type TextEvidence = { id: string; evidenceType: string; content: string; truncated: boolean };

type KnowledgeQuery = { value: string; kind: "error" | "status" | "field" | "event" | "model" | "route" | "phrase" | "rule" };
const sensitive = /^(?:authorization|cookie|api[-_]?key|secret|token|password)$/i;
const noise = new Set(["error", "type", "message", "messages", "role", "content", "model", "provider", "request", "response", "request_id", "trace_id", "upstream_request_id", "occurred_at", "raw_response", "raw_headers", "status_code", "event", "data", "user", "assistant", "system", "hello", "http", "https", "www", "com", "api", "aws", "bedrock", "claude", "openai", "anthropic", "google", "gemini", "tools", "tool", "not", "the", "and", "for", "with", "supported", "is"]);
function strings(value: unknown, output: string[] = []) {
  if (typeof value === "string" || typeof value === "number") output.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
    if (!sensitive.test(key)) { output.push(key); strings(item, output); }
  });
  return output;
}
export function knowledgeQueries(trace: Trace, findings: Finding[], images: ImageExtraction[]): KnowledgeQuery[] {
  const sources: unknown[] = [
    trace.customerQuestion,
    trace.statusCode,
    trace.clientRequest,
    trace.transformedRequest,
    trace.upstreamResponse,
    trace.finalResponse,
    trace.logs,
    trace.sse,
    ...findings.flatMap((finding) => [finding.conclusion, finding.evidence]),
    ...images.flatMap((image) => [image.summary, ...(image.fields ?? [])]),
  ];
  const candidates: KnowledgeQuery[] = [];
  for (const source of sources) for (const raw of strings(source)) {
    // Retain late errors while removing credential lines and credential objects.
    const value = raw.replace(/(?:authorization|cookie|api[-_]?key|secret|token|password)\s*[:=][^\r\n]*/gi, "");
    for (const token of value.match(/\b[45]\d{2}\b|\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/g) ?? [])
      candidates.push({ value: token, kind: /^\d+$/.test(token) ? "status" : /Exception$|Error$|(?:^|[_-])(?:exceeded|timeout|rate|throttl|unsupported)/i.test(token) ? "error" : "field" });
    for (const phrase of value.match(/[\u3400-\u9fff]{2,16}/g) ?? []) candidates.push({ value: phrase, kind: "phrase" });
  }
  if (trace.model) candidates.push({ value: trace.model, kind: "model" });
  if (trace.route) candidates.push({ value: trace.route, kind: "route" });
  for (const event of [...(trace.sse ?? []), ...(trace.logs ?? [])]) {
    const match = /(?:event\s*[:=]\s*|\bevent\b\s+)([A-Za-z][\w.-]+)/i.exec(event);
    if (match) candidates.push({ value: match[1], kind: "event" });
  }
  for (const finding of findings) candidates.push({ value: finding.ruleId, kind: "rule" });
  const weight: Record<KnowledgeQuery["kind"], number> = { error: 0, event: 1, status: 2, field: 3, model: 4, phrase: 5, route: 6, rule: 7 };
  const deduped = new Map<string, KnowledgeQuery>();
  for (const item of candidates.filter((item) => item.value.length >= 2 && item.value.length <= 200 && !sensitive.test(item.value) && !noise.has(item.value.toLowerCase()))) {
    const key = item.value.toLowerCase(); const old = deduped.get(key);
    if (!old || weight[item.kind] < weight[old.kind]) deduped.set(key, item);
  }
  const specificity = (value: string) => /_\d{8}$/.test(value) ? 0 : /[_\d]/.test(value) ? 1 : 2;
  const ranked = [...deduped.values()].sort((a, b) => weight[a.kind] - weight[b.kind] || specificity(a.value) - specificity(b.value));
  const selected: KnowledgeQuery[] = [];
  const kinds = new Set<KnowledgeQuery["kind"]>();
  for (const item of ranked) if (!kinds.has(item.kind)) { selected.push(item); kinds.add(item.kind); }
  for (const item of ranked) if (!selected.includes(item) && selected.length < 8) selected.push(item);
  return selected.slice(0, 8).sort((a, b) => weight[a.kind] - weight[b.kind]);
}
export async function readTextEvidence(
  assets: { id: string; filePath: string; evidenceType: string; redactionStatus: string }[],
) {
  const selected = assets
    .filter((asset) => asset.redactionStatus === "redacted" && /\.(json|txt|log)$/i.test(asset.filePath))
    .slice(0, 5);
  let remaining = 120_000;
  const result: TextEvidence[] = [];
  for (const asset of selected) {
    if (remaining <= 0) break;
    try {
      const content = await readFile(resolve(process.cwd(), asset.filePath), "utf8");
      const included = content.slice(0, Math.min(40_000, remaining));
      remaining -= included.length;
      if (included.trim())
        result.push({ id: asset.id, evidenceType: asset.evidenceType, content: included, truncated: included.length < content.length });
    } catch {
      // A missing attachment must not make a case impossible to diagnose; it is simply omitted.
    }
  }
  return result;
}
export function knowledgeCitationIds(items: string[]) {
  return new Set(
    items.flatMap((item) => {
      const match = /^knowledge:([0-9a-f-]{36})(?:\s|$)/i.exec(item.trim());
      return match ? [match[1]] : [];
    }),
  );
}
export function traceReferenceSet(trace: Trace) {
  const refs = new Set<string>();
  const addPaths = (value: unknown, prefix: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const path = `${prefix}.${key}`;
      refs.add(path);
      addPaths(child, path);
    }
  };
  for (const [field, value] of Object.entries(trace)) {
    if (value === undefined || value === null || value === "") continue;
    refs.add(field);
    addPaths(value, field);
  }
  return refs;
}
