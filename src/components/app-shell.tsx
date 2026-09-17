import Link from "next/link";
import { BookOpen, FileText, Settings, ShieldCheck, SlidersHorizontal } from "lucide-react";

const navigation = [
  ["案件", "/cases", FileText],
  ["知识库", "/knowledge", BookOpen],
  ["规则中心", "/rules", SlidersHorizontal],
  ["设置", "/settings", Settings],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="bg-navy p-5 text-slate-300">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-blue-500/20 p-2 text-blue-200">
            <ShieldCheck size={20} />
          </div>
          <div>
            <b className="text-lg text-white">API 排障助手</b>
            <p className="mt-0.5 text-xs text-slate-400">本地诊断工作台</p>
          </div>
        </div>
        <nav className="mt-10 space-y-2" aria-label="主导航">
          {navigation.map(([name, href, Icon]) => (
            <Link
              className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-white/10 hover:text-white"
              href={href}
              key={href}
            >
              <Icon size={17} />
              {name}
            </Link>
          ))}
        </nav>
        <p className="mt-10 rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-400">
          证据仅在此设备的 storage/ 目录保存。
        </p>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function Top({ title = "案件" }: { title?: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b bg-white/90 px-5 backdrop-blur">
      <div>
        <p className="text-xs text-muted">API 排障助手</p>
        <b>{title}</b>
      </div>
      <span className="badge bg-emerald-50 text-emerald-700">
        <ShieldCheck size={14} />
        本地处理
      </span>
    </header>
  );
}
