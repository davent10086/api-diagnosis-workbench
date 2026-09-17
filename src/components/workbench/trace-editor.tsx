import { Play } from "lucide-react";

type Props = {
  value: string;
  saving: boolean;
  approved: boolean;
  error: string;
  saved: boolean;
  onChange: (value: string) => void;
  onRun: () => void;
};
export function TraceEditor({ value, saving, approved, error, saved, onChange, onRun }: Props) {
  return (
    <section className="panel p-4">
      <h2>完整 Trace JSON</h2>
      <p className="mt-1 text-sm text-muted">
        输入请求、响应、日志和 SSE 证据；服务端会再次校验和脱敏。
      </p>
      <textarea
        className="mono mt-3 min-h-64 w-full rounded border p-3 text-xs"
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
