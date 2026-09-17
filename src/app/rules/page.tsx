import { Shell, Top } from "@/components/app-shell";

const rules = [
  ["HTTP 响应边界", "429 重试证据、5xx 上游响应和取消超时"],
  ["流式协议", "SSE 生命周期、事件索引和 200 后 error 事件"],
  ["请求转换", "协议字段差异、Bedrock 工具兼容性和工具生命周期"],
  ["证据充分性", "缓存字段和可复现证据是否齐全"],
] as const;

export default function RulesPage() { return <Shell><Top title="规则中心"/><div className="p-6"><h1 className="text-xl font-bold">规则中心</h1><p className="mt-1 text-sm text-muted">规则由服务端执行；每次案件运行都会持久化实际命中结果。</p><div className="panel mt-5 divide-y">{rules.map(([name, description])=><div className="p-4" key={name}><b>{name}</b><p className="mt-1 text-sm text-muted">{description}</p></div>)}</div></div></Shell>; }
