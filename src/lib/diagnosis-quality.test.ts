import { describe, expect, it } from "vitest";
import { adjudicateReport, buildEvidenceLedger } from "./diagnosis-quality";

const base = {
  confidence: 90,
  root_cause: "上游明确拒绝了参数",
  confirmed_evidence: ["rule:openai-parameter-compatibility"],
  hypotheses: ["其他路由未返回同类错误，已由上游响应排除。"],
  missing_evidence: [],
  customer_message: "已确认上游参数不兼容。",
  root_cause_evidence: ["rule:openai-parameter-compatibility"],
};

describe("diagnosis conclusion gate", () => {
  it("confirms only a high-confidence conclusion supported by a deterministic rule", () => {
    const result = adjudicateReport(base, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.conclusionStatus).toBe("confirmed");
  });

  it("downgrades a plausible model claim when evidence is incomplete", () => {
    const result = adjudicateReport({ ...base, confidence: 0, confirmed_evidence: ["text:attachment-a"] }, [{ ruleId: "http-5xx", severity: "high", faultLayer: "unknown", conclusion: "missing upstream response", evidence: [], needsMoreEvidence: true }]);
    expect(result.conclusionStatus).toBe("provisional");
    expect(result.blockers.join(" ")).toContain("80%");
    expect(result.customerMessage).toContain("初步判断");
  });

  it("does not confirm a root cause without an explicit evidence binding", () => {
    const result = adjudicateReport({ ...base, root_cause_evidence: [] }, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.conclusionStatus).toBe("provisional");
  });

  it("keeps a ledger that distinguishes facts, candidates, and blockers", () => {
    const ledger = buildEvidenceLedger({ statusCode: 502 }, [{ ruleId: "http-5xx", severity: "high", faultLayer: "unknown", conclusion: "need upstream", evidence: [], needsMoreEvidence: true }], [{ id: "a", content: "log evidence" }], []);
    expect(ledger.find((item) => item.id === "trace:statusCode")?.kind).toBe("fact");
    expect(ledger.find((item) => item.id === "rule:http-5xx")?.kind).toBe("blocker");
  });
});
