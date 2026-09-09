import { readFileSync } from "node:fs";
import { type SimulationEvidence, auditSimulationEvidence } from "../src/simulation-evidence.js";

const input = process.argv[2];
if (!input) throw new Error("Usage: tsx audit-simulation-evidence.ts validation-run.json");
const run = JSON.parse(readFileSync(input, "utf8")) as {
  tests: (SimulationEvidence & { evaluation?: { result?: string } })[];
};
const findings = run.tests.flatMap((test, index) => {
  const errors = auditSimulationEvidence(test);
  return errors.length ? [{ index, name: test.name, providerResult: test.evaluation?.result, errors }] : [];
});
console.log(
  JSON.stringify(
    {
      testsReviewed: run.tests.length,
      providerPasses: run.tests.filter((test) => test.evaluation?.result === "success").length,
      testsWithDeterministicFailures: findings.length,
      findings,
      scope: "Partial automatic checks only; remaining criteria and the full trace still require review.",
    },
    null,
    2,
  ),
);
if (findings.length) process.exitCode = 1;
