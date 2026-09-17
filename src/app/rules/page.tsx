import { Shell, Top } from "@/components/app-shell";
import { ruleCatalog } from "@/lib/rules";

export default function RulesPage() {
  return (
    <Shell>
      <Top title="规则中心" />
      <div className="p-6">
        <h1 className="text-xl font-bold">规则中心</h1>
        <p className="mt-1 text-sm text-muted">
          规则由服务端执行；每次案件运行都会持久化实际命中结果。
        </p>
        <div className="panel mt-5 divide-y">
          {ruleCatalog.map((rule) => (
            <div className="p-4" key={rule.id}>
              <div className="flex items-center justify-between gap-3">
                <b>{rule.name}</b>
                <span className="badge bg-slate-100 text-slate-700">{rule.severity}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{rule.description}</p>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
