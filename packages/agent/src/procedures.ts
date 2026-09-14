import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";

export const PROCEDURE_DEFINITIONS: readonly {
  key: string;
  type: "free_form" | "deterministic";
  name: string;
  trigger: string;
}[] = [
  {
    key: "booking",
    type: "free_form",
    name: "VOX · Discover and book",
    trigger:
      "The latest message asks for a movie plan/recommendation, a new booking, or an unpaid proposal/order step, including changing only the film in a visible proposal, seats, snacks, saved-card offers and checkout. Enter this procedure even when the conversation began with parking, a movie rating or showtimes: a later 'I would like to watch a movie with my son tomorrow' starts booking preparation. Reuse verified choices; do not remain in the earlier information-only flow. Excludes pure factual enquiries, paid-booking cancellation/exchange and a debit with missing/uncertain booking confirmation.",
  },
  {
    key: "cancellation",
    type: "free_form",
    name: "VOX · Cancel and refund",
    trigger:
      "The guest asks to cancel or check refund eligibility for an existing/current booking, including when a signed-in guest has not supplied a reference. Identify it with their booking list first. Excludes changing to another show and a reported debit for which no booking has been found; those use their own procedures.",
  },
  {
    key: "change-show",
    type: "free_form",
    name: "VOX · Change a booked show",
    trigger:
      "The guest wants to change an existing/current confirmed booking, including 'make changes to my current booking' without a reference or target date yet. Identify their booking first: for one returned record ask if it is the intended booking, wait for that answer, then ask the still-missing desired change. Selecting the existing booking does not select a replacement date/time. Excludes unpaid proposal/order edits, cancellation without a replacement show, and uncertain or missing payment confirmation.",
  },
  {
    key: "payment-investigation",
    type: "free_form",
    name: "VOX · Investigate a missing booking",
    trigger:
      "The guest reports a debit or uncertain payment and cannot identify the corresponding booking, or rejects a found booking as the wrong purchase. Excludes a known paid booking whose receipt/QR failed to render, a known unpaid basket awaiting balance consent, ordinary discovery, cancellation and a booked-show change.",
  },
] as const;

export type ProcedureDraft = {
  name: string;
  type: "free_form" | "deterministic";
  trigger: string;
  content: string;
};
export type NamedToolId = { name: string; id: string };

/** Authoring references use names; only a complete, reviewed deployment map can produce provider IDs. */
export function loadProcedureSources() {
  return PROCEDURE_DEFINITIONS.map((definition) => ({
    ...definition,
    content: readFileSync(
      fileURLToPath(
        new URL(
          `../procedures/${definition.key}.${definition.type === "deterministic" ? "json" : "md"}`,
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  }));
}

export function procedureFallbackPrompt(): string {
  return loadProcedureSources()
    .filter((source) => source.type === "free_form")
    .map((source) => source.content.replace(/\[\[tool:([a-z_]+)\]\]/g, "$1"))
    .join("\n\n");
}

/** Pure conversion: no API calls and no tool definitions/credentials in the output. */
export function buildProcedures(
  tools: NamedToolId[],
): (ProcedureDraft & { key: string; referenced_tool_ids: string[] })[] {
  const names = new Map<string, string>();
  const ids = new Set<string>();
  for (const tool of tools) {
    if (!tool.name || !/^tool_[A-Za-z0-9_-]+$/.test(tool.id) || names.has(tool.name) || ids.has(tool.id))
      throw new Error("Procedure tools must have unique names and valid unique provider IDs");
    names.set(tool.name, tool.id);
    ids.add(tool.id);
  }
  const registered = new Set([...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)]);
  return loadProcedureSources().map(({ key, name, type, trigger, content: source }) => {
    const used = new Set<string>();
    const content = source.replace(/\[\[tool:([a-z_]+)\]\]/g, (_, toolName: string) => {
      const id = names.get(toolName);
      if (!registered.has(toolName) || !id) throw new Error(`Unresolved procedure tool: ${toolName}`);
      used.add(id);
      return `[tool id="${id}"]`;
    });
    if (content.includes("[[") || /\[tool id=/.test(source))
      throw new Error(`Unresolved or hard-coded provider reference in ${key}`);
    if (!trigger.trim() || content.length > 50000) throw new Error(`Invalid procedure: ${key}`);
    if (type === "deterministic") {
      const document = JSON.parse(content) as { steps?: unknown[] };
      if (!Array.isArray(document.steps) || document.steps.length === 0)
        throw new Error(`Structured procedure needs steps: ${key}`);
    }
    return { key, name, type, trigger, content, referenced_tool_ids: [...used] };
  });
}

/** Compare only authored fields; the provider can add defaults. Used for immutable tool revisions. */
export function matchesAuthored(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => matchesAuthored(actual[i], v))
    );
  return (
    !!actual &&
    typeof actual === "object" &&
    Object.entries(expected)
      .filter(([, value]) => value !== undefined)
      .every(([key, value]) => matchesAuthored((actual as Record<string, unknown>)[key], value))
  );
}

export function assertExpectedVersion(actual: string | undefined, expected: string): void {
  if (!expected || !actual || actual !== expected)
    throw new Error("Agent branch version changed or could not be verified; no publish is permitted");
}
