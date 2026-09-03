/** Export the agent definition (tools + config) to dist/agent/*.json for review / manual import. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentConfig, buildClientTools, buildWebhookTools } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../dist/agent");
const opts = {
  conciergeUrl: process.env.CONCIERGE_PUBLIC_URL ?? "https://voxi-concierge.example.com",
  toolSecretHeader: { value: process.env.TOOL_HMAC_SECRET ?? "change-me-tool-secret" },
  inlineTools: true,
};
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "webhook-tools.json"), JSON.stringify(buildWebhookTools(opts), null, 2));
await writeFile(path.join(out, "client-tools.json"), JSON.stringify(buildClientTools(), null, 2));
await writeFile(path.join(out, "agent.json"), JSON.stringify(buildAgentConfig(opts), null, 2));
console.log(`exported to ${out}`);
