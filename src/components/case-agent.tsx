"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentResult } from "@/lib/tool-agent";

type Turn = { question: string; result: AgentResult };
const labels: Record<string, string> = {
  read_diagnosis_text_evidence: "读取文本证据",
  extract_diagnosis_images: "识别图片",
  run_diagnosis_rules: "检查规则",
  search_diagnosis_knowledge: "检索知识库",
  generate_diagnosis_report: "生成初步报告",
  validate_diagnosis_evidence: "校验证据",
  search_request_logs: "查询客户日志",
};

export function CaseAgent({ caseId }: { caseId: string }) {
  const [message, setMessage] = useState("");
  const [username, setUsername] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function resetScope(value: string) {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setUsername(value);
    setConfirmed(false);
    setTurns([]);
    setError("");
  }
  async function send() {
    if (!message.trim() || busy) return;
    const active = new AbortController();
    controller.current = active;
    const question = message.trim();
    setBusy(true);
    setError("");
    try {
      const history = turns
        .flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.result.answer },
        ])
        .slice(-4);
      const response = await fetch(`/api/cases/${caseId}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: active.signal,
        body: JSON.stringify({
          message: question,
          history,
          logScope:
            confirmed && username.trim()
              ? { username: username.trim(), scopeConfirmed: true, confirmed: {} }
              : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "自主分析失败。");
      if (controller.current === active) {
        setTurns((current) => [...current.slice(-4), { question, result: body }]);
        setMessage("");
      }
    } catch (cause) {
      if (controller.current === active)
        setError(
          active.signal.aborted
            ? "分析已取消，尚未确认任何结论。"
            : cause instanceof Error
              ? cause.message
              : "自主分析失败。",
        );
    } finally {
      if (controller.current === active) {
        setBusy(false);
        controller.current = null;
      }
    }
  }
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="section-title">自主排障助手</h2>
      <p className="text-sm text-slate-600">
        模型按需要选择工具，也可直接回答。每轮最多六轮决策、八次工具调用，总模型请求最多十二次（含报告生成与重试）。回答与初步报告需人工核对。对话仅保留在当前页面，正式留档请使用深度诊断与人工审核。
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          需要查询 new-api 日志时，先确认客户账号
        </summary>
        <div className="mt-2 space-y-2">
          <label className="block text-sm">
            Agent 查询的客户账号
            <input
              className="mt-1 block w-full max-w-sm rounded border p-2"
              maxLength={128}
              value={username}
              onChange={(event) => resetScope(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!username.trim() || busy}
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                setTurns([]);
              }}
            />
            已核对该账号，允许 Agent 在此账号范围内查询日志
          </label>
          <p className="text-xs text-slate-500">
            更换账号会清空对话。日志候选仍需在请求定位入口人工确认后导入。
          </p>
        </div>
      </details>
      {turns.map((turn, index) => (
        <div className="space-y-2 border-t pt-3 text-sm" key={index}>
          <p className="whitespace-pre-wrap font-medium">你：{turn.question}</p>
          <p className="whitespace-pre-wrap leading-6">{turn.result.answer}</p>
          <p className="text-xs text-slate-500">
            {turn.result.toolCalls === 0
              ? "本轮直接回答，未调用工具"
              : `本轮调用 ${turn.result.toolCalls} 次工具`}{" "}
            · 决策模型调用 {turn.result.modelCalls} 次
            {turn.result.modelRequests !== undefined
              ? ` · 总模型请求 ${turn.result.modelRequests} 次`
              : ""}
            {turn.result.stopReason === "budget" ? " · 已触及调用预算" : ""} · 待人工核对
          </p>
          {turn.result.steps.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs">查看本轮工具执行记录</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                {turn.result.steps.map((step, i) => (
                  <li key={i}>
                    {labels[step.name] ?? step.name} ·{" "}
                    {step.status === "success"
                      ? "完成"
                      : step.status === "blocked"
                        ? "已拦截"
                        : "失败"}{" "}
                    · {step.summary}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      ))}
      <label className="block text-sm">
        向自主排障助手提问
        <textarea
          className="mt-1 min-h-24 w-full rounded border p-2"
          value={message}
          maxLength={10000}
          disabled={busy}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="例如：429 和超时有什么区别？或：请读取这次案件的截图，判断还缺哪些证据。"
        />
      </label>
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={busy || !message.trim()}
          onClick={() => void send()}
        >
          {busy ? "正在自主分析…" : "开始自主分析"}
        </button>
        {busy && (
          <button className="btn" onClick={() => controller.current?.abort()}>
            取消自主分析
          </button>
        )}
        <button className="btn" disabled={busy || !turns.length} onClick={() => setTurns([])}>
          清空对话
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
