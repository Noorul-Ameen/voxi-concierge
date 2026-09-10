import { CLIENT_TOOLS, TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import { buildWebhookTools } from "./index.js";

type Call = {
  name?: string;
  arguments?: unknown;
  tool_name?: string;
  params_as_json?: unknown;
  tool_has_been_called?: boolean;
};
type ToolResult = {
  name?: string;
  tool_name?: string;
  value?: unknown;
  result?: unknown;
  result_value?: unknown;
  is_error?: boolean;
  is_blocked?: boolean;
  tool_has_been_called?: boolean;
};
const recommendationFilters = [
  "date",
  "time",
  "timeFrom",
  "timeTo",
  "language",
  "filmLanguage",
  "cinemaId",
  "cinemaName",
  "withChildren",
] as const;
type RecommendationFilter = (typeof recommendationFilters)[number];
type FilterValue = string | boolean;
type FilterAllowlist = Partial<Record<RecommendationFilter, readonly FilterValue[]>>;
type EvidenceTurn = {
  role?: string;
  message?: string | null;
  session_epoch?: number;
  calls?: Call[];
  results?: ToolResult[];
  tool_calls?: Call[];
  tool_results?: ToolResult[];
};
export type SimulationEvidence = {
  name: string;
  dynamic_variables?: Record<string, unknown>;
  transcript: EvidenceTurn[];
  /** Independently reviewed test expectations, never copied from agent arguments or tool results.
   * A new user turn needs its own complete expectation; later/negated requests cannot authorize an earlier call.
   * These optional annotations extend the fixed scenarios without pretending to parse arbitrary intent.
   */
  recommendation_filter_expectations?: {
    source_turn: number;
    user_message: string;
    session_epoch?: number;
    filters: Partial<Record<RecommendationFilter, FilterValue>>;
  }[];
};

const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, " ")
    .trim();
// These permissions come from the reviewed fixture requests, not from inferred profile/tool output.
const today = ["2030-06-03", "today", "tonight"];
const explicitRecommendationRequests: Record<
  string,
  { message: string | string[]; filters: FilterAllowlist }
> = {
  "01": { message: "Suggest me a movie.", filters: { date: today } },
  "02": {
    message: "Anything good today between 4 and 6 pm?",
    filters: { date: today, timeFrom: ["16:00"], timeTo: ["18:00"] },
  },
  "03": { message: "Show me an English movie for tonight.", filters: { date: today, language: ["English"] } },
  "04": {
    message: "Anything at City Centre Mirdif tonight?",
    filters: { date: today, cinemaName: ["City Centre Mirdif", "Mirdif"], cinemaId: ["0003"] },
  },
  "05": { message: "Anything around 10 pm tonight?", filters: { date: today, time: ["22:00"] } },
  "11": {
    message: [
      "Suggest something for Monday 3 June 2030.",
      "Uh hey, can you suggest something for Monday 3 June 2030?",
      "Uh hey, yeah — can you suggest something for Monday 3 June 2030?",
    ],
    filters: { date: ["2030-06-03", "monday", "today"] },
  },
  "12": {
    message: "Suggest something for Saturday 8 June 2030.",
    filters: { date: ["2030-06-08", "saturday"] },
  },
  "13a": { message: "Suggest a movie for tonight, please.", filters: { date: today } },
  "13b": { message: "اقترحي لي فيلم الليلة لو سمحتِ", filters: { date: today } },
};
const recommendationScenarios = new Set(["01", "02", "03", "04", "05", "11", "12", "13a", "13b"]);

