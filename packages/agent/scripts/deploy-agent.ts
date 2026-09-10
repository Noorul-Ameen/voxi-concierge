/** Explicit candidate publication only. Main promotion is a separate reviewed action. */
import { existsSync, writeFileSync } from "node:fs";
import { syncCandidateAgent } from "../src/deployment.js";

if (!process.argv.includes("--apply"))
  throw new Error("No changes made. Use --apply only for an authorized candidate synchronization.");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const API = (process.env.ELEVENLABS_BASE_URL ?? "https://api.eu.residency.elevenlabs.io").replace(/\/$/, "");
if (API !== "https://api.eu.residency.elevenlabs.io") throw new Error("Use the configured EU region");
const key = required("ELEVENLABS_API_KEY");
const conciergeUrl = required("CONCIERGE_PUBLIC_URL");
if (!conciergeUrl.startsWith("https://")) throw new Error("CONCIERGE_PUBLIC_URL must use HTTPS");
const reportPath = required("ELEVENLABS_DEPLOYMENT_REPORT");
if (existsSync(reportPath)) throw new Error("Choose a new deployment evidence path");
const result = await syncCandidateAgent(
  async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Errors can echo credentials: never log response bodies or headers.
    if (!response.ok) throw new Error(`${method} provider request failed (HTTP ${response.status})`);
    return response.json() as Promise<T>;
  },
  {
    agentId: required("ELEVENLABS_AGENT_ID"),
    branchId: required("ELEVENLABS_BRANCH_ID"),
    mainBranchId: required("ELEVENLABS_MAIN_BRANCH_ID"),
    expectedVersion: required("ELEVENLABS_EXPECTED_VERSION"),
    build: { conciergeUrl, toolSecretHeader: { value: required("TOOL_HMAC_SECRET") } },
  },
);
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(
  `Verified candidate ${result.versionId}; voice/model/privacy/timing preserved. Main not promoted.`,
);
