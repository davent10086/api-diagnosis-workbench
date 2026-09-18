"use client";

import { useState } from "react";
import { EvidenceUploader } from "./evidence-uploader";

export function ResumeCase({ caseId, assetCount }: { caseId: string; assetCount: number }) {
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [imagesConfirmed, setImagesConfirmed] = useState(false);
  async function complete() {
    setSaving(true);
    setMessage("");
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        form.set("imageRedactionConfirmed", String(imagesConfirmed));
        const response = await fetch(`/api/cases/${caseId}/evidence`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error);
        }
      }
      const response = await fetch(`/api/cases/${caseId}/complete`, { method: "POST" });
      if (!response.ok) throw new Error("无法完成案件。");
      setMessage("附件已保存，案件已完成。请刷新页面查看最新状态。");
      setFiles([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel p-4">
      <h2>继续处理</h2>
      <p className="mt-1 text-sm text-muted">
        当前已保存 {assetCount} 个附件。补充附件后可完成案件；没有附件时也可直接完成。
      </p>
      <div className="mt-3">
        <EvidenceUploader files={files} onChange={setFiles} imagesConfirmed={imagesConfirmed} onImagesConfirmedChange={setImagesConfirmed} />
      </div>
      <button className="btn btn-primary mt-3" disabled={saving} onClick={complete}>
        {saving ? "保存中…" : "完成案件"}
      </button>
      {message && (
        <p className="mt-2 text-sm text-muted" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
