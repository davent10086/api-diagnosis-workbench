"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BookOpen, FileText, Settings, ShieldCheck, ChartNoAxesCombined } from "lucide-react";

const navigation = [
  ["案件", "/cases", FileText],
  ["知识库", "/knowledge", BookOpen],
  ["规则中心", "/rules", Activity],
  ["诊断质量", "/quality", ChartNoAxesCombined],
  ["设置", "/settings", Settings],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="border-b border-slate-800 bg-navy px-3 py-4 text-slate-300 md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-2"><Activity size={17} className="text-slate-400" /><b className="text-sm font-semibold text-white">API 排障助手</b></div>
        <p className="mb-2 mt-7 px-2 text-[11px] font-medium text-slate-500">工作台</p>
        <nav className="grid grid-cols-2 gap-1 md:block md:space-y-1">
          {navigation.map(([name, href, Icon]) => (
            <Link aria-current={pathname === href ? "page" : undefined} className={`flex items-center gap-2 border-l-2 px-2 py-2 text-sm transition ${pathname === href || (href === "/cases" && pathname.startsWith("/cases")) ? "border-blue-400 bg-white/[0.07] text-white" : "border-transparent hover:bg-white/[0.04] hover:text-white"}`} href={href} key={href} onClick={() => setPendingHref(href === pathname ? null : href)}>
              <Icon size={15} className="text-slate-400" />{name}
            </Link>
          ))}
        </nav>
        {pendingHref && <p aria-live="polite" className="mt-3 px-2 text-xs text-slate-300">正在打开页面…</p>}
        <p className="mt-8 hidden border-t border-slate-800 px-2 pt-3 text-xs leading-5 text-slate-500 md:block">证据仅保存在当前设备。</p>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function Top({ title = "案件" }: { title?: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-5 md:px-6">
      <b className="text-sm font-semibold text-slate-800">{title}</b>
      <span className="flex items-center gap-1.5 text-xs text-slate-500"><ShieldCheck size={14} className="text-emerald-600" />本地处理</span>
    </header>
  );
}
