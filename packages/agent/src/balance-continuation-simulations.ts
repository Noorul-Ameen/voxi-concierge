import type { SimulationMock, SimulationSuite } from "./simulations.js";
import { buildUiAcknowledgementSuite } from "./ui-acknowledgement-simulations.js";

/** Synthetic continuations of the captured AED145.50 basket/AED120 VOX balance.
 * All payments are denied. Only the specifically authorized mock reservation can change.
 */
export function buildBalanceContinuationSuite(clockLocal: string): SimulationSuite {
  const { fixture, common_tool_mock_overrides } = buildUiAcknowledgementSuite(clockLocal);
  const orderId = "fixture_balance_order";
  const split = {
    needs: "balance_split_confirmation",
    requestedMethod: "VOX_CREDIT",
    amountCents: 12000,
    remainingCents: 2550,
    totalCents: 14550,
    redemptionInput: { userSessionId: orderId, balanceType: "VOX_CREDIT", amountCents: 12000 },
    nextPaymentMethod: "CARD",
  };
  const balancePayment = {
    method: "VOX_CREDIT",
    amountCents: 12000,
    remainingCents: 2550,
    totalCents: 14550,
  };
  const order = {
    userSessionId: orderId,
    state: "seats_selected",
    totalCents: 2550,
    total: "AED 25.50",
    loyaltyRedeemedCents: 12000,
    offers: [{ id: "VOX_REWARDS", type: "loyalty_redeem", discountCents: 12000 }],
  };
  const success = (
    data: unknown,
    conditions: Record<string, string | number>,
    ui?: unknown,
  ): SimulationMock => ({
    parameter_conditions: Object.entries(conditions).map(([path, value]) => ({
      path,
      eval: { type: "exact", expected_value: String(value) },
    })),
    is_error: false,
    mock_result: JSON.stringify({ ok: true, data, ...(ui ? { ui } : {}) }),
  });
  const splitResult = {
    ok: false,
    error: {
      code: "CONFIRMATION_REQUIRED",
      message:
        "Your VOX Credit covers AED 120 of AED 145.50. Apply it and pay the remaining AED 25.50 by card?",
      retryable: false,
    },
    data: split,
  };
  return {
    format_version: 1,
    fixture,
    common_tool_mock_overrides,
    tests: (["split", "correct-share"] as const).flatMap((kind) =>
      (["en", "ar"] as const).map((language) => {
        const correcting = kind === "correct-share";
        const reset = {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "The current reservation uses SHARE Points. Remove it before preparing VOX Credit?",
            retryable: false,
          },
          data: {
            needs: "balance_reset_confirmation",
            requestedMethod: "VOX_CREDIT",
            redemptionInput: { userSessionId: orderId, balanceType: "SHARE_POINTS", points: 0 },
            nextPaymentMethod: "VOX_CREDIT",
          },
        };
        const prior = correcting ? reset : splitResult;
        const opening =
          language === "ar"
            ? "أريد الدفع برصيد فوكس، وليس نقاط شير. اعرض المراجعة فقط، لا تدفع."
            : "I want VOX Credit, not SHARE Points. Show a review only; do not pay.";
        const context = {
          ok: true,
          data: {
            language,
            localTime: clockLocal,
            isLoggedIn: true,
            customer: { id: "fixture_sara", firstName: "Sara", voxCreditCents: 12000, sharePoints: 2450 },
            activeOrder: {
              userSessionId: orderId,
              state: "seats_selected",
              summary: correcting
                ? {
                    ...order,
                    totalCents: 0,
                    total: "AED 0",
                    loyaltyRedeemedCents: 14550,
                    offers: [{ id: "SHARE_POINTS", type: "loyalty_redeem", discountCents: 14550 }],
                  }
                : { ...order, totalCents: 14550, total: "AED 145.50", loyaltyRedeemedCents: 0, offers: [] },
            },
          },
        };
        const toolHistory = (name: string, value: unknown, request: unknown, id: string) => [
          {
            role: "agent",
            time_in_call_secs: 0,
            tool_calls: [
              {
                type: "webhook",
                request_id: id,
                tool_name: name,
                params_as_json: JSON.stringify(request),
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
                request_id: id,
                tool_name: name,
                result_value: JSON.stringify(value),
                is_error: false,
                tool_has_been_called: true,
              },
            ],
          },
        ];
        return {
          id: `balance-${kind}-${language}`,
          scenario_group: "balance-method-continuation",
          type: "simulation" as const,
          name: `VOX balance ${kind} ${language}`,
          dynamic_variables: {
            customerId: "fixture_sara",
            memberId: "",
            firstName: "Sara",
            channel: "web",
            language,
            greetingEn: "Welcome back, Sara.",
            greetingAr: "أهلاً بعودتك سارة.",
          },
          chat_history: [
            { role: "user", message: opening, time_in_call_secs: 0, tool_calls: [], tool_results: [] },
            ...toolHistory("get_session_context", context, {}, "fixture_balance_context"),
            ...toolHistory(
              "prepare_payment",
              prior,
              { userSessionId: orderId, method: "VOX_CREDIT" },
              "fixture_balance_prepare",
            ),
            {
              role: "agent",
              message:
                language === "ar"
                  ? correcting
                    ? "يوجد حجز لنقاط شير. هل أزيله وأتابع برصيد فوكس؟"
                    : "رصيد فوكس يغطي 120 درهم، ويتبقى 25.50 درهم بالبطاقة. أعرض هذه المراجعة؟"
                  : correcting
                    ? "SHARE Points are currently reserved. Shall I remove that and continue with VOX Credit?"
                    : "VOX Credit covers AED 120, leaving AED 25.50 by card. Show that review?",
              time_in_call_secs: 1,
              tool_calls: [],
              tool_results: [],
            },
          ],
          success_conditions: [
            "The guest chose VOX_CREDIT. A short yes approves that exact split/review only, never SHARE_POINTS. Redeem with explicit balanceType VOX_CREDIT and amountCents12000, then prepare CARD for the returned2550 remainder. No pay_order, new hold, charge or invented method/amount is allowed.",
            correcting
              ? "First remove the explicitly rejected SHARE reservation using the returned balanceType SHARE_POINTS, points0. Verify successful clearing before applying VOX credit. Do not retain/reuse SHARE in the new review; do not claim clearing if the tool failed."
              : "Do not call redeem_points with omitted balanceType, SHARE_POINTS, arbitrary points or a zero amount. The copied redemptionInput is the only authorized reservation.",
            `Reply briefly in the guest's actual language, intended ${language === "ar" ? "Arabic" : "English"}, mentioning only the verified credit/card amounts and review. When the guest says no payment, acknowledge and stop. No complete booking recap or second financial confirmation request after refusal.`,
          ],
          simulation_scenario:
            language === "ar"
              ? `Speak Arabic only. الحالة السابقة جاهزة. قولي أولاً بالنص: ${correcting ? "نعم، أزيلي نقاط شير وتابعي برصيد فوكس فقط؛ لا تدفعي." : "نعم، اعرضي مراجعة الدفع هذه فقط، لا تدفعي."} ${correcting ? "إذا سألت عن توزيع رصيد فوكس والبطاقة وافقي على عرض المراجعة فقط." : ""} عندما تظهر المراجعة قولي: شكراً، لا تدفعي، هذا كل شيء. لا تختاري شير ولا تأذني بخصم أو حجز جديد.`
              : `First say exactly '${correcting ? "Yes, remove SHARE and continue with VOX Credit only; do not pay." : "Yes, show me that payment review only; do not pay."}' ${correcting ? "If asked about the VOX Credit/card split, approve showing that review only." : ""} After the review say 'Thanks, do not pay; that is all.' Never select SHARE or authorize a charge or new booking.`,
          simulation_max_turns: 5,
          tool_mock_config: {
            mocking_strategy: "all" as const,
            fallback_strategy: "raise_error" as const,
            mocked_tool_ids: [],
          },
          tool_mock_overrides: {
            get_session_context: [success(context.data, {})],
            prepare_payment: [
              {
                ...success({}, { userSessionId: orderId, method: "VOX_CREDIT" }),
                mock_result: JSON.stringify(splitResult),
              },
              success(
                {
                  confirmationId: "fixture_balance_review",
                  summary: {
                    userSessionId: orderId,
                    method: "CARD",
                    amountCents: 2550,
                    balancePayment,
                    order,
                  },
                  balancePayment,
                },
                { userSessionId: orderId, method: "CARD" },
                {
                  type: "payment",
                  title: "Review & Pay",
                  items: [order],
                  meta: { confirmationId: "fixture_balance_review", balancePayment },
                },
              ),
            ],
            redeem_points: [
              ...(correcting
                ? [
                    success(
                      {
                        action: { actionId: "fixture_clear_share", status: "succeeded" },
                        result: {
                          balanceType: "SHARE_POINTS",
                          cleared: true,
                          nextPaymentMethod: null,
                          order: {
                            ...order,
                            totalCents: 14550,
                            total: "AED 145.50",
                            loyaltyRedeemedCents: 0,
                            offers: [],
                          },
                        },
                      },
                      { userSessionId: orderId, balanceType: "SHARE_POINTS", points: 0 },
                    ),
                  ]
                : []),
              success(
                {
                  action: { actionId: "fixture_vox_reservation", status: "succeeded" },
                  result: {
                    balanceType: "VOX_CREDIT",
                    cleared: false,
                    redeemed: { Type: "VOX_REWARDS", Amount: 12000 },
                    nextPaymentMethod: "CARD",
                    balancePayment,
                    order,
                  },
                },
                { userSessionId: orderId, balanceType: "VOX_CREDIT", amountCents: 12000 },
              ),
            ],
          },
        };
      }),
    ),
  };
}
