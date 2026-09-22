import type { AiReport } from "./diagnosis";

export type DiagnosisEvalCase = {
  id: string;
  expectedRootCauseTerms: string[];
  requiredEvidence?: string[];
  report: Pick<AiReport, "root_cause" | "confirmed_evidence" | "root_cause_evidence">;
};

export type DiagnosisEvalResult = {
  total: number;
  rootCauseHits: number;
  evidenceHits: number;
  rootCauseAccuracy: number;
  evidenceRecall: number;
  failures: string[];
};

/** Deterministic, offline regression score for human-reviewed cases. */
export function evaluateDiagnosisCases(cases: DiagnosisEvalCase[]): DiagnosisEvalResult {
  let rootCauseHits = 0;
  let evidenceHits = 0;
  const failures: string[] = [];
  for (const item of cases) {
    const cause = item.report.root_cause.toLocaleLowerCase();
    const rootCauseOk = item.expectedRootCauseTerms.some((term) => cause.includes(term.toLocaleLowerCase()));
    const cited = new Set(item.report.confirmed_evidence);
    const evidenceOk = (item.requiredEvidence ?? []).every((reference) => cited.has(reference));
    if (rootCauseOk) rootCauseHits += 1;
    else failures.push(`${item.id}: root cause mismatch`);
    if (evidenceOk) evidenceHits += 1;
    else failures.push(`${item.id}: required evidence missing`);
  }
  const total = cases.length;
  return { total, rootCauseHits, evidenceHits, rootCauseAccuracy: total ? rootCauseHits / total : 1, evidenceRecall: total ? evidenceHits / total : 1, failures };
}
