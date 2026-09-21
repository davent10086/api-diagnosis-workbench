import type { Trace } from "@/lib/types";

export const uuid = "00000000-0000-4000-8000-000000000001";
export function trace(overrides: Partial<Trace> = {}): Trace {
  return { provider: "Bedrock", route: "bedrock", statusCode: 400, logs: [], ...overrides };
}
export function casePayload(overrides: Partial<Trace> = {}) {
  return { title: "test case", trace: trace(overrides) };
}
