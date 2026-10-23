import { NextResponse } from "next/server";
import { locationInputSchema } from "@/lib/request-location-types";
import { locateRequests } from "@/lib/request-location";

export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  const parsed = locationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "请填写已确认的客户账号与有效查询线索；账号不能使用通配符。" },
      { status: 400 },
    );
  try {
    const result = await locateRequests(
      parsed.data,
      AbortSignal.any([request.signal, AbortSignal.timeout(110000)]),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "请求定位已取消、超时或未能完成；这不代表没有匹配日志。" },
      { status: request.signal.aborted ? 499 : 504, headers: { "Cache-Control": "no-store" } },
    );
  }
}
