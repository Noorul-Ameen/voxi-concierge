import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";

type Condition = {
  path: string;
  eval: { type: "exact"; expected_value: string } | { type: "regex"; pattern: string };
};
export type SimulationMock = {
  parameter_conditions: Condition[];
  mock_result: string;
  is_error: boolean;
};
export type SimulationDefinition = {
  id: string;
  scenario_group: string;
  type: "simulation";
  name: string;
  dynamic_variables: Record<string, string>;
  chat_history: unknown[];
  success_conditions: string[];
  simulation_scenario: string;
  simulation_max_turns: number;
  tool_mock_config: {
    mocking_strategy: "all";
    fallback_strategy: "raise_error";
    mocked_tool_ids: string[];
  };
  tool_mock_overrides: Record<string, SimulationMock[]>;
};
export type SimulationSuite = {
  format_version: number;
  fixture: { synthetic: boolean; clock_local: string; time_zone: string };
  common_tool_mock_overrides: Record<string, SimulationMock[]>;
  tests: SimulationDefinition[];
};
export type AttachedSimulationTool = { id: string; name: string };

export function loadSimulationSuite(): SimulationSuite {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../coaching/elevenlabs-simulations.json", import.meta.url)), "utf8"),
  ) as SimulationSuite;
}

const rejectedCall: SimulationMock = {
  parameter_conditions: [],
  mock_result: JSON.stringify({
    ok: false,
    error: {
      code: "UNEXPECTED_SIMULATION_TOOL",
      message: "No matching fixture permits this call. No real tool was called.",
      retryable: false,
    },
  }),
  is_error: true,
};

/** Pure local conversion. No provider API, credentials, network, or booking calls. */
export function materializeSimulations(suite: SimulationSuite, attachedTools: AttachedSimulationTool[]) {
  if (suite.format_version !== 1 || !suite.fixture.synthetic)
    throw new Error("Only the versioned synthetic fixture suite is allowed");
  const byName = new Map<string, string>();
  const ids = new Set<string>();
  for (const tool of attachedTools) {
    if (
      typeof tool.name !== "string" ||
      typeof tool.id !== "string" ||
      !tool.name ||
      !tool.id ||
      byName.has(tool.name) ||
      ids.has(tool.id)
    ) {
      throw new Error("Attached tools must have unique, non-empty names and IDs");
    }
    byName.set(tool.name, tool.id);
    ids.add(tool.id);
  }
  // An incomplete map can hide schema drift. Check all 44 server + 12 client contracts, not only tools used by a case.
  const requiredNames = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)];
  for (const name of requiredNames) {
    if (!byName.has(name)) throw new Error(`Missing attached tool: ${name}`);
    if (!suite.common_tool_mock_overrides[name]) throw new Error(`Missing common mock: ${name}`);
  }
  const names = new Set<string>();
  return suite.tests.map((test) => {
    if (names.has(test.id)) throw new Error(`Duplicate simulation ID: ${test.id}`);
    names.add(test.id);
    if (
      test.type !== "simulation" ||
      test.tool_mock_config.mocking_strategy !== "all" ||
      test.tool_mock_config.fallback_strategy !== "raise_error"
    ) {
      throw new Error(`Unsafe mock configuration: ${test.id}`);
    }
    if (
      test.simulation_max_turns < 2 ||
      test.simulation_max_turns > 5 ||
      test.success_conditions.length < 2 ||
      test.success_conditions.length > 30
    ) {
      throw new Error(`Invalid simulation bounds: ${test.id}`);
    }
    const namedOverrides = { ...suite.common_tool_mock_overrides, ...test.tool_mock_overrides };
    for (const name of Object.keys(namedOverrides)) {
      if (!byName.has(name)) throw new Error(`Mock refers to an unattached tool: ${name}`);
    }
    const overrides: Record<string, SimulationMock[]> = {};
    for (const [name, id] of byName) {
      const mocks = namedOverrides[name] ?? [];
      for (const mock of mocks) {
        JSON.parse(mock.mock_result);
        if (!Array.isArray(mock.parameter_conditions) || typeof mock.is_error !== "boolean") {
          throw new Error(`Malformed mock: ${test.id}/${name}`);
        }
      }
      // A catch-all error comes before any shared provider mocks, so an unmatched parameter cannot accidentally use one.
      overrides[id] = [
        ...mocks,
        ...(mocks.some((mock) => mock.parameter_conditions.length === 0) ? [] : [rejectedCall]),
      ];
    }
    const { id, scenario_group, ...body } = test;
    return {
      id,
      scenario_group,
      body: {
        ...body,
        tool_mock_config: {
          mocking_strategy: "all" as const,
          fallback_strategy: "raise_error" as const,
          mocked_tool_ids: [...ids],
        },
        tool_mock_overrides: overrides,
      },
    };
  });
}