function auditRecommendationFilters(
  test: SimulationEvidence,
  index: number,
  args: Record<string, unknown>,
): string[] {
  const scenario = /\bEnhancement (\d{2}[ab]?)\b/.exec(test.name)?.[1];
  if (!recommendationScenarios.has(scenario ?? "") && !test.recommendation_filter_expectations) return [];
  const epoch = test.transcript.slice(0, index + 1).reduce((value, turn) => turn.session_epoch ?? value, 0);
  let source = -1;
  let currentEpoch = 0;
  for (let turnIndex = 0; turnIndex < index; turnIndex += 1) {
    const turn = test.transcript[turnIndex]!;
    if (turn.session_epoch !== undefined && turn.session_epoch !== currentEpoch) source = -1;
    currentEpoch = turn.session_epoch ?? currentEpoch;
    if (turn.role === "user" && typeof turn.message === "string" && turn.message.trim()) source = turnIndex;
  }
  if (source < 0 || currentEpoch !== epoch)
    return [`Turn ${index}: recommendation has no preceding user request in the current session.`];
  const request = test.transcript[source]!;
  let allowed: FilterAllowlist = {};
  const explicit = explicitRecommendationRequests[scenario ?? ""];
  if (
    explicit &&
    [explicit.message].flat().some((message) => normalise(request.message!) === normalise(message))
  )
    allowed = explicit.filters;
  const annotation = test.recommendation_filter_expectations?.find(
    (expected) =>
      expected.source_turn === source &&
      (expected.session_epoch ?? 0) === epoch &&
      normalise(expected.user_message) === normalise(request.message!),
  );
  if (annotation) {
    // Complete expected overrides replace the fixture permissions, including revoking an earlier clock.
    allowed = Object.fromEntries(
      Object.entries(annotation.filters).map(([field, value]) => [field, [value]]),
    );
  }
  return recommendationFilters.flatMap((field) => {
    if (args[field] === undefined) return [];
    const values =
      allowed[field] ??
      (field === "filmLanguage"
        ? allowed.language
        : field === "language"
          ? allowed.filmLanguage
          : undefined) ??
      [];
    const grounded = values.some((value) =>
      typeof value === "string" && typeof args[field] === "string"
        ? normalise(value) === normalise(args[field])
        : value === args[field],
    );
    return grounded
      ? []
      : [
          `Turn ${index}: get_recommendations.${field}=${JSON.stringify(args[field])} has no matching preceding explicit guest request; omit unrequested filters and let backend history rank results.`,
        ];
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function callEvidence(raw: Call, index: number, findings: string[]) {
  const name = raw?.name ?? raw?.tool_name;
  if (typeof name !== "string" || !name.trim() || (raw.name && raw.tool_name && raw.name !== raw.tool_name)) {
    findings.push(`Turn ${index}: missing or inconsistent tool-call name; evidence cannot be audited.`);
    return null;
  }
  if (raw.tool_has_been_called === false) {
    findings.push(`Turn ${index}: ${name} was not executed; a planned call is not tool evidence.`);
    return null;
  }
  let args: unknown = raw.arguments;
  if (args === undefined && raw.tool_name !== undefined) {
    if (typeof raw.params_as_json !== "string") {
      findings.push(`Turn ${index}: ${name} raw call has no inspectable params_as_json.`);
      return null;
    }
    try {
      args = JSON.parse(raw.params_as_json);
    } catch {
      findings.push(`Turn ${index}: ${name} call arguments are malformed JSON.`);
      return null;
    }
  }
  if (args === undefined) args = {};
  if (!record(args)) {
    findings.push(`Turn ${index}: ${name} call arguments are not an object.`);
    return null;
  }
  return { name, arguments: args };
}

function resultEvidence(raw: ToolResult, index: number, findings: string[]) {
  const name = raw?.name ?? raw?.tool_name;
  if (typeof name !== "string" || !name.trim() || (raw.name && raw.tool_name && raw.name !== raw.tool_name)) {
    findings.push(`Turn ${index}: missing or inconsistent tool-result name; evidence cannot be audited.`);
    return null;
  }
  let value = raw.value ?? raw.result ?? raw.result_value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      findings.push(`Turn ${index}: ${name} result could not be inspected as structured evidence.`);
      return null;
    }
  }
  if (!record(value)) {
    findings.push(`Turn ${index}: ${name} result has no structured object evidence.`);
    return null;
  }
  if (
    raw.is_blocked === true ||
    raw.tool_has_been_called === false ||
    (raw.is_error === true && value.ok === true)
  ) {
    findings.push(
      `Turn ${index}: ${name} result was blocked, unexecuted or contradicts its error flag; it cannot establish success.`,
    );
    return null;
  }
  return { name, value, is_error: raw.is_error };
}

function returnedCardBins(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(returnedCardBins);
  if (!record(value)) return [];
  return Object.entries(value).flatMap(([field, item]) =>
    ["cardBin", "first6"].includes(field) && typeof item === "string" && /^\d{6,8}$/.test(item)
      ? [item]
      : returnedCardBins(item),
  );
}

// Only an unambiguous full declaration supplies a BIN. Never mine digits from a bank, last4, question or negation.
function declaredCardBin(message: string): string | undefined {
  return /^(?:(?:my )?(?:card )?bin(?: is|:)|my card prefix is|the first (?:six|6) digits of my card are)\s*(\d{6,8})[.!]?$/i.exec(
    message.trim(),
  )?.[1];
}

// Reviewed pause/closing phrases plus the provider's synthetic silence marker; not a free-form intent parser.
const pauseRequests = new Set(
  [
    "Give me a moment",
    "Give me a second",
    "One moment please",
    "Let me think",
    "Please wait",
    "Wait a moment",
    "Pause please",
    "Please pause",
    "Thanks",
    "Thank you",
    "That's all",
    "That is all",
    "Thanks, that is all",
    "Thanks, that's all",
    "Thanks, that is enough",
    "Thanks, that's enough",
    "That is enough, thanks",
    "Leave it there",
    "Leave it as it is",
    "Thanks, leave it as it is",
    "I have not pressed Pay yet; leave it there",
    "Do not pay yet",
    "No payment yet",
    "No snacks, and do not pay yet",
    "Keep that, but do not pay",
    "Leave the two-ticket basket unchanged; do not apply anything",
    "Thanks, I will decide later",
    "Thanks, I'll decide later",
    "Thanks, I will think about it",
    "Thanks, I'll think about it",
    "لحظة",
    "انتظر لحظة",
    "خلني أفكر",
    "دعني أفكر",
    "شكراً",
    "شكراً، هذا كل شيء",
    "شكراً، هذا كل شي",
    "خلاص شكراً",
    "هذا كل شيء، شكراً",
    "لا شيء آخر، شكراً",
    "سأقرر لاحقاً",
  ].map(normalise),
);

function pauseWasRequested(test: SimulationEvidence, index: number): boolean {
  let allowed = false;
  let epoch = 0;
  for (let source = 0; source <= index; source += 1) {
    const turn = test.transcript[source]!;
    if (turn.session_epoch !== undefined && turn.session_epoch !== epoch) allowed = false;
    epoch = turn.session_epoch ?? epoch;
    if (source < index && turn.role === "user" && typeof turn.message === "string")
      allowed = /^(?:\.{3}|…)\s*$/.test(turn.message.trim()) || pauseRequests.has(normalise(turn.message));
  }
  return allowed;
}

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
  const knownBins = new Set<string>();
  let sessionEpoch = 0;
  for (const [index, turn] of test.transcript.entries()) {
    if (turn.session_epoch !== undefined && turn.session_epoch !== sessionEpoch) knownBins.clear();
    sessionEpoch = turn.session_epoch ?? sessionEpoch;
    for (const rawCall of turn.calls ?? turn.tool_calls ?? []) {
      const call = callEvidence(rawCall, index, findings);
      if (!call) continue;
      const args = call.arguments;
      if (call.name === "skip_turn") {
        if (
          Object.keys(args).some((key) => key !== "reason") ||
          (args.reason !== undefined && typeof args.reason !== "string")
        )
          findings.push(`Turn ${index}: skip_turn accepts only an optional string reason.`);
        if (!pauseWasRequested(test, index))
          findings.push(
            `Turn ${index}: skip_turn has no preceding explicit pause, closing request or synthetic silence in the current session.`,
          );
        continue; // Native waiting is never proof that any required backend or client action ran.
      }
      if (!Object.hasOwn(TOOL_REGISTRY, call.name) && !Object.hasOwn(CLIENT_TOOLS, call.name)) {
        findings.push(
          `Turn ${index}: unrecognized tool ${call.name}; only skip_turn is an allowed native control.`,
        );
        continue;
      }
      callCount += 1;
      if (call.name === "get_recommendations")
        findings.push(...auditRecommendationFilters(test, index, args));
      if (args.cardBin !== undefined && (typeof args.cardBin !== "string" || !knownBins.has(args.cardBin)))
        findings.push(
          `Turn ${index}: ${call.name}.cardBin has no preceding explicit guest declaration or successful card-data result; never infer a BIN from a bank, brand or last four digits.`,
        );
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
    for (const rawResult of turn.results ?? turn.tool_results ?? []) {
      if ((rawResult?.name ?? rawResult?.tool_name) === "skip_turn") {
        if (
          (rawResult.name && rawResult.tool_name && rawResult.name !== rawResult.tool_name) ||
          rawResult.is_error ||
          rawResult.is_blocked ||
          rawResult.tool_has_been_called === false
        )
          findings.push(
            `Turn ${index}: skip_turn returned inconsistent, failed or blocked control evidence.`,
          );
        continue; // Native control acknowledgements are not webhook data and establish no booking facts.
      }
      const result = resultEvidence(rawResult, index, findings);
      if (!result) continue;
      const value = result.value as
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
      if (
        value?.ok === true &&
        result.is_error !== true &&
        [
          "get_session_context",
          "get_loyalty_balance",
          "prepare_payment",
          "list_offers",
          "check_offer_eligibility",
        ].includes(result.name)
      )
        for (const bin of returnedCardBins(value.data)) knownBins.add(bin);
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
    if (turn.role === "user" && typeof turn.message === "string") {
      const bin = declaredCardBin(turn.message);
      if (bin) knownBins.add(bin);
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
