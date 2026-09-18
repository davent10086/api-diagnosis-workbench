"use client";

import { ChangeEvent, DragEvent, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";

type Props = { files: File[]; onChange: (files: File[]) => void; imagesConfirmed?: boolean; onImagesConfirmedChange?: (value: boolean) => void };
const accepted = "image/png,image/jpeg,.json,.txt,text/plain,application/json";
const MAX_BYTES = 10 * 1024 * 1024;
const allowedTypes = new Set(["application/json", "text/plain", "image/png", "image/jpeg"]);

export function EvidenceUploader({ files, onChange, imagesConfirmed = false, onImagesConfirmedChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const addFiles = (next: File[]) => {
    const invalid = next.find((file) => file.size === 0 || file.size > MAX_BYTES || !allowedTypes.has(file.type));
    if (invalid) {
      setError(invalid.size === 0 || invalid.size > MAX_BYTES ? "每个文件必须介于 1 B 和 10 MB 之间。" : "只支持 JSON、TXT、PNG 和 JPEG 文件。");
      return;
    }
    setError("");
    onChange([...files, ...next]);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };
  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  return (
    <section className="panel p-4">
      <h2 className="section-title">证据上传</h2>
      <label
        className={`mt-3 flex cursor-pointer flex-col items-center rounded-md border border-dashed p-4 text-center text-sm transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40"}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <FileUp />
        <span>拖拽或选择 PNG、JPEG、JSON、TXT（单个最大 10 MB）</span>
        <input
          className="hidden"
          multiple
          type="file"
          accept={accepted}
          onChange={onInputChange}
        />
      </label>
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
      {files.some((file) => file.type.startsWith("image/")) && onImagesConfirmedChange && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs leading-5 text-amber-800">
          <input className="mt-1" type="checkbox" checked={imagesConfirmed} onChange={(event) => onImagesConfirmedChange(event.target.checked)} />
          我已确认所有截图不含密钥、Cookie、个人信息或其他敏感数据；允许将其发送至千问进行识别。
        </label>
      )}
      {files.map((file) => (
        <p
          className="mt-2 flex justify-between rounded bg-slate-50 p-2 text-sm"
          key={`${file.name}-${file.lastModified}`}
        >
          {file.name}
          <button
            aria-label={`移除 ${file.name}`}
            onClick={() => onChange(files.filter((item) => item !== file))}
          >
            <Trash2 size={14} />
          </button>
        </p>
      ))}
    </section>
  );
}
