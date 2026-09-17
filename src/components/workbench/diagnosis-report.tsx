import { AlertTriangle } from "lucide-react";
import type { Finding, Report } from "@/lib/types";

export function FindingsPanel({ findings }: { findings:Finding[] }) { return <section className="panel p-4"><h2>规则命中</h2>{findings.length===0?<p className="mt-2 text-sm text-muted">尚未命中规则。</p>:findings.map((finding)=><p className="mt-2 border-l-4 border-amber-400 bg-amber-50 p-2 text-sm" key={finding.ruleId}><b>{finding.ruleId}</b> {finding.conclusion}</p>)}</section>; }
export function DiagnosisReport({ report }: { report:Report }) { return <aside className="panel h-fit p-4"><h2>诊断报告</h2><div className="mt-3 bg-orange-50 p-3"><AlertTriangle className="inline" size={16}/>{report.symptom}<p>{report.confidence}% · {report.fault_layer}</p></div><h3 className="mt-4">下一步检查</h3>{report.next_checks.map((item)=><p className="mt-2 text-sm" key={item}>{item}</p>)}<h3 className="mt-4">对外沟通话术</h3><p className="text-sm">{report.external_message}</p></aside>; }
