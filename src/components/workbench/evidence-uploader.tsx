import { FileUp, Trash2 } from "lucide-react";

type Props = { files: File[]; onChange:(files:File[])=>void };
export function EvidenceUploader({ files, onChange }: Props) {
  return <section className="panel p-4"><h2>证据上传</h2><label className="mt-3 flex cursor-pointer flex-col items-center rounded-lg border border-dashed p-5 text-sm"><FileUp/><span>上传 PNG、JPEG、JSON 或 TXT（单个最大 10 MB）</span><input className="hidden" multiple type="file" accept="image/png,image/jpeg,.json,.txt,text/plain,application/json" onChange={(event)=>onChange(Array.from(event.target.files??[]))}/></label>{files.map((file)=><p className="mt-2 flex justify-between rounded bg-slate-50 p-2 text-sm" key={`${file.name}-${file.lastModified}`}>{file.name}<button aria-label={`移除 ${file.name}`} onClick={()=>onChange(files.filter((item)=>item!==file))}><Trash2 size={14}/></button></p>)}</section>;
}
