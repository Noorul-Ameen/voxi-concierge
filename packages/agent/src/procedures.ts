import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";

export const PROCEDURE_DEFINITIONS = [
  {
    key: "booking",
    type: "free_form",
    name: "VOX · Discover and book",
    trigger:
      "The guest wants a movie recommendation, a new booking, or to edit/resume an unpaid proposal or order, including seats, snacks, saved-card offers and checkout. Excludes cancellation or exchange of a paid booking and reports of a debit with missing/uncertain booking confirmation.",
  },
  {
    key: "cancellation",
    type: "free_form",
    name: "VOX · Cancel and refund",
    trigger:
      "The guest asks to cancel or check refund eligibility for an identified existing booking. Excludes changing to another show and a reported debit for which no booking has been found; those use their own procedures.",
  },
  {
    key: "change-show",
    type: "free_form",
    name: "VOX · Change a booked show",
    trigger:
      "The guest wants to move an existing paid booking to another date or showtime. Excludes edits to an unpaid proposal/order, cancellation without a replacement show, and uncertain or missing payment confirmation.",
  },
  {
    key: "payment-investigation",
    type: "free_form",
    name: "VOX · Investigate a missing booking",
    trigger:
      "The guest reports a debit, pending/failed payment, or missing confirmation and cannot identify the corresponding booking. Also continue this investigation when a found booking is rejected as the wrong purchase. Excludes ordinary booking discovery, an identified cancellation request, or a known-booking date change.",
  },
  {
    key: "brief-acknowledgement",
    type: "deterministic",
    name: "VOX · Acknowledge visible details briefly",
    trigger:
      "The latest user turn only asks you to keep it brief because they can already see the details, without asking a substantive question or requesting any new action. Examples: 'Keep it brief; I can see the details' or 'باختصار، أنا شايفة التفاصيل'. Excludes a booking or payment request, approval, modification, cancellation, a question needing an answer, a request to pause or wait, and thanks alone. A mention of visible details is not evidence that a particular option or ticket quantity exists.",
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
