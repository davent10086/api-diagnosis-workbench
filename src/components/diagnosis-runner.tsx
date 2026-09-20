"use client";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ReasoningEffort = "low" | "high" | "max";

export function DiagnosisRunner({ caseId, latestStatus }: { caseId: string; latestStatus?: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [message, setMessage] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const controller = useRef<AbortController | null>(null);
  const analyzing = latestStatus === "running";
  const failed = latestStatus === "failed";

  useEffect(() => {
    if (!queued || analyzing || failed) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [analyzing, failed, queued, router]);

  useEffect(() => {
    if (!latestStatus) return;
    setQueued(false);
    if (analyzing) setMessage("AI 诊断正在执行，页面会自动更新结果。");
  }, [analyzing, latestStatus]);

  async function run() {
    setSubmitting(true);
    setMessage("");
    controller.current = new AbortController();
    try {
      const response = await fetch(`/api/cases/${caseId}/diagnosis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reasoningEffort }),
        signal: controller.current.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setQueued(true);
      setMessage("AI 诊断任务已进入队列，正在等待后台工作器领取任务。");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof DOMException && error.name === "AbortError"
          ? "已取消提交诊断任务。"
          : error instanceof Error
            ? error.message
            : "AI 诊断任务提交失败，可稍后重试。",
      );
    } finally {
      controller.current = null;
      setSubmitting(false);
    }
  }

  const busy = submitting || queued || analyzing;
  return (
    <section className="panel p-4">
      <div>
        <h2 className="section-title">千问深度诊断</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          仅向模型发送已脱敏的 Trace、文本与人工确认脱敏的截图。推理过程不会保存或展示。
        </p>
      </div>
      <label className="mt-4 block max-w-xs text-sm font-medium text-slate-700">
        推理强度
        <select
          className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
          disabled={busy}
          value={reasoningEffort}
          onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
        >
          <option value="low">低</option>
          <option value="high">高（默认）</option>
          <option value="max">最高</option>
        </select>
      </label>
      <button className="btn btn-primary mt-4" disabled={busy} onClick={run}>
        <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
        {submitting
          ? "正在提交…"
          : queued
            ? "正在等待工作器…"
            : analyzing
              ? "正在分析证据…"
              : failed
                ? "重试 AI 诊断"
                : "运行 AI 深度诊断"}
      </button>
      {submitting && (
        <button className="btn ml-2 mt-4" onClick={() => controller.current?.abort()}>
          取消提交
        </button>
      )}
      {message && <p className="mt-3 text-sm text-muted" role="status">{message}</p>}
    </section>
  );
}
