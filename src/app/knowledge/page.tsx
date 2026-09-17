import { Shell, Top } from "@/components/workbench";
import { KnowledgeSearch } from "@/components/knowledge-search";
export default function Knowledge(){return <Shell><Top title={"\u5b98\u65b9\u77e5\u8bc6\u5e93"}/><div className="p-6"><h1 className="text-xl font-bold">{"\u5b98\u65b9\u77e5\u8bc6\u5e93"}</h1><p className="mt-1 text-sm text-muted">{"\u57fa\u4e8e PGroonga \u7684\u4e2d\u6587\u3001\u82f1\u6587\u4e0e API \u6280\u672f\u8bcd\u68c0\u7d22\u3002"}</p><KnowledgeSearch/></div></Shell>}
