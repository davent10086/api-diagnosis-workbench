"use client";
import { useState } from "react";
import { Trash2 } from "lucide-react";
export function ClearCasesButton() {
  const [busy, setBusy] = useState(false);
  async function clear() {
    if (!confirm("确定清空全部案件吗？案件、证据、诊断报告与引用将被永久删除；知识库不会受影响。"))
      return;
    setBusy(true);
    try {
      const r = await fetch("/api/cases", { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "清空失败，请稍后重试。");
      }
      window.location.reload();
    } catch (error) {
      alert(error instanceof Error ? error.message : "清空失败，请稍后重试。");
      setBusy(false);
    }
  }
  return (
    <button
      className="btn text-red-700 hover:border-red-300 hover:bg-red-50"
      disabled={busy}
      onClick={clear}
    >
      <Trash2 size={15} />
      {busy ? "清空中…" : "清空案件"}
    </button>
  );
}
