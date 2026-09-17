import { describe, expect, it } from "vitest";
import { redact, redactTrace } from "./redaction";

describe("redaction", () => {
  it("masks inline credentials without leaking the match offset", () => expect(redact("x sk-abcdefghijk")).toBe("x [已遮蔽]"));
  it("masks nested JSON credentials before persistence", () => expect(redactTrace({ clientRequest:{ headers:{ Authorization:"Bearer top-secret", "x-api-key":"key" }, password:"p" } })).toEqual({ clientRequest:{ headers:{ Authorization:"[已遮蔽]", "x-api-key":"[已遮蔽]" }, password:"[已遮蔽]" } }));
  it("masks provider-specific credential keys and values", () => expect(redactTrace({ clientRequest:{ headers:{ "x-goog-api-key":"AIzaabcdefghijklmnopqrstuv" }, aws_secret_access_key:"secret" } })).toEqual({ clientRequest:{ headers:{ "x-goog-api-key":"[已遮蔽]" }, aws_secret_access_key:"[已遮蔽]" } }));
});
