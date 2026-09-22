import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateDiagnosisCases, type DiagnosisEvalCase } from "@/lib/diagnosis-eval";

async function main() {
  const fixturePath = process.argv[2] ?? "tests/evals/diagnosis-cases.json";
  const cases = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as DiagnosisEvalCase[];
  const result = evaluateDiagnosisCases(cases);
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}

void main();
