import { AlertTriangle } from "lucide-react";
import type { Finding, Report } from "@/lib/types";

export function FindingsPanel({ findings }: { findings: Finding[] }) {
  return (
    <section className="panel p-4">
      <h2 className="section-title">规则命中</h2>
      {findings.length === 0 ? <p className="mt-2 text-sm text-muted">尚未命中规则。</p> : findings.map((finding) => (
        <p className="mt-3 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm leading-5" key={finding.ruleId}>
          <b>{finding.ruleId}</b> {finding.conclusion}
        </p>
      ))}
    </section>
  );
}

export function DiagnosisReport({ report }: { report: Report }) {
  return (
    <aside className="panel h-fit overflow-hidden p-0">
      <div className="border-b border-slate-200 px-4 py-3"><h2 className="section-title">诊断报告</h2></div>
      <div className="p-4">
        <div className="border-l-2 border-amber-500 bg-amber-50 px-3 py-3 text-sm">
          <AlertTriangle className="mb-2 text-orange-600" size={18} />
          <p className="font-semibold text-slate-800">{report.symptom}</p>
          <p className="mt-2 text-xs font-medium text-orange-700">{report.fault_layer}</p>
        </div>
        <h3 className="mt-5 text-sm font-semibold">下一步检查</h3>
        {report.next_checks.map((item) => <p className="mt-2 border-b border-slate-100 pb-2 text-sm text-slate-700" key={item}>{item}</p>)}
        <h3 className="mt-4">对外沟通话术</h3>
        <p className="border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">{report.external_message}</p>
      </div>
    </aside>
  );
}
