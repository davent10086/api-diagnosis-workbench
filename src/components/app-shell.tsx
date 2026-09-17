import Link from "next/link";
import { ShieldCheck } from "lucide-react";

const navigation = [
  ["案件", "/cases"],
  ["知识库", "/knowledge"],
  ["规则中心", "/rules"],
  ["设置", "/settings"],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="bg-navy p-5 text-slate-300">
        <b className="text-lg text-white">API 排障助手</b>
        <nav className="mt-10 space-y-2">
          {navigation.map(([name, href]) => (
            <Link className="block rounded-lg px-3 py-2 hover:bg-white/10" href={href} key={href}>
              {name}
            </Link>
          ))}
        </nav>
        <p className="mt-10 text-xs">证据仅在此设备的 storage/ 目录保存。</p>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function Top({ title = "案件" }: { title?: string }) {
  return (
    <header className="flex h-16 items-center justify-between border-b bg-white px-5">
      <b>API 排障助手 / {title}</b>
      <span className="badge bg-emerald-50 text-emerald-700">
        <ShieldCheck size={14} />
        本地处理
      </span>
    </header>
  );
}
