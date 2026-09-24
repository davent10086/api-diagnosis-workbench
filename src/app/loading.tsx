export default function Loading() {
  return (
    <div aria-live="polite" className="page max-w-5xl animate-pulse space-y-5">
      <div className="h-6 w-40 rounded bg-slate-200" />
      <div className="h-16 rounded bg-slate-100" />
      <div className="h-40 rounded bg-slate-100" />
      <span className="sr-only">正在加载页面</span>
    </div>
  );
}
