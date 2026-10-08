import React from "react";

export function ModelReasoning({ reasoning, status }: { reasoning: unknown; status: string }) {
  const text = typeof reasoning === "string" ? reasoning.trim() : "";
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <h3 className="text-sm font-semibold text-slate-800">模型思考</h3>
      {text ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-blue-700">展开思考过程</summary>
          <p className="mt-2 text-xs text-muted">由模型返回的分析内容，尚未核实；最终结论请结合证据诊断报告与人工审核。</p>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-sans text-sm leading-6 text-slate-700">{text}</pre>
        </details>
      ) : (
        <p className="mt-2 text-xs text-muted">{status === "running" ? "模型正在分析，思考过程将在模型返回后展示。" : "本次记录没有保存思考内容，可能是旧记录或模型未返回；可重新诊断。"}</p>
      )}
    </div>
  );
}
