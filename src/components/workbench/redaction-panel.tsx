import { CheckCircle2, ShieldCheck } from "lucide-react";
import { hasSensitive, redact } from "@/lib/redaction";

type Props = { text: string; approved: boolean; onApply: (text: string) => void };
export function RedactionPanel({ text, approved, onApply }: Props) {
  return (
    <section className="panel p-4">
      <h2 className="section-title">脱敏确认</h2>
      {hasSensitive(text) && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs leading-5 text-amber-700">发现常见敏感字段；保存前请应用遮蔽。</p>
      )}
      <button className="btn mt-3" onClick={() => onApply(redact(text))}>
        {approved ? <CheckCircle2 /> : <ShieldCheck />}
        {approved ? "已确认脱敏" : "应用遮蔽并确认"}
      </button>
    </section>
  );
}
