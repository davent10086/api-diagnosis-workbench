"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export function DeleteCaseButton({ caseId }: { caseId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function remove() {
    if (!confirm("确定删除此案件及全部证据、报告和引用吗？")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/cases/${caseId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "删除失败，请稍后重试。");
      }
      router.push("/cases");
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败，请稍后重试。");
      setBusy(false);
    }
  }

  return (
    <button className="btn text-red-700" disabled={busy} onClick={remove}>
      <Trash2 size={15} />
      {busy ? "删除中…" : "删除案件"}
    </button>
  );
}
