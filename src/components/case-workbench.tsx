"use client";
/* eslint-disable @next/next/no-img-element -- local object URLs cannot use Next image optimization. */

import Link from "next/link";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  FileJson,
  FileText,
  FileUp,
  Info,
  Maximize2,
  Minus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  DragEvent,
  ClipboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { redact } from "@/lib/redaction";

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/json",
  "text/plain",
]);
const ACCEPT = "image/png,image/jpeg,image/webp,.json,.txt,.log,application/json,text/plain";

type EvidenceType =
  | "customer_chat"
  | "request"
  | "response"
  | "backend_log"
  | "sse"
  | "trace"
  | "other";

type Evidence = {
  id: string;
  file: File;
  type: EvidenceType;
  suggestedType?: EvidenceType;
  source: "upload" | "paste" | "customer-question";
  fingerprint: string;
  previewUrl?: string;
};

type Metadata = {
  provider: string;
  model: string;
  route: string;
  statusCode: string;
  requestId: string;
  upstreamRequestId: string;
  occurredAt: string;
};

const evidenceLabels: Record<EvidenceType, string> = {
  customer_chat: "客户聊天",
  request: "请求体",
  response: "响应体",
  backend_log: "后台日志",
  sse: "SSE",
  trace: "Trace",
  other: "其他",
};

const emptyMetadata: Metadata = {
  provider: "",
  model: "",
  route: "",
  statusCode: "",
  requestId: "",
  upstreamRequestId: "",
  occurredAt: "",
};

