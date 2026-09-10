import { TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import { buildWebhookTools } from "./index.js";

type Call = { name: string; arguments?: Record<string, unknown> };
type ToolResult = { name: string; value?: unknown; result?: unknown; is_error?: boolean };
export type SimulationEvidence = {
  name: string;
  dynamic_variables?: Record<string, unknown>;
  transcript: { calls?: Call[]; results?: ToolResult[]; tool_calls?: Call[]; tool_results?: ToolResult[] }[];
};

// Read the actual generated bindings: a contract field can override a shared dynamic property.
// Never manufacture a clock, contact detail, ID or required action argument to make a trace pass.
const injectedBindings = new Map(
  buildWebhookTools({
    conciergeUrl: "https://fixture.invalid",
    toolSecretHeader: { secret_id: "fixture-not-used" },
  }).map((tool) => [
    tool.name,
    Object.entries(tool.api_schema.request_body_schema.properties).flatMap(([field, prop]) =>
      "dynamic_variable" in prop && typeof prop.dynamic_variable === "string"
        ? [[field, prop.dynamic_variable] as const]
        : [],
    ),
  ]),
);

function itemIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(itemIds);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object.itemId === "string" ? [object.itemId] : []),
    ...Object.values(object).flatMap(itemIds),
  ];
}

/** Deterministic checks supplement, rather than replace, conversation evaluation and human review. */
export function auditSimulationEvidence(test: SimulationEvidence): string[] {
  const findings: string[] = [];
  const menuIds = new Set<string>();
  const foodScenario = /\b06a\b/.test(test.name);
  const seatScenario = /\b08\b/.test(test.name);
  // This fixed spoken-text scenario ends with thanks and supplies no rating or resolution.
  const noFeedbackScenario = /\b13a\b/.test(test.name);
  let callCount = 0;
  let contextReceived = false;
  let mapReceived = false;
  let foodMutationSucceeded = false;
  const foodActions = new Set<string>();
  for (const [index, turn] of test.transcript.entries()) {
    for (const call of turn.calls ?? turn.tool_calls ?? []) {
      callCount += 1;
      const args = call.arguments ?? {};
      if (Object.hasOwn(TOOL_REGISTRY, call.name)) {
        const hydrated = { ...args };
        for (const [field, variable] of injectedBindings.get(call.name as ToolName) ?? []) {
          const value = test.dynamic_variables?.[variable];
          if (value !== undefined && !Object.hasOwn(hydrated, field)) hydrated[field] = value;
        }
        const parsed = TOOL_REGISTRY[call.name as ToolName].input.safeParse(hydrated);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; ");
          findings.push(`Turn ${index}: ${call.name} violates its server contract (${issues}).`);
        }
      }
      if (call.name === "prepare_payment" && args.customer !== undefined)
        findings.push(`Turn ${index}: authenticated payment supplied an unprovided customer object.`);
      if (call.name === "pay_order")
        findings.push(`Turn ${index}: payment attempted; none of these fixtures authorizes payment.`);
      if (noFeedbackScenario && call.name === "submit_feedback")
        findings.push(`Turn ${index}: feedback submitted without a guest-provided rating or resolution.`);
      if (seatScenario && call.name === "quick_book" && args.seatPreference !== undefined && !contextReceived)
        findings.push(`Turn ${index}: usual-seat booking proceeded without verified context.`);
      if (foodScenario && call.name === "prepare_payment" && !foodMutationSucceeded)
        findings.push(`Turn ${index}: payment preparation preceded a successful food mutation.`);
      if (foodScenario && ["order_fnb", "add_concessions"].includes(call.name)) {
        const items = args.items as { itemId?: unknown; quantity?: unknown }[] | undefined;
        if (
          !Array.isArray(items) ||
          items.length !== 1 ||
          items[0]?.itemId !== "FIX_POPCORN" ||
          items[0]?.quantity !== 1
        )
          findings.push(`Turn ${index}: food mutation did not contain exactly FIX_POPCORN quantity 1.`);
        if (
          Array.isArray(items) &&
          items.some((item) => typeof item.itemId !== "string" || !menuIds.has(item.itemId))
        )
          findings.push(`Turn ${index}: food ID was used before a matching menu/suggestion result.`);
        if (call.name === "add_concessions" && args.userSessionId !== "fixture_order")
          findings.push(`Turn ${index}: food mutation targeted a different order.`);
        if (call.name === "order_fnb" && args.bookingId !== undefined)
          findings.push(
            `Turn ${index}: food mutation supplied a completed-booking ID for the unpaid basket.`,
          );
        if (
          Array.isArray(items) &&
          items.some(
            (item) =>
              Array.isArray((item as { modifierIds?: unknown }).modifierIds) &&
              (item as { modifierIds: unknown[] }).modifierIds.length > 0,
          )
        )
          findings.push(`Turn ${index}: food mutation added modifiers the guest did not choose.`);
      }
    }
    for (const result of turn.results ?? turn.tool_results ?? []) {
      let raw = result.value ?? result.result;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          findings.push(
            `Turn ${index}: ${result.name} result could not be inspected as structured evidence.`,
          );
        }
      }
      const value = raw as
        | {
            ok?: boolean;
            error?: { code?: string };
            data?: {
              action?: { actionId?: string; type?: string; status?: string };
              result?: { ok?: boolean };
            };
          }
        | undefined;
      if (value?.error?.code === "UNEXPECTED_SIMULATION_TOOL")
        findings.push(`Turn ${index}: ${result.name} had no permitted mock.`);
      if (["suggest_fnb", "browse_menu"].includes(result.name) && value?.ok === true)
        for (const id of itemIds(value)) menuIds.add(id);
      if (result.name === "get_session_context" && value?.ok === true) contextReceived = true;
      if (["get_seat_plan", "render_seat_map"].includes(result.name) && value?.ok === true)
        mapReceived = true;
      if (
        ["add_concessions", "order_fnb"].includes(result.name) &&
        value?.ok === true &&
        itemIds(value).includes("FIX_POPCORN")
      )
        foodMutationSucceeded = true;
      if (result.name === "add_concessions" && value?.ok === true && value.data?.action?.actionId)
        foodActions.add(value.data.action.actionId);
      if (
        result.name === "get_action_result" &&
        value?.ok === true &&
        value.data?.action?.status === "succeeded" &&
        foodActions.has(value.data.action.actionId ?? "") &&
        value.data.result?.ok === true &&
        itemIds(value.data.result).includes("FIX_POPCORN")
      )
        foodMutationSucceeded = true;
    }
  }
  if (callCount === 0)
    findings.push("Missing tool-call evidence; an empty or message-only trace cannot pass this audit.");
  if (foodScenario && !foodMutationSucceeded)
    findings.push("No successful food mutation established the requested popcorn in the basket.");
  if (seatScenario && !mapReceived)
    findings.push("No successful seat-map tool result; a spoken display claim is insufficient.");
  return findings;
}
