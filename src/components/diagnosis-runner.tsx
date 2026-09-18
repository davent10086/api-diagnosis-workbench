"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";

export function DiagnosisRunner({ caseId, latestStatus }: { caseId: string; latestStatus?: string }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  async function run() {
    setRunning(true);
    setMessage("");
    try {
      const response = await fetch(`/api/cases/${caseId}/diagnosis`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setMessage("AI 诊断已完成，页面正在刷新。");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 诊断失败，可稍后重试。");
    } finally {
      setRunning(false);
    }
  }
  const failed = latestStatus === "failed";
  return (
    <section className="panel p-4">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="section-title">千问证据诊断</h2><p className="mt-2 text-sm leading-6 text-muted">仅向模型发送已脱敏的 Trace、文本与人工确认脱敏的截图。</p></div>
      </div>
      <button className="btn btn-primary mt-4" disabled={running} onClick={run}>
        <RefreshCw size={16} className={running ? "animate-spin" : ""} />
        {running ? "正在分析证据…" : failed ? "重试 AI 诊断" : "运行 AI 诊断"}
      </button>
      {message && <p className="mt-3 text-sm text-muted" role="status">{message}</p>}
    </section>
  );
}