function isImage(file: File) {
  return file.type.startsWith("image/");
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extension(file: File) {
  return file.name.split(".").pop()?.toUpperCase() || "FILE";
}

function guessType(file: File): EvidenceType {
  const name = file.name.toLowerCase();
  if (name.includes("chat") || name.includes("wechat")) return "customer_chat";
  if (name.includes("request")) return "request";
  if (name.includes("response")) return "response";
  if (name.includes("trace")) return "trace";
  if (name.includes("sse") || name.includes("stream")) return "sse";
  if (name.includes("log")) return "backend_log";
  return "other";
}

async function fileFingerprint(file: File) {
  const data = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function CaseWorkbench() {
  const [question, setQuestion] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [metadata, setMetadata] = useState<Metadata>(emptyMetadata);
  const [showRules, setShowRules] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [advanced, setAdvanced] = useState({
    trace: "",
    requestHeaders: "",
    response: "",
    sse: "",
    context: "",
  });
  const [traceError, setTraceError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<Evidence | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [showRedactedPreview, setShowRedactedPreview] = useState(false);
  const [toast, setToast] = useState("");
  const [submitting, setSubmitting] = useState<"draft" | "diagnosis" | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  const urls = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setDraftStatus("saving");
    const timer = window.setTimeout(() => {
      sessionStorage.setItem(
        "case-workbench-draft",
        JSON.stringify({ question, metadata, advanced }),
      );
      setDraftStatus("saved");
    }, 700);
    return () => window.clearTimeout(timer);
  }, [question, metadata, advanced]);
  useEffect(() => {
    if (!preview || isImage(preview.file)) return;
    let alive = true;
    preview.file
      .text()
      .then((value) => alive && setPreviewText(value))
      .catch(() => alive && setPreviewText("无法读取此文件。"));
    return () => {
      alive = false;
    };
  }, [preview]);

  const chatImages = evidence.filter((item) => item.type === "customer_chat" && isImage(item.file));
  const missing = useMemo(() => {
    const types = new Set(evidence.map((item) => item.type));
    const list: string[] = [];
    if (!question.trim() && !types.has("customer_chat")) list.push("客户问题");
    if (!types.has("request") && !types.has("trace")) list.push("请求体");
    if (!types.has("backend_log")) list.push("后台日志");
    if (!types.has("response") && !types.has("sse")) list.push("响应体");
    if (!metadata.requestId) list.push("Request ID");
    if (!metadata.occurredAt) list.push("发生时间");
    return list;
  }, [evidence, metadata.occurredAt, metadata.requestId, question]);

  async function addFiles(files: File[], source: Evidence["source"] = "upload") {
    const accepted: Evidence[] = [];
    for (const file of files) {
      if (file.size === 0 || file.size > MAX_BYTES) {
        setToast(`“${file.name}” 不符合 1 B–10 MB 的大小限制。`);
        continue;
      }
      const isLog = /\.log$/i.test(file.name);
      if (!ACCEPTED_TYPES.has(file.type) && !isLog) {
        setToast(`“${file.name}” 不是支持的 PNG、JPG、WEBP、JSON、TXT 或 LOG 文件。`);
        continue;
      }
      const fingerprint = await fileFingerprint(file);
      if (
        evidence.some((item) => item.fingerprint === fingerprint) ||
        accepted.some((item) => item.fingerprint === fingerprint)
      ) {
        setToast(`“${file.name}” 已存在，未重复添加。`);
        continue;
      }
      const suggestedType = source === "customer-question" ? "customer_chat" : guessType(file);
      const previewUrl = isImage(file) ? URL.createObjectURL(file) : undefined;
      if (previewUrl) urls.current.add(previewUrl);
      accepted.push({
        id: crypto.randomUUID(),
        file,
        type: suggestedType,
        suggestedType,
        source,
        fingerprint,
        previewUrl,
      });
    }
    if (accepted.length) setEvidence((current) => [...current, ...accepted]);
  }

  function removeEvidence(item: Evidence) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      urls.current.delete(item.previewUrl);
    }
    setEvidence((current) => current.filter((value) => value.id !== item.id));
    if (preview?.id === item.id) setPreview(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function onQuestionPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(isImage);
    if (files.length) {
      event.preventDefault();
      void addFiles(files, "customer-question");
    }
  }

  function onEvidencePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files).filter(isImage);
    if (files.length) {
      event.preventDefault();
      void addFiles(files, "paste");
    }
  }

  function updateMetadata(key: keyof Metadata, value: string) {
    setMetadata((current) => ({ ...current, [key]: value }));
  }

  function validateTrace(value: string) {
    if (!value.trim()) return setTraceError("");
    try {
      JSON.parse(value);
      setTraceError("");
    } catch {
      setTraceError("Trace JSON 格式无效；请修正后再开始诊断。");
    }
  }

  async function submitCase(action: "draft" | "diagnosis") {
    if (submitting) return;
    if (action === "diagnosis" && !question.trim() && evidence.length === 0) {
      setToast("请填写客户问题，或至少添加 1 条证据后再开始诊断。");
      return;
    }
    if (traceError) {
      setToast("请先修正高级输入中的 Trace JSON。");
      return;
    }
    const payload = {
      question,
      metadata,
      evidence: evidence.map(({ file, ...item }) => ({
        ...item,
        name: file.name,
        size: file.size,
      })),
      advanced,
    };
    const controller = new AbortController();
    requestController.current = controller;
    setSubmitting(action);
    try {
      const created = await fetch("/api/cases/workbench", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...payload,
          title: `排障 ${metadata.requestId || new Date().toISOString()}`,
        }),
      });
      const result = await created.json();
      if (!created.ok) throw new Error(result.error);
      for (const item of evidence) {
        const form = new FormData();
        form.set("file", item.file);
        form.set("evidenceType", item.type);
        const uploaded = await fetch(`/api/cases/${result.id}/evidence`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!uploaded.ok) throw new Error((await uploaded.json()).error);
      }
      const completed = await fetch(`/api/cases/${result.id}/complete`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!completed.ok) throw new Error((await completed.json()).error);
      if (action === "diagnosis") {
        const queued = await fetch(`/api/cases/${result.id}/diagnosis`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reasoningEffort: "high" }),
          signal: controller.signal,
        });
        if (!queued.ok) throw new Error((await queued.json()).error);
      }
      setToast(action === "draft" ? "草稿已保存。" : "诊断任务已进入队列。");
      return;
    } catch (error) {
      setToast(
        error instanceof DOMException && error.name === "AbortError"
          ? "请求已取消。"
          : error instanceof Error
            ? error.message
            : "保存失败。",
      );
      return;
    } finally {
      requestController.current = null;
      setSubmitting(null);
    }
  }

  const completeness = [
    [
      "客户问题",
      Boolean(question.trim() || evidence.some((item) => item.type === "customer_chat")),
    ],
    ["请求体", evidence.some((item) => item.type === "request" || item.type === "trace")],
    ["后台日志", evidence.some((item) => item.type === "backend_log")],
    ["响应体", evidence.some((item) => item.type === "response" || item.type === "sse")],
    ["Request ID", Boolean(metadata.requestId)],
    ["发生时间", Boolean(metadata.occurredAt)],
  ] as const;

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-5 py-4 md:px-6">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-slate-900">新建排障案件</h1>
            <p className="mt-1 text-[13px] text-slate-500">
              汇总客户问题、请求证据与日志，由 AI 辅助定位 API 网关异常。
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {draftStatus === "saving"
                ? "正在自动保存…"
                : draftStatus === "saved"
                  ? "草稿已自动保存到本次会话"
                  : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              className="btn hidden sm:inline-flex"
              disabled={Boolean(submitting)}
              onClick={() => submitCase("draft")}
            >
              <Save size={15} />
              {submitting === "draft" ? "保存中…" : "保存草稿"}
            </button>
            <Link className="btn" href="/cases">
              案件历史
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 py-5 md:px-6 md:py-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <div className="space-y-5">
            <section className="panel rounded-xl p-5 shadow-sm">
              <SectionHeading
                title="客户问题"
                description="粘贴客户原话、聊天内容，或直接粘贴微信截图。"
              />
              <textarea
                className="mt-4 min-h-32 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-800 placeholder:text-slate-400"
                value={question}
                maxLength={10000}
                onChange={(event) => setQuestion(event.target.value)}
                onPaste={onQuestionPaste}
                placeholder="例如：客户反馈 Claude 请求返回 400，&#10;怀疑工具参数与 Bedrock 不兼容。"
              />
              <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                <ClipboardPaste size={14} />
                支持 Ctrl + V 粘贴文字或图片；图片不会进行 OCR。
              </p>
              {chatImages.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {chatImages.map((item) => (
                    <button
                      className="group relative h-16 w-24 overflow-hidden rounded-md border border-slate-200 bg-slate-100"
                      onClick={() => setPreview(item)}
                      key={item.id}
                    >
                      <img
                        className="h-full w-full object-cover"
                        src={item.previewUrl}
                        alt={item.file.name}
                      />
                      <span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/60 px-1 py-0.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100">
                        预览
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {chatImages.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">已添加微信截图 {chatImages.length} 张</p>
              )}
            </section>

            <section className="panel rounded-xl p-5 shadow-sm">
              <SectionHeading
                title="排障证据"
                description="直接拖入截图、请求文件和日志，系统将在诊断时统一分析。"
              />
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                  <Upload size={15} />
                  添加证据
                </button>
                <span className="text-xs text-slate-500">支持拖放、粘贴截图或选择文件</span>
                <input
                  ref={inputRef}
                  className="hidden"
                  type="file"
                  multiple
                  accept={ACCEPT}
                  onChange={onFileChange}
                />
                <button
                  className="text-xs font-medium text-slate-600 hover:text-slate-900"
                  onClick={() => setShowRules((value) => !value)}
                >
                  查看脱敏规则
                </button>
              </div>
              {showRules && (
                <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                  文本预览会遮蔽 Authorization、API Key、Bearer Token、Cookie、Email、IP、Access Key
                  与 Secret Key。图片会保留原图并直接用于诊断识别。
                </p>
              )}
              <div
                className={`mt-4 rounded-lg transition ${dragging ? "bg-blue-50 ring-2 ring-blue-300 ring-inset" : ""}`}
                tabIndex={0}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node))
                    setDragging(false);
                }}
                onDrop={onDrop}
                onPaste={onEvidencePaste}
              >
                {evidence.length === 0 ? (
                  <button
                    className="flex w-full items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-5 text-left text-sm text-slate-600 hover:border-slate-400"
                    onClick={() => inputRef.current?.click()}
                  >
                    <FileUp size={20} className="text-slate-400" />
                    <span>
                      <b className="font-medium text-slate-700">添加第一条证据</b>
                      <br />
                      <span className="text-xs">
                        PNG、JPG、WEBP、JSON、TXT、LOG，单文件不超过 10 MB
                      </span>
                    </span>
                  </button>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {evidence.map((item) => (
                      <EvidenceCard
                        item={item}
                        onPreview={() => setPreview(item)}
                        onDelete={() => removeEvidence(item)}
                        onTypeChange={(type) =>
                          setEvidence((items) =>
                            items.map((current) =>
                              current.id === item.id ? { ...current, type } : current,
                            ),
                          )
                        }
                        key={item.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <section className="panel rounded-xl p-5 shadow-sm">
              <SectionHeading
                title="案件信息"
                description="可手动填写；未来将由 Vision AI 辅助识别。"
              />
              <div className="mt-4 divide-y divide-slate-100">
                {(
                  [
                    ["provider", "Provider", "Bedrock"],
                    ["model", "Model", "claude-3-7-sonnet"],
                    ["route", "Route", "/v1/messages"],
                    ["statusCode", "Status Code", "400"],
                    ["requestId", "Request ID", "req_bedrock_2026"],
                    ["upstreamRequestId", "Upstream Request ID", "可选"],
                    ["occurredAt", "发生时间", "2026-09-20 10:30"],
                  ] as [keyof Metadata, string, string][]
                ).map(([key, label, placeholder]) => (
                  <label
                    className="grid grid-cols-[112px_1fr] items-center gap-2 py-2.5 text-xs"
                    key={key}
                  >
                    <span className="font-medium text-slate-500">{label}</span>
                    <input
                      className="min-w-0 border-0 bg-transparent p-0 text-right text-sm text-slate-800 placeholder:text-slate-300 focus:shadow-none"
                      value={metadata[key]}
                      onChange={(event) => updateMetadata(key, event.target.value)}
                      placeholder={placeholder}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
                <Info size={13} />
                识别字段将在后续多模态分析中回填（预留）。
              </p>
            </section>
            <section className="panel rounded-xl p-5 shadow-sm">
              <SectionHeading title="证据完整度" description="用已知信息快速定位还缺少什么。" />
              <ul className="mt-4 space-y-2.5">
                {completeness.map(([label, done]) => (
                  <li className="flex items-center gap-2 text-sm" key={label}>
                    {done ? (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px] text-emerald-700">
                        ✓
                      </span>
                    ) : (
                      <span className="h-4 w-4 rounded-full border border-slate-300" />
                    )}
                    <span className={done ? "text-slate-700" : "text-slate-500"}>{label}</span>
                  </li>
                ))}
              </ul>
              {missing.length > 0 && (
                <div className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                  <b>当前可能还需要：</b>
                  <br />
                  {missing.slice(0, 3).join("、")}
                  <button
                    className="mt-2 block font-semibold text-amber-900 hover:underline"
                    onClick={() => {
                      navigator.clipboard?.writeText(
                        "麻烦提供一下对应请求的 Request ID、发生时间以及完整响应内容。",
                      );
                      setToast("补充信息模板已复制（Mock）。");
                    }}
                  >
                    生成补充信息模板
                  </button>
                </div>
              )}
            </section>
          </aside>
        </div>

        <section className="panel mt-5 rounded-xl shadow-sm">
          <button
            className="flex w-full items-center justify-between px-5 py-4 text-left"
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <span>
              <span className="text-sm font-semibold text-slate-800">高级输入</span>
              <span className="ml-2 text-xs text-slate-500">
                Trace JSON、Headers、Response、SSE 与其他上下文
              </span>
            </span>
            {advancedOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
          {advancedOpen && (
            <div className="border-t border-slate-200 p-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <CodeInput
                  label="完整 Trace JSON"
                  value={advanced.trace}
                  onChange={(value) => setAdvanced((current) => ({ ...current, trace: value }))}
                  onBlur={() => validateTrace(advanced.trace)}
                  error={traceError}
                  expanded={advancedExpanded}
                  onExpand={() => setAdvancedExpanded((value) => !value)}
                  placeholder={'{\n  "requestId": "..."\n}'}
                />
                <CodeInput
                  label="Request Header"
                  value={advanced.requestHeaders}
                  onChange={(value) =>
                    setAdvanced((current) => ({ ...current, requestHeaders: value }))
                  }
                  placeholder="Authorization: Bearer ..."
                />
                <CodeInput
                  label="Response"
                  value={advanced.response}
                  onChange={(value) => setAdvanced((current) => ({ ...current, response: value }))}
                  placeholder="响应内容 / JSON"
                />
                <CodeInput
                  label="SSE 原始事件"
                  value={advanced.sse}
                  onChange={(value) => setAdvanced((current) => ({ ...current, sse: value }))}
                  placeholder="event: message\ndata: ..."
                />
              </div>
              <label className="mt-4 block text-xs font-medium text-slate-600">
                其他上下文
                <textarea
                  className="mono mt-2 min-h-24 w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
                  value={advanced.context}
                  onChange={(event) =>
                    setAdvanced((current) => ({ ...current, context: event.target.value }))
                  }
                  placeholder="补充链接、复现步骤、关联案件等"
                />
              </label>
            </div>
          )}
        </section>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 px-5 py-3 md:px-6">
          <span className="text-sm text-slate-500">
            已添加 <b className="font-semibold text-slate-800">{evidence.length}</b> 条证据
          </span>
          <div className="flex gap-2">
            <button
              className="btn sm:hidden"
              disabled={Boolean(submitting)}
              onClick={() => submitCase("draft")}
            >
              <Save size={15} />
              草稿
            </button>
            <button
              className="btn btn-primary"
              disabled={Boolean(submitting)}
              onClick={() => submitCase("diagnosis")}
            >
              <ShieldCheck size={15} />
              {submitting === "diagnosis" ? "正在提交…" : "开始诊断"}
            </button>
            {submitting && (
              <button className="btn" onClick={() => requestController.current?.abort()}>
                取消
              </button>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <PreviewModal
          item={preview}
          text={previewText}
          redacted={showRedactedPreview ? redact(previewText) : previewText}
          showRedacted={showRedactedPreview}
          onToggleRedaction={() => setShowRedactedPreview((value) => !value)}
          onClose={() => {
            setPreview(null);
            setPreviewText("");
            setShowRedactedPreview(false);
          }}
        />
      )}
      {toast && (
        <div
          className="fixed bottom-20 right-5 z-30 flex max-w-sm items-center gap-2 rounded-lg border border-slate-200 bg-slate-900 px-3 py-2.5 text-sm text-white shadow-lg"
          role="status"
        >
          <AlertCircle size={16} />
          {toast}
          <button className="ml-1" onClick={() => setToast("")} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-[13px] text-slate-500">{description}</p>
    </div>
  );
}

function EvidenceCard({
  item,
  onPreview,
  onDelete,
  onTypeChange,
}: {
  item: Evidence;
  onPreview: () => void;
  onDelete: () => void;
  onTypeChange: (type: EvidenceType) => void;
}) {
  const image = isImage(item.file);
  return (
    <article className="group overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button
        className="relative block aspect-video w-full bg-slate-100 text-left"
        onClick={onPreview}
      >
        {image ? (
          <img className="h-full w-full object-cover" src={item.previewUrl} alt={item.file.name} />
        ) : (
          <span className="flex h-full items-center justify-center">
            <FileIcon file={item.file} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-slate-950/35 text-sm font-medium text-white opacity-0 transition group-hover:opacity-100">
          预览
        </span>
      </button>
      <div className="p-3">
        <p className="truncate text-sm font-medium text-slate-800" title={item.file.name}>
          {item.file.name}
        </p>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
          <span>{extension(item.file)}</span>
          <span>·</span>
          <span>{formatSize(item.file.size)}</span>
        </div>
        <select
          className="mt-3 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-700"
          value={item.type}
          onChange={(event) => onTypeChange(event.target.value as EvidenceType)}
          aria-label={`${item.file.name} 的证据类型`}
        >
          {Object.entries(evidenceLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="mt-3 flex items-center justify-between">
          <button
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
            onClick={onPreview}
          >
            预览
          </button>
          <button
            className="text-xs font-medium text-slate-500 hover:text-red-700"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </article>
  );
}

function FileIcon({ file }: { file: File }) {
  return file.type === "application/json" || /\.json$/i.test(file.name) ? (
    <FileJson size={28} className="text-amber-600" />
  ) : (
    <FileText size={28} className="text-slate-500" />
  );
}

function CodeInput({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  error,
  expanded,
  onExpand,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  error?: string;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      <span className="flex items-center justify-between">
        {label}
        {onExpand && (
          <button className="text-slate-500 hover:text-slate-800" type="button" onClick={onExpand}>
            {expanded ? <Minus size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
      </span>
      <textarea
        className={`mono mt-2 w-full resize-y rounded-lg border bg-slate-950 p-3 text-xs leading-5 text-slate-100 placeholder:text-slate-500 ${expanded ? "min-h-72 lg:col-span-2" : "min-h-40"} ${error ? "border-red-400" : "border-slate-800"}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
      />
      {error && <span className="mt-1 block text-xs font-normal text-red-700">{error}</span>}
    </label>
  );
}

function PreviewModal({
  item,
  text,
  redacted,
  showRedacted,
  onToggleRedaction,
  onClose,
}: {
  item: Evidence;
  text: string;
  redacted: string;
  showRedacted: boolean;
  onToggleRedaction: () => void;
  onClose: () => void;
}) {
  const image = isImage(item.file);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${item.file.name} 预览`}
      onMouseDown={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{item.file.name}</p>
            <p className="text-xs text-slate-500">
              {evidenceLabels[item.type]} · {formatSize(item.file.size)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!image && (
              <button className="btn text-xs" onClick={onToggleRedaction}>
                {showRedacted ? "查看原文" : "脱敏预览"}
              </button>
            )}
            <button className="btn" onClick={onClose} aria-label="关闭预览">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="bg-slate-100 p-4">
          {image ? (
            <img
              className="mx-auto max-h-[70vh] max-w-full object-contain"
              src={item.previewUrl}
              alt={item.file.name}
            />
          ) : (
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">
              {showRedacted ? redacted : text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
