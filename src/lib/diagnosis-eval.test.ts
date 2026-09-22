import { describe, expect, it } from "vitest";
import { evaluateDiagnosisCases } from "./diagnosis-eval";

describe("diagnosis regression evaluation", () => {
  it("scores root-cause and required-evidence regressions independently", () => {
    const result = evaluateDiagnosisCases([
      { id: "rate-limit", expectedRootCauseTerms: ["配额"], requiredEvidence: ["rule:http-429"], report: { root_cause: "上游配额耗尽", confirmed_evidence: ["rule:http-429"], root_cause_evidence: ["rule:http-429"] } },
      { id: "missing-proof", expectedRootCauseTerms: ["超时"], requiredEvidence: ["trace:statusCode"], report: { root_cause: "上游超时", confirmed_evidence: [], root_cause_evidence: [] } },
    ]);
    expect(result.rootCauseAccuracy).toBe(1);
    expect(result.evidenceRecall).toBe(0.5);
  });
});
