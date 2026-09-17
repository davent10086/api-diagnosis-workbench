"use client";

import { DragEvent, useState } from "react";
import { FileUp, Trash2 } from "lucide-react";

type Props = { files: File[]; onChange: (files: File[]) => void };
const accepted = "image/png,image/jpeg,.json,.txt,text/plain,application/json";

export function EvidenceUploader({ files, onChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const addFiles = (next: File[]) => onChange([...files, ...next]);
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };
  return (
    <section className="panel p-4">
      <h2>证据上传</h2>
      <label
        className={`mt-3 flex cursor-pointer flex-col items-center rounded-lg border border-dashed p-5 text-sm ${dragging ? "border-blue-500 bg-blue-50" : ""}`}
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
          onChange={(event) => addFiles(Array.from(event.target.files ?? []))}
        />
      </label>
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
