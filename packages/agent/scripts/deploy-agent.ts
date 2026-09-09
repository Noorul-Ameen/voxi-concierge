/**
 * Synchronize this existing agent's prompt and tool contracts only.
 * Knowledge documents and voice/model/privacy settings are preserved.
 * Changed definitions receive new tool IDs so other agents using old tools are unaffected.
 */
import { buildAgentBehaviorPatch, buildClientTools, buildWebhookTools } from "../src/index.js";

const API = (process.env.ELEVENLABS_BASE_URL ?? "https://api.eu.residency.elevenlabs.io").replace(/\/$/, "");
const KEY = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const conciergeUrl = process.env.CONCIERGE_PUBLIC_URL;
const secret = process.env.TOOL_HMAC_SECRET;
if (!KEY || !agentId || !conciergeUrl || !secret)
  throw new Error(
    "ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, CONCIERGE_PUBLIC_URL and TOOL_HMAC_SECRET are required",
  );
if (!conciergeUrl.startsWith("https://")) throw new Error("CONCIERGE_PUBLIC_URL must use HTTPS");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Provider errors can echo request headers/body. Do not print credentials into a deployment log.
  if (!result.ok) throw new Error(`${method} ${path} failed (HTTP ${result.status})`);
  return (await result.json()) as T;
}

type Agent = { version_id?: string; conversation_config: { agent: { prompt: { tool_ids?: string[] } } } };
type Tool = { id: string; tool_config: { name: string; [key: string]: unknown } };

/** Compare only the supplied definition fields; service-added defaults need not trigger a new tool. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => matches(actual[i], v))
    );
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected)
    .filter(([, v]) => v !== undefined)
    .every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
}

const current = await api<Agent>("GET", `/v1/convai/agents/${agentId}`);
const attached = await Promise.all(
  (current.conversation_config.agent.prompt.tool_ids ?? []).map((id) =>
    api<Tool>("GET", `/v1/convai/tools/${id}`),
  ),
);
const definitions = [
  ...buildWebhookTools({ conciergeUrl, toolSecretHeader: { value: secret } }),
  ...buildClientTools(),
];
const ids: string[] = [];
for (const definition of definitions) {
  const existing = attached.find((tool) => tool.tool_config.name === definition.name);
  if (existing && matches(existing.tool_config, definition)) ids.push(existing.id);
  else {
    const created = await api<{ id: string }>("POST", "/v1/convai/tools", { tool_config: definition });
    ids.push(created.id);
    console.log(`prepared tool ${definition.name}`);
  }
}
// Protect an intervening console edit instead of replacing it from an older snapshot.
const latest = await api<Agent>("GET", `/v1/convai/agents/${agentId}`);
if (current.version_id && latest.version_id && current.version_id !== latest.version_id)
  throw new Error(
    "Agent changed during preparation; no agent update was applied. Review the latest version before retrying.",
  );
await api("PATCH", `/v1/convai/agents/${agentId}`, buildAgentBehaviorPatch(ids));
console.log(
  `Updated prompt and tool contracts for ${agentId}; preserved live voice, model, knowledge and privacy settings.`,
);
