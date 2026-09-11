import {
  type AgentBuildOptions,
  buildAgentBehaviorPatch,
  buildClientTools,
  buildWebhookTools,
} from "./index.js";
import { assertExpectedVersion, buildProcedures, matchesAuthored } from "./procedures.js";

type Agent = {
  version_id?: string;
  conversation_config: Record<string, any>;
  workflow?: unknown;
  platform_settings?: unknown;
};
type Tool = { id: string; tool_config: { name: string; [key: string]: unknown } };
type Procedure = {
  procedure_id: string;
  name: string;
  type: string;
  has_draft?: boolean;
  referenced_tool_ids?: string[];
};
export type AgentApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function protectedSettings(agent: Agent) {
  const { prompt: _prompt, ...agentSettings } = agent.conversation_config.agent ?? {};
  // The provider also expands tool_ids into tools on reads; those change with the authored inventory.
  const {
    prompt: _text,
    tool_ids: _tools,
    tools: _expandedTools,
    built_in_tools: _native,
    ...modelSettings
  } = _prompt ?? {};
  const { agent: _agent, ...conversation } = agent.conversation_config;
  return { conversation, agentSettings, modelSettings, platform_settings: agent.platform_settings };
}

/** Candidate-only lifecycle. Explicit caller authorization is required; this cannot promote main. */
export async function syncCandidateAgent(
  api: AgentApi,
  options: {
    agentId: string;
    branchId: string;
    mainBranchId: string;
    expectedVersion: string;
    build: AgentBuildOptions;
  },
) {
  const { agentId, branchId, mainBranchId, expectedVersion, build } = options;
  if (!agentId || !branchId || !mainBranchId || branchId === mainBranchId)
    throw new Error("An explicit non-main candidate branch and main branch ID are required");
  const agentPath = `/v1/convai/agents/${encodeURIComponent(agentId)}?branch_id=${encodeURIComponent(branchId)}`;
  const procedurePath = `/v1/convai/agents/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branchId)}/procedures`;
  const current = await api<Agent>("GET", agentPath);
  assertExpectedVersion(current.version_id, expectedVersion);
  const before = protectedSettings(current);
  const existingProcedures = (await api<{ procedures: Procedure[] }>("GET", procedurePath)).procedures;
  const definitions = [...buildWebhookTools(build), ...buildClientTools()];
  const attached: Tool[] = await Promise.all(
    (current.conversation_config.agent?.prompt?.tool_ids ?? []).map((id: string) =>
      api<Tool>("GET", `/v1/convai/tools/${encodeURIComponent(id)}`),
    ),
  );
  const plannedTypes = new Map(
    buildProcedures(definitions.map((tool, i) => ({ name: tool.name, id: `tool_validation_${i}` }))).map(
      (p) => [p.name, p.type],
    ),
  );
  if (
    existingProcedures.some((p) => plannedTypes.get(p.name) !== p.type) ||
    new Set(existingProcedures.map((p) => p.name)).size !== existingProcedures.length
  )
    throw new Error("Candidate contains unmanaged or ambiguous procedures; review before synchronization");
  const currentWorkflow = current.workflow as
    | {
        nodes?: Record<string, { type?: string }>;
        edges?: Record<string, unknown>;
        subgraphs?: Record<string, unknown>;
      }
    | undefined;
  const meaningfulWorkflow =
    currentWorkflow &&
    (Object.keys(currentWorkflow.edges ?? {}).length > 0 ||
      Object.keys(currentWorkflow.subgraphs ?? {}).length > 0 ||
      Object.values(currentWorkflow.nodes ?? {}).some((node) => node.type !== "start"));
  if (meaningfulWorkflow && existingProcedures.length === 0)
    throw new Error("Candidate has an unmanaged workflow; replacement is not permitted");
  const tools: { name: string; id: string }[] = [];
  for (const definition of definitions) {
    const existing = attached.find((tool) => tool.tool_config.name === definition.name);
    const id =
      existing && matchesAuthored(existing.tool_config, definition)
        ? existing.id
        : (await api<{ id: string }>("POST", "/v1/convai/tools", { tool_config: definition })).id;
    tools.push({ name: definition.name, id });
  }
  const prepared: { key: string; id: string; toolIds: string[] }[] = [];
  for (const { key, referenced_tool_ids, ...body } of buildProcedures(tools)) {
    const existing = existingProcedures.find((procedure) => procedure.name === body.name);
    if (existing?.has_draft) {
      const draft = await api<unknown>(
        "GET",
        `${procedurePath}/${encodeURIComponent(existing.procedure_id)}/draft`,
      );
      if (!matchesAuthored(draft, body))
        throw new Error(`A different unpublished draft exists for ${key}; preserved`);
    }
    const id =
      existing?.procedure_id ??
      (await api<{ procedure_id: string }>("POST", procedurePath, body)).procedure_id;
    if (!id) throw new Error(`Provider returned no procedure ID for ${key}`);
    if (existing && !existing.has_draft)
      await api("PATCH", `${procedurePath}/${encodeURIComponent(id)}/draft`, body);
    prepared.push({ key, id, toolIds: referenced_tool_ids });
  }
  assertExpectedVersion((await api<Agent>("GET", agentPath)).version_id, expectedVersion);
  const compiled = await api<{
    workflow: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
  }>("POST", `${procedurePath}/compile`);
  if (!compiled.workflow || !Object.keys(compiled.workflow.nodes ?? {}).length || !compiled.workflow.edges)
    throw new Error("Procedure compiler returned no usable workflow; candidate not published");
  assertExpectedVersion((await api<Agent>("GET", agentPath)).version_id, expectedVersion);
  const patch = buildAgentBehaviorPatch(
    tools.map((tool) => tool.id),
    { proceduresEnabled: true },
  );
  await api("PATCH", agentPath, {
    ...patch,
    workflow: compiled.workflow,
    version_description: "VOX: four journey procedures and one fixed brief acknowledgement",
  });
  const after = await api<Agent>("GET", agentPath);
  if (!after.version_id || after.version_id === expectedVersion)
    throw new Error("Published version could not be verified");
  if (
    !matchesAuthored(protectedSettings(after), before) ||
    !matchesAuthored(before, protectedSettings(after))
  )
    throw new Error("Candidate published but protected settings differ; stop before promotion");
  if (
    !matchesAuthored(after.conversation_config.agent?.prompt, patch.conversation_config.agent.prompt) ||
    !matchesAuthored(after.workflow, compiled.workflow)
  )
    throw new Error("Published prompt/tools/workflow did not match; do not promote");
  const published = (
    await api<{ procedures: Procedure[] }>(
      "GET",
      `${procedurePath}?agent_version_id=${encodeURIComponent(after.version_id)}`,
    )
  ).procedures;
  for (const expected of prepared) {
    const actual = published.find((p) => p.procedure_id === expected.id);
    if (
      !actual ||
      actual.has_draft ||
      [...(actual.referenced_tool_ids ?? [])].sort().join() !== [...expected.toolIds].sort().join()
    )
      throw new Error(`Published references could not be verified: ${expected.key}; do not promote`);
  }
  return {
    agentId,
    branchId,
    previousVersion: expectedVersion,
    versionId: after.version_id,
    tools,
    procedures: prepared,
    promoted: false as const,
  };
}
