import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import type { SimulationDefinition, SimulationMock, SimulationSuite } from "./simulations.js";

const denied: SimulationMock = {
  parameter_conditions: [],
  is_error: true,
  mock_result: JSON.stringify({
    ok: false,
    error: {
      code: "UNEXPECTED_SIMULATION_TOOL",
      message: "No real action was called or authorized.",
      retryable: false,
    },
  }),
};

type Scenario = {
  key: string;
  persona: "Sara" | "Rahul" | "James" | "Layla";
  member: boolean;
  event: Record<string, unknown>;
  expected: string;
};
const scenarios: Scenario[] = [
  {
    key: "paid",
    persona: "Sara",
    member: true,
    event: {
      action: "payment.token",
      succeeded: true,
      pending: false,
      speech: "You're booked — reference FIXPAID. Your booking details and QR are on screen. Enjoy the show!",
      state: { receipt: { bookingId: "FIXPAID", paid: true, rendered: true } },
    },
    expected:
      "Acknowledge the verified paid result in one short sentence; point to the reference/QR already shown or give the exact FIXPAID reference. Do not repeat movie, cinema, time, seats, card or price, request another yes, call payment, offer snacks, claim email delivery or ask another question.",
  },
  {
    key: "reheld",
    persona: "Rahul",
    member: true,
    event: {
      action: "order.recover",
      succeeded: true,
      pending: false,
      speech: "Seats D8 and D9 were available and are held again. The displayed expiry applies.",
      state: {
        bookingState: {
          userSessionId: "fixture_order",
          selectedSeats: "D8, D9",
          requiresFreshHold: false,
          currentJourneyStage: "seats",
        },
      },
    },
    expected:
      "Briefly acknowledge the verified new hold. The explicit Recover-control approval is already complete; do not ask it again or call recovery/booking. Do not say paid/booked, extend the displayed expiry or recap unchanged booking details.",
  },
  {
    key: "failed",
    persona: "James",
    member: true,
    event: {
      action: "payment.token",
      succeeded: false,
      pending: false,
      speech: "Payment could not be completed. The order is still unpaid; no confirmed booking was returned.",
      state: {},
    },
    expected:
      "Briefly state the payment did not complete. Do not claim a booking, receipt, refund, bank decline cause or email. The guest does not authorize a retry or a new purchase; no financial action is allowed.",
  },
  {
    key: "selection",
    persona: "Layla",
    member: false,
    event: {
      action: "ui_selection",
      succeeded: false,
      pending: false,
      state: { selection: { kind: "payment_method", label: "Credit or debit card", status: "unsubmitted" } },
    },
    expected:
      "Acknowledge only the draft card-method selection. It is not a submitted Pay click, applied discount or completed purchase. Do not claim payment or booking success, ask for a saved card, invent member history or invoke a financial action.",
  },
  {
    key: "pending",
    persona: "Sara",
    member: true,
    event: {
      action: "payment.token",
      succeeded: false,
      pending: true,
      speech: "The payment result is still pending. No completed booking has been returned.",
      state: {},
    },
    expected:
      "Describe the result as pending, never paid or confirmed. No actionId was supplied, so do not invent one or call get_action_result; do not retry payment, create a replacement, claim a refund or promise a bank outcome.",
  },
];

/** Actual UI-result shapes, synthetic business data and no executable financial tool.
 * The caller supplies the current Dubai clock; this suite does not substitute a 2030 clock.
 * Greeting rotation and real catalogue availability need separate API/UI evidence.
 */
