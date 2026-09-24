import { NextRequest, NextResponse } from "next/server";
import { logPageSchema, toWorkbenchLog } from "@/lib/new-api-log";

export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("request_id")?.trim();
  if (!requestId || requestId.length > 64)
    return NextResponse.json({ error: "请输入有效的 Request ID。" }, { status: 400 });

  const baseUrl = process.env.NEW_API_BASE_URL?.trim();
  const token = process.env.NEW_API_ACCESS_TOKEN?.trim();
  if (!baseUrl || !token)
    return NextResponse.json({ error: "请先配置 NEW_API_BASE_URL 和 NEW_API_ACCESS_TOKEN。" }, { status: 503 });

  let url: URL;
  try {
    url = new URL("/api/log/", baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
  } catch {
    return NextResponse.json({ error: "NEW_API_BASE_URL 无效。" }, { status: 503 });
  }
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("p", "1");
  url.searchParams.set("page_size", "1");

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403)
      return NextResponse.json({ error: "new-api 访问令牌无效或没有查看日志权限。" }, { status: 502 });
    if (!response.ok)
      return NextResponse.json({ error: "new-api 日志查询失败。" }, { status: 502 });
    const parsed = logPageSchema.safeParse(await response.json());
    if (!parsed.success)
      return NextResponse.json({ error: "new-api 返回了无法识别的日志格式。" }, { status: 502 });
    const log = parsed.data.data.items.find((item) => item.request_id === requestId);
    if (!log) return NextResponse.json({ error: "没有找到这个 Request ID 的日志。" }, { status: 404 });
    return NextResponse.json(toWorkbenchLog(log), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "无法连接 new-api，请检查地址和服务状态。" }, { status: 502 });
  }
}
