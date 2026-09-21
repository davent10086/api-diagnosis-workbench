"use client";

import { useState } from "react";

export function DiagnosisReview({ caseId, diagnosisId }: { caseId: string; diagnosisId: string }) {
  const [notes, setNotes] = useState("");
  const [correctedRootCause, setCorrectedRootCause] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (verdict: "confirmed" | "rejected" | "corrected") => {
    setMessage("");
    const response = await fetch(`/api/cases/${caseId}/diagnosis/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ diagnosisId, verdict, notes: notes || undefined, correctedRootCause: correctedRootCause || undefined }),
    });
    if (!response.ok) { setMessage("保存复核失败，请填写驳回说明或修正根因。"); return; }
    setMessage("复核已保存。"); window.location.reload();
  };
  return <section className="rounded border border-slate-200 bg-slate-50 p-3">
    <h3 className="text-sm font-semibold">人工复核</h3>
    <textarea className="mt-2 w-full rounded border p-2 text-sm" placeholder="复核说明（驳回时必填）" value={notes} onChange={(event) => setNotes(event.target.value)} />
    <textarea className="mt-2 w-full rounded border p-2 text-sm" placeholder="修正后的根因（修正时必填）" value={correctedRootCause} onChange={(event) => setCorrectedRootCause(event.target.value)} />
    <div className="mt-2 flex flex-wrap gap-2">
      <button className="btn btn-primary" onClick={() => submit("confirmed")}>确认结论</button>
      <button className="btn btn-secondary" onClick={() => submit("rejected")}>驳回</button>
      <button className="btn btn-secondary" onClick={() => submit("corrected")}>修正根因</button>
    </div>
    {message && <p className="mt-2 text-sm">{message}</p>}
  </section>;
}
