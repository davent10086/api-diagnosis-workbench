import { describe, expect, it } from "vitest";
import { adjudicateReport, buildEvidenceLedger } from "./diagnosis-quality";

const base = {
  root_cause: "上游明确拒绝了参数",
  confirmed_evidence: ["rule:openai-parameter-compatibility"],
  hypotheses: ["其他路由未返回同类错误，已由上游响应排除。"],
  missing_evidence: [],
  customer_message: "已确认上游参数不兼容。",
  root_cause_evidence: ["rule:openai-parameter-compatibility"],
};

describe("diagnosis conclusion gate", () => {
  it("keeps a rule-backed model conclusion provisional until human review", () => {
    const result = adjudicateReport(base, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.conclusionStatus).toBe("provisional");
    expect(result.blockers.join(" ")).toContain("人工复核");
  });

  it("downgrades a plausible model claim when evidence is incomplete", () => {
    const result = adjudicateReport({ ...base, confirmed_evidence: ["text:attachment-a"] }, [{ ruleId: "http-5xx", severity: "high", faultLayer: "unknown", conclusion: "missing upstream response", evidence: [], needsMoreEvidence: true }]);
    expect(result.conclusionStatus).toBe("provisional");
    expect(result.blockers.join(" ")).toContain("missing upstream response");
    expect(result.customerMessage).toContain("初步判断");
  });

  it("does not confirm a root cause without an explicit evidence binding", () => {
    const result = adjudicateReport({ ...base, root_cause_evidence: [] }, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.conclusionStatus).toBe("provisional");
    expect(result.blockers.join(" ")).toContain("根因未绑定");
  });

  it("requires a definitive rule in the root cause evidence itself", () => {
    const result = adjudicateReport({
      ...base,
      confirmed_evidence: ["rule:openai-parameter-compatibility", "trace:statusCode"],
      root_cause_evidence: ["trace:statusCode"],
    }, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.conclusionStatus).toBe("provisional");
    expect(result.blockers.join(" ")).toContain("根因缺少可确定性规则支撑");
  });

  it("matches a bare root-cause reference to a cited fact with an explanation", () => {
    const result = adjudicateReport({
      ...base,
      confirmed_evidence: ["rule:openai-parameter-compatibility：上游明确拒绝该参数。"],
      root_cause_evidence: ["rule:openai-parameter-compatibility"],
    }, [{ ruleId: "openai-parameter-compatibility", severity: "high", faultLayer: "adapter", conclusion: "unsupported", evidence: [], needsMoreEvidence: false }]);
    expect(result.blockers).toEqual(["根因与规则结论的语义关系尚待人工复核。"]);
  });

  it("reports insufficient evidence when the model cites no facts", () => {
    const result = adjudicateReport({ ...base, confirmed_evidence: [], root_cause_evidence: [] }, []);
    expect(result.conclusionStatus).toBe("insufficient");
    expect(result.customerMessage).toContain("证据不足");
  });

  it("keeps a ledger that distinguishes facts, candidates, and blockers", () => {
    const ledger = buildEvidenceLedger({ statusCode: 502 }, [{ ruleId: "http-5xx", severity: "high", faultLayer: "unknown", conclusion: "need upstream", evidence: [], needsMoreEvidence: true }], [{ id: "a", content: "log evidence" }], []);
    expect(ledger.find((item) => item.id === "trace:statusCode")?.kind).toBe("fact");
    expect(ledger.find((item) => item.id === "rule:http-5xx")?.kind).toBe("blocker");
  });
});
