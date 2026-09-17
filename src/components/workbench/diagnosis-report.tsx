import { AlertTriangle } from "lucide-react";
import type { Finding, Report } from "@/lib/types";

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  return (
    <section className="panel p-4">
      <div className="flex items-center justify-between">
        <h2>规则命中</h2>
        <span className="badge bg-slate-100 text-slate-600">{findings.length} 项</span>
      </div>
      {findings.length === 0 ? (
        <p className="mt-2 text-sm text-muted">尚未命中规则。</p>
      ) : (
        findings.map((finding) => (
          <p
            className="mt-2 border-l-4 border-amber-400 bg-amber-50 p-2 text-sm"
            key={finding.ruleId}
          >
            <b>{finding.ruleId}</b> {finding.conclusion}
          </p>
        ))
      )}
    </section>
  );
}
export function DiagnosisReport({ report }: { report: Report }) {
  return (
    <aside className="panel h-fit p-4">
      <h2>诊断报告</h2>
      <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-orange-950">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <p className="text-sm font-medium">{report.symptom}</p>
        </div>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-orange-800">
          {report.confidence}% · {report.fault_layer}
        </p>
      </div>
      <h3 className="mt-4">下一步检查</h3>
      {report.next_checks.map((item) => (
        <p className="mt-2 border-l-2 border-slate-200 pl-3 text-sm text-slate-600" key={item}>
          {item}
        </p>
      ))}
      <h3 className="mt-4">对外沟通话术</h3>
      <p className="text-sm">{report.external_message}</p>
    </aside>
  );
}
