import { type SimulationMock, type SimulationSuite, rejectUnexpectedFilters } from "./simulations.js";
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
    redemptionInput: {
      userSessionId: orderId,
      balanceType: "VOX_CREDIT",
      amountCents: 12000,
      confirmationId: "fixture_balance_split",
      confirmed: true,
    },
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
  const review = {
    ok: true,
    confirmationId: "fixture_balance_review",
    summary: { userSessionId: orderId, method: "CARD", amountCents: 2550, balancePayment, order },
    sheet: { requiresSheet: true, guest: false, customerKnown: true, fnbOnly: false },
  };
  const paymentUi = {
    type: "payment",
    title: "Review & Pay",
    items: [{ ...order, method: "CARD" }],
    meta: {
      confirmationId: review.confirmationId,
      userSessionId: orderId,
      method: "CARD",
      amountCents: 2550,
      balancePayment,
      requiresSheet: true,
    },
  };
  const success = (
    data: unknown,
    conditions: Record<string, string | number | boolean>,
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
  const suite: SimulationSuite = {
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
            "The guest chose VOX_CREDIT. A short yes approves that exact split/review only, never SHARE_POINTS. Redeem using the full returned redemptionInput, including balanceType VOX_CREDIT, amountCents12000, confirmationId and confirmed:true. The successful confirmed action reserves12000 and returns paymentReviewOpened:true with the actual CARD2550 payment UI; acknowledge that result without a redundant prepare call. A reservation-only result or unexecuted step cannot prove a review. No pay_order, new hold, charge or invented method/amount is allowed.",
            "If the actual guest instead rejects the card remainder or requests credit only, do not require a CARD review for a pass: stop at the returned insufficient-balance choice without claiming a review opened. A reservation is reserved/selected, not charged/deducted; Arabic خصم before successful payment is not a truthful reservation acknowledgement.",
            correcting
              ? "First remove the explicitly rejected SHARE reservation using the returned balanceType SHARE_POINTS, points0. Verify successful clearing before applying VOX credit. Do not retain/reuse SHARE in the new review; do not claim clearing if the tool failed."
              : "Do not call redeem_points with omitted balanceType, SHARE_POINTS, arbitrary points or a zero amount. The copied redemptionInput is the only authorized reservation.",
            `Reply briefly in the guest's actual language, intended ${language === "ar" ? "Arabic" : "English"}, mentioning only the verified credit/card amounts and review. When the guest says no payment, acknowledge and stop. No complete booking recap or second financial confirmation request after refusal.`,
          ],
          simulation_scenario:
            language === "ar"
              ? `Speak Arabic only. الحالة السابقة جاهزة. قولي أولاً بالنص: ${correcting ? "نعم، أزيلي نقاط شير وتابعي برصيد فوكس مع باقي المبلغ بالبطاقة؛ اعرضي المراجعة فقط ولا تدفعي." : "نعم، اعرضي مراجعة رصيد فوكس وباقي المبلغ بالبطاقة فقط، لا تدفعي."} ${correcting ? "إذا سألت عن توزيع رصيد فوكس والبطاقة وافقي على عرض المراجعة فقط." : ""} عندما تظهر المراجعة قولي: شكراً، لا تدفعي، هذا كل شيء. لا تختاري شير ولا تأذني بخصم أو حجز جديد. لا تغيّري موافقتك على مراجعة باقي المبلغ بالبطاقة إلى طلب رصيد فوكس وحده.`
              : `First say exactly '${correcting ? "Yes, remove SHARE and use VOX Credit with the remainder by card; show that review only, do not pay." : "Yes, show that VOX Credit plus card remainder review only; do not pay."}' ${correcting ? "If asked about the VOX Credit/card split, approve showing that review only." : ""} After the review say 'Thanks, do not pay; that is all.' Never select SHARE or authorize a charge or new booking. Do not paraphrase the approved card-remainder review as credit-only or no-card.`,
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
            ],
            redeem_points: [
              ...(correcting
                ? [
                    // Reset inputs carry no durable split proof. Reject invented extras before
                    // the broad zero-clear match, without blocking the confirmed VOX branch.
                    ...rejectUnexpectedFilters([], {
                      confirmationId: [],
                      confirmed: [],
                      amountCents: [],
                    }).map(
                      (mock): SimulationMock => ({
                        ...mock,
                        parameter_conditions: [
                          { path: "balanceType", eval: { type: "exact", expected_value: "SHARE_POINTS" } },
                          { path: "points", eval: { type: "exact", expected_value: "0" } },
                          ...mock.parameter_conditions,
                        ],
                      }),
                    ),
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
                  action: { actionId: "fixture_vox_reservation", type: "redeem_points", status: "succeeded" },
                  result: {
                    balanceType: "VOX_CREDIT",
                    cleared: false,
                    redeemed: { Type: "VOX_REWARDS", Amount: 12000 },
                    nextPaymentMethod: "CARD",
                    balancePayment,
                    order,
                    paymentReviewOpened: true,
                    review,
                  },
                },
                split.redemptionInput,
                paymentUi,
              ),
            ],
          },
        };
      }),
    ),
  };
  for (const language of ["en", "ar"] as const) {
    const refusal = structuredClone(suite.tests.find((test) => test.id === `balance-split-${language}`)!);
    refusal.id = `balance-decline-card-${language}`;
    refusal.name = `VOX balance credit-only no-card ${language}`;
    refusal.success_conditions = [
      "The verified VOX balance is insufficient for the basket. The latest user explicitly refuses any card remainder: preserve that refusal and explain the returned balance limitation briefly. Do not treat the earlier review request as consent to this refused split.",
      "Do not reserve/redeem a balance, clear anything, open a CARD/SAVED_CARD/SHARE review, change the basket, or pay. Do not claim a review or reservation was created. A review approval and an actual payment approval are separate; neither is supplied here.",
      `Answer in ${language === "ar" ? "Arabic" : "English"}. When the guest asks to leave the basket unchanged, acknowledge and stop without another sales or payment question.`,
    ];
    refusal.simulation_scenario =
      language === "ar"
        ? "تحدثي العربية فقط. بعد توزيع الرصيد والبطاقة المعروض قولي بالنص: لا، أريد رصيد فوكس فقط ولا أريد دفع أي مبلغ بالبطاقة. لا تحجزي أي رصيد ولا تفتحي مراجعة البطاقة، اتركي السلة كما هي. ثم: شكراً، لا تغيّري شيئاً. لا توافقي على البطاقة أو على حجز رصيد أو دفع."
        : "Speak English only. After the shown balance/card split say exactly: 'No, I want VOX Credit only and no card payment. Do not reserve any balance or open a card review; leave the basket unchanged.' Then 'Thanks, do not change anything.' Never accept a card remainder, reservation or payment.";
    refusal.simulation_max_turns = 2;
    refusal.tool_mock_overrides = {
      get_session_context: refusal.tool_mock_overrides.get_session_context!,
    };
    suite.tests.push(refusal);
  }
  return suite;
}
