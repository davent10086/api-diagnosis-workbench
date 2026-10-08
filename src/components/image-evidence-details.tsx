export function ImageEvidenceDetails({ extraction }: { extraction: unknown }) {
  if (!extraction || typeof extraction !== "object") return null;
  const value = extraction as Record<string, unknown>;
  const fields = Array.isArray(value.fields) ? value.fields.filter((field): field is string => typeof field === "string") : [];
  const observations = Array.isArray(value.observations) ? value.observations as { name?: string; value?: string; quote?: string; location?: string }[] : [];
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  if (!fields.length && !warnings.length) return null;
  return <details className="mt-2">
    <summary className="cursor-pointer text-blue-700">查看识别字段（需结合原图核对）</summary>
    {typeof value.summary === "string" && <p className="mt-2 text-slate-600">{value.summary}</p>}
    <ul className="mt-2 space-y-2">{fields.map((field, index) => {
      const observation = observations.find((item) => item && `${item.name}=${item.value}` === field);
      return <li key={index} className="break-all"><p>[{index}] {field}</p>{observation?.quote && <p className="text-xs text-slate-500">原文：{observation.quote}{observation.location ? ` · 位置：${observation.location}` : ""}</p>}</li>;
    })}</ul>
    {warnings.map((warning, index) => <p className="mt-2 text-xs text-amber-700" key={index}>{warning}</p>)}
  </details>;
}
