import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { type AgentApi, syncCandidateAgent } from "../src/deployment.js";
import { buildAgentBehaviorPatch, buildClientTools, buildWebhookTools, systemPrompt } from "../src/index.js";
import { buildProcedures, loadProcedureSources } from "../src/procedures.js";

const build = { conciergeUrl: "https://fixture.invalid", toolSecretHeader: { secret_id: "fixture_secret" } };
const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  name,
  id: `tool_fixture_${name}`,
}));
describe("scoped procedure deployment", () => {
  it("resolves every authored reference against current tool revisions without changing protected configuration", () => {
    const procedures = buildProcedures(tools);
    expect(procedures).toHaveLength(5);
    expect(new Set(procedures.map((p) => p.trigger)).size).toBe(5);
    expect(
      procedures.slice(0, 4).every((p) => p.type === "free_form" && p.referenced_tool_ids.length > 0),
    ).toBe(true);
    expect(procedures[0].content).toContain('[tool id="tool_fixture_propose_booking"]');
    expect(procedures[3].content).toContain('[tool id="tool_fixture_investigate_payment"]');
    const revised = buildProcedures(
      tools.map((tool) => (tool.name === "quick_book" ? { ...tool, id: "tool_new_revision" } : tool)),
    );
    expect(revised[0].content).toContain('[tool id="tool_new_revision"]');
    expect(revised[0].content).not.toContain('id="tool_fixture_quick_book"');
    expect(() => buildProcedures(tools.filter((tool) => tool.name !== "investigate_payment"))).toThrow(
      "Unresolved",
    );
    expect(() => buildProcedures([...tools, tools[0]!])).toThrow("unique");
    expect(systemPrompt()).toContain("proposalToken");
    expect(systemPrompt({ proceduresEnabled: true })).not.toContain("# Personalization and discovery");
    expect(
      buildAgentBehaviorPatch(
        tools.map((t) => t.id),
        { proceduresEnabled: true },
      ),
    ).not.toHaveProperty("conversation_config.tts");
  });

  it("bounds the structured acknowledgement to exact bilingual Say steps without business actions", () => {
    const procedure = buildProcedures(tools).find((p) => p.key === "brief-acknowledgement")!;
    expect(procedure.type).toBe("deterministic");
    expect(procedure.referenced_tool_ids).toEqual([]);
    expect(procedure.trigger).toContain("latest user turn only");
    expect(procedure.trigger).toContain("Excludes a booking or payment request");
    expect(procedure.trigger).toContain("request to pause or wait");
    const document = JSON.parse(procedure.content);
    expect(document.steps).toHaveLength(1);
    const branch = document.steps[0];
    expect(branch.type).toBe("branch");
    expect(branch.branches).toHaveLength(2);
    for (const arm of branch.branches) {
      expect(arm.condition).toMatchObject({ type: "llm" });
      expect(arm.condition.condition).toContain("latest user turn");
      expect(arm.condition.condition).toContain("details are already visible");
      expect(arm.condition.condition).toContain(
        "no substantive question, requested action, approval, pause or wait request",
      );
      expect(arm.condition.condition).toContain("'what is IMAX, briefly?' does NOT qualify");
    }
    expect(branch.branches[0].steps).toEqual([{ type: "say", message: "تمام، باختصر." }]);
    expect(branch.branches[1].steps).toEqual([{ type: "say", message: "Got it, I’ll keep it brief." }]);
    // A mistaken trigger selection must return silently, never replace a real question with an acknowledgement.
    expect(branch.fallback).toBeUndefined();
    expect(systemPrompt()).not.toContain('"type": "branch"');
  });

  it("refuses main, concurrent edits and unmanaged workflows before publishing", async () => {
    let writes = 0;
    const options = {
      agentId: "agent_fixture",
      branchId: "candidate",
      mainBranchId: "main",
      expectedVersion: "v1",
      build,
    };
    const api: AgentApi = async <T>(method: string) => {
      if (method !== "GET") writes++;
      return { version_id: "v2", conversation_config: { agent: { prompt: { tool_ids: [] } } } } as T;
    };
    await expect(syncCandidateAgent(api, { ...options, branchId: "main" })).rejects.toThrow("non-main");
    await expect(syncCandidateAgent(api, options)).rejects.toThrow("version changed");
    expect(writes).toBe(0);
  });

  it("publishes compiled drafts only on the candidate and verifies published references/settings", async () => {
    const definitions = [...buildWebhookTools(build), ...buildClientTools()];
    const byId = new Map(
      definitions.map((tool) => [
        `tool_fixture_${tool.name}`,
        { id: `tool_fixture_${tool.name}`, tool_config: tool },
      ]),
    );
    let agent = {
      workflow: { nodes: { start_node: { type: "start" } }, edges: {}, subgraphs: {} } as unknown,
      version_id: "v1",
      conversation_config: {
        agent: {
          language: "en",
          first_message: "unchanged",
          prompt: {
            llm: "unchanged-model",
            tool_ids: tools.map((t) => t.id),
            tools: [{ name: "prior-expanded-tool" }],
          },
        },
        tts: { voice_id: "user-chosen-voice" },
        turn: { silence_end_call_timeout: 180 },
        language_presets: { ar: { voice: "unchanged-Arabic" } },
      },
      platform_settings: { privacy: { retention_days: -1 } },
    };
    const drafts: Record<string, any>[] = [];
    const writes: string[] = [];
    const api: AgentApi = async <T>(method: string, path: string, body?: unknown) => {
      if (method !== "GET") writes.push(`${method} ${path}`);
      if (path.startsWith("/v1/convai/tools/")) return byId.get(path.split("/").at(-1)!) as T;
      if (path.endsWith("/compile"))
        return { workflow: { nodes: { entry: { type: "start" } }, edges: {} } } as T;
      if (path.includes("/procedures") && method === "POST") {
        const procedure_id = `agtprc_${drafts.length}`;
        drafts.push({ ...(body as object), procedure_id });
        return { procedure_id } as T;
      }
      if (path.includes("/procedures") && method === "GET")
        return {
          procedures:
            agent.version_id === "v1"
              ? []
              : drafts.map((p) => ({
                  ...p,
                  has_draft: false,
                  referenced_tool_ids: [
                    ...new Set(
                      [...p.content.matchAll(/\[tool id="([^"]+)"\]/g)].map((m: RegExpMatchArray) => m[1]),
                    ),
                  ],
                })),
        } as T;
      if (method === "PATCH") {
        const patch = body as any;
        agent = {
          ...agent,
          version_id: "v2",
          workflow: patch.workflow,
          conversation_config: {
            ...agent.conversation_config,
            ...patch.conversation_config,
            agent: {
              ...agent.conversation_config.agent,
              ...patch.conversation_config.agent,
              prompt: {
                ...agent.conversation_config.agent.prompt,
                ...patch.conversation_config.agent.prompt,
                tools: definitions,
              },
            },
          },
        };
      }
      return structuredClone(agent) as T;
    };
    const result = await syncCandidateAgent(api, {
      agentId: "agent_fixture",
      branchId: "candidate",
      mainBranchId: "main",
      expectedVersion: "v1",
      build,
    });
    expect(result.versionId).toBe("v2");
    expect(result.promoted).toBe(false);
    expect(result.procedures).toHaveLength(5);
    expect(writes.filter((path) => path.startsWith("PATCH"))).toEqual([
      "PATCH /v1/convai/agents/agent_fixture?branch_id=candidate",
    ]);
    expect(agent.conversation_config.tts.voice_id).toBe("user-chosen-voice");
    expect(agent.workflow).toMatchObject({ nodes: { entry: { type: "start" } } });
    expect(agent.conversation_config).not.toHaveProperty("workflow");
    expect(loadProcedureSources().every((p) => !p.content.includes('[tool id="'))).toBe(true);
  });
});
