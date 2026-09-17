import type { Finding, Report, Trace } from "./types";

const layerNames: Record<string, string> = { client: "客户端", gateway: "网关", adapter: "适配层", route: "路由层", provider: "服务商", upstream: "上游", unknown: "未知层" };

export function buildReport(trace: Trace, findings: Finding[]): Report {
  const primary = findings.find((item) => item.severity === "critical")
    ?? findings.find((item) => item.severity === "high")
    ?? findings[0];
  const confidence = primary ? (primary.needsMoreEvidence ? 55 : 86) : 35;
  const symptom = primary?.conclusion ?? "未命中确定性规则；请补充上游响应、日志或流式事件。";
  return {
    symptom,
    severity: primary?.severity ?? "low",
    fault_layer: primary?.faultLayer ?? "unknown",
    confidence,
    evidence: primary?.evidence ?? [],
    official_evidence: [],
    possible_causes: primary ? ["规则命中指向" + layerNames[primary.faultLayer] + "。"] : ["当前证据不足以形成确定结论。"],
    missing_evidence: findings.filter((item) => item.needsMoreEvidence).map((item) => item.conclusion),
    next_checks: primary ? ["核对请求 ID / trace ID：" + (trace.requestId ?? trace.traceId ?? "未提供"), "补充同一路径的原始上游响应并复现。"] : ["补充完整请求、上游响应和时间线。"],
    external_message: primary ? "当前证据显示问题可能位于" + layerNames[primary.faultLayer] + "，建议按报告中的下一步检查补充证据后确认。" : "当前证据不足，暂不建议对外归因。",
  };
}
