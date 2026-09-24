import { Top } from "@/components/app-shell";
import { ruleCatalog } from "@/lib/rules";

export default function RulesPage() {
  return (
    <>
      <Top title="规则中心" />
      <div className="page">
        <h1 className="page-title">规则中心</h1>
        <p className="mt-1 text-sm text-muted">
          规则由服务端执行；每次案件运行都会持久化实际命中结果。
        </p>
        <div className="mt-5 border-y border-slate-200 bg-white divide-y divide-slate-200">
          {ruleCatalog.map((rule) => (
            <div className="px-4 py-3 transition hover:bg-slate-50" key={rule.id}>
              <div className="flex items-center justify-between gap-3">
                <b>{rule.name}</b>
                <span className="status-text">{rule.severity}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{rule.description}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
