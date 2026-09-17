import { Play } from "lucide-react";

type Props = {
  value: string;
  customerQuestion: string;
  saving: boolean;
  approved: boolean;
  error: string;
  saved: boolean;
  onChange: (value: string) => void;
  onCustomerQuestionChange: (value: string) => void;
  onRun: () => void;
};
export function TraceEditor({
  value,
  customerQuestion,
  saving,
  approved,
  error,
  saved,
  onChange,
  onCustomerQuestionChange,
  onRun,
}: Props) {
  return (
    <section className="panel p-4">
      <h2>客户问题与 Trace</h2>
      <label className="label mt-3 block" htmlFor="customer-question">
        客户问题 / 现象描述
      </label>
      <textarea
        id="customer-question"
        className="mt-1 min-h-24 w-full rounded border p-3 text-sm"
        maxLength={10000}
        value={customerQuestion}
        onChange={(event) => onCustomerQuestionChange(event.target.value)}
        placeholder="例如：客户调用 Bedrock 接口时返回 400，想确认是否为工具参数兼容性问题。"
      />
      <p className="mt-3 text-sm text-muted">
        完整 Trace JSON：请求、响应、日志和 SSE 证据；服务端会再次校验和脱敏。
      </p>
      <textarea
        className="mono mt-2 min-h-64 w-full rounded border p-3 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button disabled={!approved || saving} className="btn btn-primary mt-3" onClick={onRun}>
        <Play size={15} />
        {saving ? "保存中…" : "运行规则并保存案件"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="mt-2 text-sm text-emerald-700" role="status">
          案件与附件已保存到本地数据库。
        </p>
      )}
    </section>
  );
}
