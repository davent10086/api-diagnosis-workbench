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
    const r = await fetch(`/api/cases/${caseId}`, { method: "DELETE" });
    if (r.ok) router.push("/cases");
    else {
      alert("删除失败。");
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