export function buildUiAcknowledgementSuite(clockLocal: string): SimulationSuite {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+04:00)?$/.test(clockLocal))
    throw new Error("Supply the current Dubai local clock explicitly");
  const common = Object.fromEntries(
    [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => [name, [denied]]),
  );
  const tests: SimulationDefinition[] = scenarios.flatMap((scenario) =>
    (["en", "ar"] as const).map((language) => {
      const customer = scenario.member
        ? {
            id: `fixture_${scenario.persona.toLowerCase()}`,
            firstName: scenario.persona,
            preferredLanguage: language === "en" ? "ar" : "en",
            savedCards: [],
          }
        : null;
      const context = JSON.stringify({
        ok: true,
        data: {
          language,
          localTime: clockLocal,
          isLoggedIn: scenario.member,
          customer,
          activeOrder: null,
          mode: "bot",
        },
      });
      const intro =
        language === "ar"
          ? "أرى تفاصيل الطلب على الشاشة؛ أريد تأكيداً قصيراً فقط، ولا أريد أي إجراء آخر."
          : "I can see the order details; just give a brief acknowledgement, and take no other action.";
      const widget = `[widget] User interface updates: ${JSON.stringify(scenario.event)}. Briefly acknowledge the latest meaningful choice once. Draft selections are not applied offers or completed purchases; successful API results are authoritative. Do not repeat completed actions with tools. Pending actions are not completed.`;
      return {
        id: `ui-${scenario.key}-${language}`,
        scenario_group: "verified-ui-acknowledgement",
        type: "simulation",
        name: `VOX UI ${scenario.key} ${scenario.persona} ${language}`,
        dynamic_variables: {
          customerId: customer?.id ?? "",
          memberId: "",
          firstName: customer?.firstName ?? "",
          channel: "web",
          language,
          greetingEn: scenario.member ? `Welcome back, ${scenario.persona}.` : "Welcome to VOX Cinemas.",
          greetingAr: scenario.member ? `أهلاً بعودتك ${scenario.persona}.` : "أهلاً بك في فوكس سينما.",
        },
        chat_history: [
          { role: "user", time_in_call_secs: 0, message: intro, tool_calls: [], tool_results: [] },
          {
            role: "agent",
            time_in_call_secs: 0,
            tool_calls: [
              {
                type: "webhook",
                request_id: "fixture_context",
                tool_name: "get_session_context",
                params_as_json: "{}",
                tool_has_been_called: true,
              },
            ],
            tool_results: [],
          },
          {
            role: "agent",
            time_in_call_secs: 0,
            tool_calls: [],
            tool_results: [
              {
                type: "webhook",
                request_id: "fixture_context",
                tool_name: "get_session_context",
                result_value: context,
                is_error: false,
                tool_has_been_called: true,
              },
            ],
          },
          { role: "user", time_in_call_secs: 1, message: widget, tool_calls: [], tool_results: [] },
        ],
        success_conditions: [
          scenario.expected,
          "The first reply to the already received verified widget event must acknowledge its actual status/choice briefly. A generic 'I will keep it brief' does not acknowledge a payment, hold or selection outcome. Do not wait for the guest to request the acknowledgement again.",
          `Reply in ${language === "ar" ? "Arabic" : "English"} from the substantive guest sentence, not the deliberately opposite profile preference or English machine event. Preserve every status and identifier. A brief polite acknowledgement after thanks is allowed; no follow-up question or extra business action.`,
          "Only the authored verified event supplies its specific outcome; passive/pending/failed events cannot establish success. No mock permits a real payment, cancellation, fresh hold, exchange or refund.",
        ],
        simulation_scenario: `The exact synthetic application event is already in the authored history; do not recreate or paraphrase its payload. Speak ONLY ${language === "ar" ? "Arabic" : "English"}. First say exactly ${language === "ar" ? "'أكّد لي نتيجة الإجراء الأخيرة باختصار فقط، ولا تفعل أي شيء آخر.'" : "'Please briefly acknowledge the latest interface result only; take no other action.'"} Then say only ${language === "ar" ? "'شكراً، هذا كل شيء.'" : "'Thanks, that is all.'"} and stop. Do not supply another action, status, actionId, click, consent or request. This tests an already received application result, not an unverified guest assertion.`,
        simulation_max_turns: 2,
        tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error", mocked_tool_ids: [] },
        tool_mock_overrides: {
          get_session_context: [{ parameter_conditions: [], is_error: false, mock_result: context }],
        },
      };
    }),
  );
  return {
    format_version: 1,
    fixture: { synthetic: true, clock_local: clockLocal, time_zone: "Asia/Dubai" },
    common_tool_mock_overrides: common,
    tests,
  };
}
