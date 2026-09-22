import type { Finding, Report, Trace } from "./types";

export function buildReport(trace: Trace, findings: Finding[]): Report {
  const primary =
    findings.find((item) => item.severity === "critical") ??
    findings.find((item) => item.severity === "high") ??
    findings[0];
  const symptom = primary?.conclusion ?? "未命中确定性规则；请补充上游响应、日志或流式事件。";
  return {
    symptom,
    severity: primary?.severity ?? "low",
    fault_layer: primary?.faultLayer ?? "unknown",
    evidence: primary?.evidence ?? [],
    next_checks: primary
      ? [
          "核对请求 ID / trace ID：" + (trace.requestId ?? trace.traceId ?? "未提供"),
          "补充同一路径的原始上游响应并复现。",
        ]
      : ["补充完整请求、上游响应和时间线。"],
    external_message: primary
      ? `当前规则指向 ${primary.faultLayer} 层；建议按报告中的下一步检查补充证据后确认。`
      : "当前证据不足，暂不建议对外归因。",
  };
}
