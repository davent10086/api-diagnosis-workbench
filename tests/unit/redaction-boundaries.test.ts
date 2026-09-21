import { describe, expect, it } from "vitest";
import { hasSensitive, redact, redactTrace } from "@/lib/redaction";

describe("redaction boundaries", () => {
  it("redacts header, cookie, query and provider credential forms", () => {
    const input = "Authorization: Bearer definitely-not-real-value; Cookie=session=definitely-not-real; password=definitely-not-real https://x.test?a=1&token=definitely-not-real";
    const output = redact(input);
    expect(output).not.toContain("definitely-not-real");
    expect(output).toContain("https://x.test?a=1");
  });
  it("preserves nested non-sensitive Chinese values and nulls", () => {
    expect(redactTrace({ clientRequest: { message: "中文正常字段", items: [null, { count: 1 }], x_api_key: "not-real" } })).toMatchObject({ clientRequest: { message: "中文正常字段", items: [null, { count: 1 }] } });
  });
  it("does not retain state between global regular expression calls", () => {
    expect(hasSensitive("Bearer definitely-not-real")).toBe(true);
    expect(hasSensitive("Bearer definitely-not-real")).toBe(true);
    expect(hasSensitive("ordinary text")).toBe(false);
  });
});
