/**
 * Deploy Voxi to ElevenLabs (idempotent):
 *   1. upsert knowledge base text documents from ../kb/*.md (by name)
 *   2. upsert tools (webhook + client) by name → tool ids
 *   3. create or update the agent (ELEVENLABS_AGENT_ID) with tool ids + KB
 * Env: ELEVENLABS_API_KEY, CONCIERGE_PUBLIC_URL, TOOL_HMAC_SECRET, [ELEVENLABS_AGENT_ID], [ELEVENLABS_BASE_URL]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentConfig, buildClientTools, buildWebhookTools } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io").replace(/\/$/, "");
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is required");

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function upsertKb() {
  const dir = path.resolve(here, "../kb");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const existing = await api<{ documents: { id: string; name: string; type: string }[] }>(
    "GET",
    "/v1/convai/knowledge-base?page_size=100",
  );
  const out: { id: string; name: string; type: "text" }[] = [];
  for (const f of files) {
    const name = `voxi/${f.replace(/\.md$/, "")}`;
    const text = await readFile(path.join(dir, f), "utf8");
    const found = existing.documents.find((d) => d.name === name);
    if (found) {
      // ElevenLabs has no text-update; delete + recreate to refresh content
      await api("DELETE", `/v1/convai/knowledge-base/${found.id}?force=true`).catch(() => undefined);
    }
    const created = await api<{ id: string }>("POST", "/v1/convai/knowledge-base/text", { name, text });
    out.push({ id: created.id, name, type: "text" });
    console.log(`kb ${found ? "refreshed" : "created"} ${name}`);
  }
  return out;
}

async function upsertTools(opts: Parameters<typeof buildWebhookTools>[0]) {
  const defs = [...buildWebhookTools(opts), ...buildClientTools()];
  const existing = await api<{ tools: { id: string; tool_config: { name: string } }[] }>(
    "GET",
    "/v1/convai/tools?page_size=100",
  );
  const ids: string[] = [];
  for (const def of defs) {
    const found = existing.tools.find((t) => t.tool_config.name === def.name);
    if (found) {
      await api("PATCH", `/v1/convai/tools/${found.id}`, { tool_config: def });
      ids.push(found.id);
      console.log(`tool updated ${def.name}`);
    } else {
      const created = await api<{ id: string }>("POST", "/v1/convai/tools", { tool_config: def });
      ids.push(created.id);
      console.log(`tool created ${def.name}`);
    }
  }
  return ids;
}

async function main() {
  const opts = {
    conciergeUrl: process.env.CONCIERGE_PUBLIC_URL ?? "https://voxi-concierge.example.com",
    toolSecretHeader: { value: process.env.TOOL_HMAC_SECRET ?? "change-me-tool-secret" },
    voiceIdEn: process.env.ELEVENLABS_VOICE_ID_EN,
    llm: process.env.ELEVENLABS_LLM,
  };
  const knowledgeBase = await upsertKb();
  const toolIds = await upsertTools(opts);
  const config = buildAgentConfig({ ...opts, knowledgeBase, toolIds });
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (agentId) {
    await api("PATCH", `/v1/convai/agents/${agentId}`, config);
    console.log(`agent updated ${agentId}`);
  } else {
    const created = await api<{ agent_id: string }>("POST", "/v1/convai/agents/create", config);
    console.log(`agent created ${created.agent_id} — set ELEVENLABS_AGENT_ID=${created.agent_id}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
