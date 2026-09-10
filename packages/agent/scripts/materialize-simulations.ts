/**
 * Local-only preparation:
 *   tsx packages/agent/scripts/materialize-simulations.ts attached-tools.json output.json
 * Input is the complete final attached tool inventory: [{id,name}, ...] or {name:id, ...}.
 * Output has a provider-ready body per test plus stable local IDs. Nothing is uploaded or run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildJourneySimulationSuite } from "../src/journey-simulations.js";
import {
  type AttachedSimulationTool,
  loadSimulationSuite,
  materializeSimulations,
} from "../src/simulations.js";

const [input, output, suiteName] = process.argv.slice(2);
if (!input || !output) throw new Error("Expected attached-tools.json and output.json paths");
const inventory: unknown = JSON.parse(readFileSync(input, "utf8"));
if (!inventory || typeof inventory !== "object")
  throw new Error("Tool inventory must be an array or name-to-ID object");
const tools = (
  Array.isArray(inventory) ? inventory : Object.entries(inventory).map(([name, id]) => ({ name, id }))
) as AttachedSimulationTool[];
if (suiteName && suiteName !== "journeys") throw new Error("Supported suite selector: journeys");
const suite = suiteName === "journeys" ? buildJourneySimulationSuite() : loadSimulationSuite();
const tests = materializeSimulations(suite, tools);
writeFileSync(
  output,
  `${JSON.stringify({ prepared_only: true, fixture: suite.fixture, scenario_groups: new Set(tests.map((test) => test.scenario_group)).size, tests }, null, 2)}\n`,
  {
    flag: "wx",
  },
);
console.log(`Prepared ${tests.length} simulations locally; no tests were uploaded or run.`);
