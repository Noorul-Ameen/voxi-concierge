import type { SimulationMock, SimulationSuite } from "./simulations.js";
import { buildUiAcknowledgementSuite } from "./ui-acknowledgement-simulations.js";

/** Reference-less lookup of confirmed bookings, independent of an active checkout.
 * All booking records are synthetic; dates follow the supplied Dubai clock.
 * Only context and owned-booking reads succeed. No change is authorized.
 */
export function buildConfirmedBookingSuite(clockLocal: string): SimulationSuite {
  const { fixture, common_tool_mock_overrides } = buildUiAcknowledgementSuite(clockLocal);
  const localClock = clockLocal.replace(/\+04:00$/, "");
  const date = new Date(`${localClock}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== localClock)
    throw new Error("Supply a valid current Dubai local clock");
  const futureDate = (days: number) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
  };
  const success = (result: unknown): SimulationMock[] => [
    { parameter_conditions: [], is_error: false, mock_result: JSON.stringify(result) },
  ];

  return {
    format_version: 1,
    fixture,
    common_tool_mock_overrides,
    tests: (["en", "ar"] as const).map((language) => {
      const arabic = language === "ar";
      const bookings = [
        {
          bookingId: "FIXRAH1",
          filmTitle: arabic ? "مغامرة تجريبية" : "Fixture Adventure",
          cinemaId: "fixture_burjuman",
          cinemaName: arabic ? "برجمان" : "Burjuman",
          showtime: `${futureDate(1)}T20:00:00+04:00`,
          showtimeLabel: arabic ? "غداً الساعة 8 مساءً" : "tomorrow at 8 PM",
          seats: "G8, G9",
          ticketCount: 2,
          totalCents: 12000,
          total: arabic ? "120 درهم" : "AED 120.00",
        },
        {
          bookingId: "FIXRAH2",
          filmTitle: arabic ? "كوميديا تجريبية" : "Fixture Comedy",
          cinemaId: "fixture_deira",
          cinemaName: arabic ? "سيتي سنتر ديرة" : "City Centre Deira",
          showtime: `${futureDate(2)}T18:25:00+04:00`,
          showtimeLabel: `${futureDate(2)} 18:25`,
          seats: "F7",
          ticketCount: 1,
          totalCents: 6000,
          total: arabic ? "60 درهم" : "AED 60.00",
        },
      ].map((booking) => ({
        ...booking,
        status: "confirmed",
        verified: true,
        experience: "Standard",
        rating: "PG",
        concessions: [],
        refundedCents: 0,
        collected: false,
        offers: [],
        refunds: [],
      }));
      const context = {
        ok: true,
        data: {
          language,
          localTime: clockLocal,
          isLoggedIn: true,
          customer: { id: "fixture_rahul", firstName: "Rahul" },
          activeOrder: null,
          mode: "bot",
        },
      };
      const contextJson = JSON.stringify(context);
      const opening = arabic
        ? "أود إجراء تغييرات على حجزي الحالي."
        : "I would like to make changes to my current booking.";
      const closing = arabic
        ? "اترك كل الحجوزات كما هي الآن، سأختار لاحقاً."
        : "Please leave all bookings unchanged for now; I will choose later.";
      return {
        id: `confirmed-booking-${language}`,
        scenario_group: "confirmed-booking-without-reference",
        type: "simulation" as const,
        name: `VOX confirmed booking Rahul no reference ${language}`,
        dynamic_variables: {
          customerId: "fixture_rahul",
          memberId: "",
          firstName: "Rahul",
          channel: "web",
          language,
          greetingEn: "Welcome back, Rahul.",
          greetingAr: "أهلاً بعودتك راهول.",
        },
        chat_history: [
          {
            role: "agent",
            time_in_call_secs: 0,
            tool_calls: [
              {
                type: "webhook",
                request_id: "fixture_confirmed_context",
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
                request_id: "fixture_confirmed_context",
                tool_name: "get_session_context",
                result_value: contextJson,
                is_error: false,
                tool_has_been_called: true,
              },
            ],
          },
        ],
        success_conditions: [
          "For the initial reference-less request, call list_my_bookings for the authenticated Rahul account before asking for a booking reference, contact details, login or a target. activeOrder:null means no unfinished checkout; it does not mean there are no confirmed bookings. Do not require the user to explicitly ask to check their account a second time.",
          "Use the two verified confirmed bookings returned by list_my_bookings and its booking-card UI. Briefly ask which booking the customer means once; the movie/cinema/time or existing cards can distinguish them. Do not invent a third booking, choose one automatically, demand that the customer find a reference, or claim the paid tickets are unpaid or an expired hold. Repeating every reference, seat and price aloud is unnecessary; any stated detail must match the returned records.",
          "The customer never selects a target or authorizes any change. Do not call propose_booking, quick_book, recover_order, prepare_swap, swap_booking, prepare_cancellation, cancel_booking, prepare_payment, pay_order, order_fnb, add_concessions or any other change/refund/hold/payment tool. No change, cancellation, refund or new booking may be claimed, even after a tool error. A lookup does not complete a booking/change journey.",
          "After the customer says leave all bookings unchanged, acknowledge briefly and stop without another choice, snack, payment or recovery question. Do not log invented feedback or ratings. Preserve the confirmed bookings as they are; do not imply their validity depends on an unpaid seat-hold timer.",
          `Reply in ${arabic ? "Arabic" : "English"}, matching the customer's actual request. These are synthetic read-only tool results; no browser rendering or real booking mutation is certified by this simulation.`,
        ],
        simulation_scenario: `You are signed-in Rahul, with confirmed bookings but no active unfinished checkout. Speak only ${arabic ? "Arabic" : "English"}. First say exactly: "${opening}" Do not add an account-lookup instruction, booking reference, contact detail, movie, date or chosen booking to that first request. Once the assistant replies or shows choices, say exactly: "${closing}" Then stop. Do not select a booking, ask for a swap/cancellation, consent to any action or invent a reference. The two returned bookings are synthetic; their dates are derived from the supplied current Dubai clock ${clockLocal}.`,
        simulation_max_turns: 2,
        tool_mock_config: {
          mocking_strategy: "all" as const,
          fallback_strategy: "raise_error" as const,
          mocked_tool_ids: [],
        },
        tool_mock_overrides: {
          get_session_context: success(context),
          list_my_bookings: success({
            ok: true,
            data: { bookings },
            speech: arabic
              ? "وجدت حجزين في حسابك. أيهما تريد تعديله؟"
              : "I found two bookings in your account. Which one would you like to change?",
            ui: {
              type: "booking",
              title: arabic ? "حجوزاتك" : "Your bookings",
              items: bookings,
              actions: bookings.map((booking) => ({
                label: `${booking.filmTitle} · ${booking.showtimeLabel}`,
                value: `booking:${booking.bookingId}`,
              })),
            },
            journey: { name: "booking_lookup", status: "completed" },
          }),
        },
      };
    }),
  };
}
