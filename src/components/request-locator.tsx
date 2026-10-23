"use client";

import { useEffect, useRef, useState } from "react";
import type { LocatedCandidate, LocationResult } from "@/lib/request-location-types";

type Props = {
  question: string;
  onImport: (candidate: LocatedCandidate, result: LocationResult) => void;
};
const statusLabels = {
  candidates: "找到候选，请核对",
  not_found: "已查询范围内没有匹配",
  incomplete: "检索未完成，以下仅为部分结果",
  failed: "日志查询失败",
  needs_clues: "需要补充线索",
};

export function RequestLocator({ question, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const [occurredAt, setOccurredAt] = useState("");
  const [timezone, setTimezone] = useState("480");
  const [model, setModel] = useState("");
  const [channel, setChannel] = useState("");
  const [keywords, setKeywords] = useState("");
  const [stream, setStream] = useState("");
  const [requestId, setRequestId] = useState("");
  const [exactId, setExactId] = useState(false);
  const [result, setResult] = useState<LocationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importedId, setImportedId] = useState("");
  const controller = useRef<AbortController | null>(null);
  const queryKey = JSON.stringify([
    question,
    username,
    scopeConfirmed,
    occurredAt,
    timezone,
    model,
    channel,
    keywords,
    requestId,
    exactId,
    stream,
  ]);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setResult(null);
    setError("");
    setImportedId("");
  }, [queryKey]);
  useEffect(() => () => controller.current?.abort(), []);
  async function search() {
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError("");
    setResult(null);
    setImportedId("");
    try {
      const response = await fetch("/api/integrations/new-api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: active.signal,
        body: JSON.stringify({
          username: username.trim(),
          scopeConfirmed,
          question,
          occurredAt: occurredAt.trim(),
          timezoneOffsetMinutes: Number(timezone),
          hints: {
            isStream: stream === "" ? undefined : stream === "true",
            model: model.trim() || undefined,
            channel: channel ? Number(channel) : undefined,
            keywords: keywords.trim()
              ? keywords
                  .split(/[,，\n]/)
                  .map((item) => item.trim())
                  .filter(Boolean)
              : undefined,
            requestId: !exactId ? requestId.trim() || undefined : undefined,
          },
          confirmed: { requestId: exactId ? requestId.trim() || undefined : undefined },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "定位请求失败。");
      if (controller.current === active) setResult(body);
    } catch (cause) {
      if (!active.signal.aborted && controller.current === active)
        setError(cause instanceof Error ? cause.message : "定位请求失败。");
    } finally {
      if (controller.current === active) {
        setBusy(false);
        controller.current = null;
      }
    }
  }
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <button
        type="button"
        className="text-sm font-semibold text-blue-700"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        时间不准或没有 Request ID？按特征查找
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-xs leading-5 text-slate-600">
            使用下方客户问题中的原话提取线索。先确认客户账号，再尝试时区、上午下午及日期偏差；最多查询六次、扫描五百条日志。
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="label">
              客户记忆中的流式设置
              <select
                className="mt-1 w-full rounded border p-2"
                value={stream}
                onChange={(event) => setStream(event.target.value)}
              >
                <option value="">不确定</option>
                <option value="true">开启 stream</option>
                <option value="false">关闭 stream</option>
              </select>
            </label>
            <label className="label">
              已确认的客户账号
              <input
                className="mt-1 w-full rounded border p-2"
                value={username}
                maxLength={128}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setScopeConfirmed(false);
                }}
                placeholder="new-api 用户名，不支持通配符"
              />
            </label>
            <label className="label">
              客户原始时间（可不准确）
              <input
                className="mt-1 w-full rounded border p-2"
                value={occurredAt}
                maxLength={100}
                onChange={(event) => setOccurredAt(event.target.value)}
                placeholder="2026-10-23 18:30；也可在问题中写昨天下午"
              />
            </label>
            <label className="label">
              客户时间采用的时区
              <select
                className="mt-1 w-full rounded border p-2"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {[
                  [480, "UTC+8（北京时间）"],
                  [0, "UTC"],
                  [540, "UTC+9"],
                  [-240, "UTC-4"],
                  [-300, "UTC-5"],
                  [60, "UTC+1"],
                  [120, "UTC+2"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              客户记忆中的模型
              <input
                className="mt-1 w-full rounded border p-2"
                value={model}
                maxLength={128}
                onChange={(event) => setModel(event.target.value)}
                placeholder="可选，例如 claude"
              />
            </label>
            <label className="label">
              客户记忆中的渠道编号
              <input
                className="mt-1 w-full rounded border p-2"
                type="number"
                min={1}
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              />
            </label>
            <label className="label">
              错误关键词
              <input
                className="mt-1 w-full rounded border p-2"
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="例如 429, ValidationException，最多六项"
              />
            </label>
            <label className="label">
              Request ID 线索
              <input
                className="mt-1 w-full rounded border p-2"
                value={requestId}
                maxLength={128}
                onChange={(event) => {
                  setRequestId(event.target.value);
                  setExactId(false);
                }}
                placeholder="可选，客户口述可作为软线索"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={exactId}
                disabled={!requestId.trim()}
                onChange={(event) => setExactId(event.target.checked)}
              />
              该 ID 从原始日志复制，必须精确匹配
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scopeConfirmed}
              onChange={(event) => setScopeConfirmed(event.target.checked)}
            />
            已核对客户账号；所有查询固定在该账号范围内
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !username.trim() || !scopeConfirmed}
              onClick={() => void search()}
            >
              {busy ? "正在定位请求…" : "按特征定位请求"}
            </button>
            {busy && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  controller.current?.abort();
                  controller.current = null;
                  setBusy(false);
                  setError("查询已取消，不能视为没有匹配日志。");
                }}
              >
                取消查询
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          {result && (
            <div
              className="max-h-[70vh] space-y-3 overflow-y-auto rounded border border-slate-200 p-3"
              aria-live="polite"
            >
              <p className="font-semibold">{statusLabels[result.status]}</p>
              <p className="text-xs text-slate-600">
                已执行 {result.requests} 次查询，扫描 {result.scanned} 条日志。解释后的客户时间：
                {result.interpretedTime || "无法可靠解析"}。候选排序分数是相对匹配分，不代表概率。
              </p>
              {result.error && (
                <p role="alert" className="text-sm text-red-700">
                  {result.error.message}
                </p>
              )}
              <ul className="list-disc pl-5 text-xs text-slate-600">
                {result.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
              <details>
                <summary className="cursor-pointer text-sm">查看线索来源与查询覆盖范围</summary>
                <ul className="mt-2 text-xs">
                  {result.clues.map((clue, index) => (
                    <li key={index}>
                      {clue.field}：{clue.value} ·{" "}
                      {clue.reliability === "confirmed" ? "已确认，固定筛选" : "回忆线索，可放宽"} ·{" "}
                      {clue.source === "operator"
                        ? "支持人员填写"
                        : clue.source === "model"
                          ? "模型从原话提取"
                          : "客户原话"}
                    </li>
                  ))}
                </ul>
                <ul className="mt-2 text-xs">
                  {result.rounds.map((round, index) => (
                    <li key={index}>
                      {round.label} · {new Date(round.start * 1000).toISOString()} 至{" "}
                      {new Date(round.end * 1000).toISOString()} · 第 {round.page} 页，读取{" "}
                      {round.fetched}/{round.total} 条 ·{" "}
                      {round.complete ? "该范围已读至末页" : "该范围尚未读完"}
                    </li>
                  ))}
                </ul>
              </details>
              <p className="rounded bg-blue-50 p-3 text-sm text-blue-900">
                建议补充：{result.followUp}
              </p>
              {result.groups.map((group, index) => (
                <div
                  className="rounded border border-amber-200 bg-amber-50 p-3 text-xs"
                  key={index}
                >
                  <b>可能相关的请求（按时间排序）</b>
                  <p className="mt-1 break-all">{group.requestIds.join(" → ")}</p>
                  <ul className="mt-1">
                    {group.requestIds.map((id) => {
                      const item = result.candidates.find(
                        (candidate) => candidate.requestId === id,
                      );
                      return (
                        <li key={id}>
                          {item?.occurredAt || "时间未记录"} · {item?.model || "模型未记录"} ·{" "}
                          {item?.type === 5
                            ? "错误日志"
                            : item?.type === 2
                              ? "消耗日志"
                              : "其他日志"}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-1">{group.reason}</p>
                </div>
              ))}
              {result.candidates.map((candidate) => (
                <article
                  className="rounded-lg border border-slate-200 p-3 text-sm"
                  key={candidate.requestId}
                >
                  <p className="break-all font-semibold">
                    {candidate.requestId} · 匹配分 {candidate.score}
                  </p>
                  <p className="mt-1">
                    实际时间（UTC）：{candidate.occurredAt || "未记录"} · 模型：
                    {candidate.model || "未记录"} · 渠道：{candidate.channel ?? "未记录"}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    {candidate.type === 5
                      ? "错误日志"
                      : candidate.type === 2
                        ? "消耗日志（不代表已确认成功）"
                        : "其他日志"}{" "}
                    · stream：{candidate.isStream === null ? "未记录" : String(candidate.isStream)}{" "}
                    · 耗时：{candidate.useTime === null ? "未记录" : `${candidate.useTime} 秒`}
                  </p>
                  <p className="mt-1 text-emerald-800">
                    {candidate.matches.join("；") ||
                      "仅在客户账号及查询范围内出现，缺少其他匹配特征"}
                  </p>
                  {candidate.conflicts.length > 0 && (
                    <p className="mt-1 text-amber-800">需核对：{candidate.conflicts.join("；")}</p>
                  )}
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                    {candidate.content || "日志未记录错误原文"}
                  </pre>
                  <button
                    type="button"
                    className="btn mt-2"
                    disabled={importedId === candidate.requestId}
                    onClick={() => {
                      try {
                        onImport(candidate, result);
                        setImportedId(candidate.requestId);
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "导入失败，请缩小查询范围后重试。",
                        );
                      }
                    }}
                  >
                    {importedId === candidate.requestId ? "已确认并导入" : "确认此请求并导入"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
