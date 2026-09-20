"use client";

import { useMemo, useState } from "react";
import { demoTrace } from "@/lib/demo";
import { buildReport } from "@/lib/report";
import { runRules } from "@/lib/rules";
import type { Report, Trace } from "@/lib/types";
import { DiagnosisReport, FindingsPanel } from "./workbench/diagnosis-report";
import { EvidenceUploader } from "./workbench/evidence-uploader";
import { RedactionPanel } from "./workbench/redaction-panel";
import { TraceEditor } from "./workbench/trace-editor";

function parseTrace(text: string): Trace | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Trace) : null;
  } catch {
    return null;
  }
}

export function Workbench() {
  const [text, setText] = useState(() => JSON.stringify(demoTrace, null, 2));
  const [customerQuestion, setCustomerQuestion] = useState("");
  const [approved, setApproved] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [trace, setTrace] = useState<Trace>(demoTrace);
  const [report, setReport] = useState<Report>(() => buildReport(demoTrace, runRules(demoTrace)));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const findings = useMemo(() => runRules(trace), [trace]);

  async function submit() {
    const parsedTrace = parseTrace(text);
    const nextTrace = parsedTrace
      ? { ...parsedTrace, customerQuestion: customerQuestion.trim() || undefined }
      : null;
    if (!nextTrace) {
      setError("请输入完整且合法的 Trace JSON；可在示例基础上修改。");
      return;
    }
    const nextFindings = runRules(nextTrace);
    setTrace(nextTrace);
    setReport(buildReport(nextTrace, nextFindings));
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const created = await fetch("/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `排障 ${nextTrace.requestId ?? new Date().toISOString()}`,
          trace: nextTrace,
        }),
      });
      const payload = await created.json();
      if (!created.ok) throw new Error(payload.error);
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        const uploaded = await fetch(`/api/cases/${payload.id}/evidence`, {
          method: "POST",
          body: form,
        });
        if (!uploaded.ok) {
          const issue = await uploaded.json();
          throw new Error(`案件已创建（${payload.id}），附件上传失败：${issue.error}。`);
        }
      }
      const completed = await fetch(`/api/cases/${payload.id}/complete`, { method: "POST" });
      if (!completed.ok) throw new Error(`案件已创建（${payload.id}），但尚未完成。`);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "案件保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mx-auto grid max-w-[1440px] gap-4 p-4 md:p-5 xl:grid-cols-[276px_minmax(0,1fr)_352px]">
        <section className="space-y-4">
          <EvidenceUploader
            files={files}
            onChange={(nextFiles) => {
              setFiles(nextFiles);
              setSaved(false);
            }}
          />
          <RedactionPanel
            text={text}
            approved={approved}
            onApply={(value) => {
              setText(value);
              setApproved(true);
            }}
          />
        </section>
        <section className="space-y-4">
          <TraceEditor
            value={text}
            customerQuestion={customerQuestion}
            saving={saving}
            approved={approved}
            error={error}
            saved={saved}
            onChange={(value) => {
              setText(value);
              setApproved(false);
            }}
            onCustomerQuestionChange={(value) => {
              setCustomerQuestion(value);
              setApproved(false);
            }}
            onRun={submit}
          />
          <FindingsPanel findings={findings} />
        </section>
        <DiagnosisReport report={report} />
      </div>
    </div>
  );
}
