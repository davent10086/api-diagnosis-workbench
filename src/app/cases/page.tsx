import Link from "next/link";
import { desc } from "drizzle-orm";
import { Plus } from "lucide-react";
import { Shell, Top } from "@/components/workbench";
import { db } from "@/db/client";
import { cases } from "@/db/schema";

export const dynamic = "force-dynamic";
export default async function Cases(){let items:typeof cases.$inferSelect[]=[];let unavailable=false;try{items=await db.select().from(cases).orderBy(desc(cases.createdAt)).limit(100)}catch{unavailable=true}return <Shell><Top title="案件列表"/><div className="p-6"><div className="mb-5 flex justify-between"><div><h1 className="text-xl font-bold">案件</h1><p className="text-sm text-muted">保留证据、规则与诊断结论的本地排障记录。</p></div><Link className="btn btn-primary" href="/cases/new"><Plus size={16}/>新建案件</Link></div><div className="panel p-4">{unavailable?<p className="text-sm text-red-700">数据库不可用。请完成迁移并检查 DATABASE_URL。</p>:items.length===0?<p className="text-sm text-muted">尚无案件。</p>:items.map(item=><Link href={`/cases/${item.id}`} className="mt-2 block rounded-lg border p-4" key={item.id}><b>{item.title}</b><p className="mt-2 text-sm text-muted">{item.summary??"无摘要"} · {item.status} · {item.createdAt.toLocaleString("zh-CN")}</p></Link>)}</div></div></Shell>}
