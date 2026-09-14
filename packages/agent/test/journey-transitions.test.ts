import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { auditJourneyTransitionEvidence } from "../src/journey-transition-evidence.js";
import { buildJourneyTransitionSuite } from "../src/journey-transition-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

const suite = buildJourneyTransitionSuite("2026-12-31T23:55:00+04:00");
const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  id: name,
  name,
}));
const materialized = materializeSimulations(suite, tools);
const testFor = (key: string, language = "en") =>
  suite.tests.find((t) => t.id === `transition-${key}-${language}`)!;
function invoke(key: string, tool: string, args: Record<string, unknown>, language = "en") {
  const mocks = materialized.find((t) => t.id === testFor(key, language).id)!.body.tool_mock_overrides[tool]!;
  const match = mocks.find((m) =>
    m.parameter_conditions.every(({ path, eval: check }) => {
      if (args[path] === undefined) return false;
      return check.type === "exact"
        ? String(args[path]) === check.expected_value
        : new RegExp(check.pattern).test(String(args[path]));
    }),
  );
  expect(match, `${key}/${tool} needs a fail-closed final mock`).toBeDefined();
  return { error: match!.is_error, value: JSON.parse(match!.mock_result) };
}
const user = (message: string) => ({ role: "user", message });
const speech = (message: string) => ({ role: "agent", message });
let requestSequence = 0;
const requestIds = new Map<string, string>();
const call = (tool_name: string, args: object = {}) => {
  const request_id = `test_request_${++requestSequence}`;
  requestIds.set(tool_name, request_id);
  return { role: "agent", tool_calls: [{ request_id, tool_name, params_as_json: JSON.stringify(args) }] };
};
const result = (tool_name: string, value: unknown, flags = {}) => ({
  role: "agent",
  tool_results: [
    {
      tool_name,
      request_id: requestIds.get(tool_name),
      result_value: JSON.stringify(value),
      is_error: false,
      ...flags,
    },
  ],
});
type Turns = Parameters<typeof auditJourneyTransitionEvidence>[1];
const audit = (key: string, turns: Turns, language = "en") => {
  const t = testFor(key, language);
  return auditJourneyTransitionEvidence(t, [...(t.chat_history as Turns), ...turns]);
};
const offer = () => [
  user("Yes, apply that offer."),
  call("apply_offer", { offerId: "FIX_OFFER", userSessionId: "fixture_order" }),
  result(
    "apply_offer",
    invoke("offer-snacks", "apply_offer", { offerId: "FIX_OFFER", userSessionId: "fixture_order" }).value,
  ),
  call("get_action_result", { actionId: "fixture_offer_action" }),
  result(
    "get_action_result",
    invoke("offer-snacks", "get_action_result", { actionId: "fixture_offer_action" }).value,
  ),
];

describe("journey transition regressions", () => {
  it("materializes eighteen bilingual boundary cases with every external tool mocked and no fictitious active Procedure", () => {
    expect(suite.tests).toHaveLength(18);
    expect(new Set(suite.tests.map((t) => t.id)).size).toBe(18);
    for (const test of materialized) {
      expect(test.body.tool_mock_config).toEqual({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
        mocked_tool_ids: tools.map((t) => t.id),
      });
      expect(Object.keys(test.body.tool_mock_overrides)).toHaveLength(tools.length);
      expect(JSON.stringify(test.body.chat_history)).not.toMatch(
        /start_procedure|active.procedures|procedure_id/i,
      );
      for (const name of [
        "pay_order",
        "quick_book",
        "swap_booking",
        "cancel_booking",
        "transfer_to_agent",
        "order_fnb",
        "add_concessions",
      ])
        expect(test.body.tool_mock_overrides[name]!.every((m) => m.is_error)).toBe(true);
    }
  });

  it("authors coherent linked reads with schema-valid inputs and a live finite hold across the year boundary", () => {
    for (const test of suite.tests) {
      const requests = new Map<string, string>();
      for (const turn of test.chat_history as Array<any>) {
        for (const call of turn.tool_calls ?? []) {
          const tool = TOOL_REGISTRY[call.tool_name as keyof typeof TOOL_REGISTRY];
          expect(tool.input.safeParse(JSON.parse(call.params_as_json)).success).toBe(true);
          requests.set(call.request_id, call.tool_name);
        }
        for (const result of turn.tool_results ?? []) {
          expect(result.tool_name).toBe(requests.get(result.request_id));
          expect(JSON.parse(result.result_value).ok).toBe(true);
        }
      }
    }
    const history = testFor("offer-snacks").chat_history as Array<any>;
    const order = JSON.parse(history[1].tool_results[0].result_value).data.activeOrder;
    expect(order.expiresAtUtc).toBe("2026-12-31T20:10:00.000Z");
    expect(order.summary.showtime).toContain("2027-01-01");
    expect(order.summary.offers ?? []).toEqual([]);
    expect(order.summary.concessions).toEqual([]);
  });

  for (const language of ["en", "ar"]) {
    it(`${language}: requires a complete one-adult/one-child proposal and rejects the broad-query shortcuts`, () => {
      const args = { hoCode: "FIX_SPIDER", tickets: 1, childTickets: 1, date: "tomorrow" };
      expect(TOOL_REGISTRY.propose_booking.input.safeParse(args).success).toBe(true);
      expect(invoke("enquiry-plan", "propose_booking", args, language).value.data.proposal).toMatchObject({
        held: false,
        adultTickets: 1,
        childTickets: 1,
        ticketQuantity: 2,
        date: "2027-01-01",
        totalCents: 10850,
      });
      for (const changed of [
        { childTickets: 0 },
        { tickets: 2 },
        { hoCode: "ANOTHER_FILM" },
        { time: "23:00" },
        { sessionKey: "invented" },
      ])
        expect(invoke("enquiry-plan", "propose_booking", { ...args, ...changed }, language).error).toBe(true);
      expect(
        invoke("enquiry-plan", "search_sessions", { title: "Spider-Man", date: "tomorrow" }, language).error,
      ).toBe(true);
      expect(testFor("enquiry-plan", language).success_conditions.join(" ")).toContain(
        "FIRST spoken response",
      );
    });

    it(`${language}: leaves every post-identification and information-only backend call denied`, () => {
      for (const key of ["identify-booking", "offer-information"])
        for (const tool of [
          "prepare_swap",
          "search_sessions",
          "prepare_payment",
          "suggest_fnb",
          "apply_offer",
        ])
          expect(invoke(key, tool, {}, language).error).toBe(true);
    });

    it(`${language}: allows only exact queued-offer evidence and menu, without a static future food result`, () => {
      expect(
        invoke(
          "offer-snacks",
          "apply_offer",
          { offerId: "FIX_OFFER", userSessionId: "fixture_order" },
          language,
        ).error,
      ).toBe(false);
      expect(
        invoke("offer-snacks", "get_action_result", { actionId: "fixture_offer_action" }, language).value.data
          .action.status,
      ).toBe("succeeded");
      for (const actionId of ["fixture_food_action", "fixture_order", "unknown"])
        expect(invoke("offer-snacks", "get_action_result", { actionId }, language).error).toBe(true);
      expect(
        invoke("offer-snacks", "suggest_fnb", { cinemaId: "0001" }, language).value.data.items,
      ).toHaveLength(2);
      expect(invoke("offer-snacks", "suggest_fnb", { cinemaId: "0002" }, language).error).toBe(true);
      for (const tool of ["get_order", "order_fnb", "prepare_payment"])
        expect(invoke("offer-snacks", tool, { repeatUsual: true }, language).error).toBe(true);
    });

    it(`${language}: keeps conditional age separate from definitions and rejects guessed classifications/ages`, () => {
      expect(
        invoke("named-rating-age", "get_age_rules", { rating: "PG13", childAge: 7 }, language).value.data
          .allowed,
      ).toBe(true);
      expect(
        invoke("named-rating-age", "get_age_rules", { rating: "PG13" }, language).value.data.allowed,
      ).toBeNull();
      for (const bad of [
        { rating: "PG15", childAge: 7 },
        { rating: "PG13", childAge: 8 },
      ])
        expect(invoke("named-rating-age", "get_age_rules", bad, language).error).toBe(true);
      expect(
        invoke("rating-definition", "get_age_rules", { rating: "PG13", childAge: 7 }, language).error,
      ).toBe(true);
      expect(testFor("named-rating-age", language).simulation_max_turns).toBe(3);
    });
    it(`${language}: a film-only edit cannot silently discard the current proposal's time or experience`, () => {
      const args = {
        hoCode: "FIX_SPIDER",
        tickets: 1,
        childTickets: 1,
        cinemaId: "0002",
        date: "tomorrow",
        time: "18:45",
        experience: "Premier",
      };
      expect(invoke("film-only-edit", "propose_booking", args, language).value.data.proposal).toMatchObject({
        experience: "Premier",
        showtime: "2027-01-01T18:30:00+04:00",
        held: false,
        requested: { time: "18:45" },
      });
      for (const change of [
        { time: undefined },
        { experience: undefined },
        { time: "23:00", experience: "KIDS" },
        { childTickets: 0 },
      ])
        expect(invoke("film-only-edit", "propose_booking", { ...args, ...change }, language).error).toBe(
          true,
        );
    });
  }

  it("catches the actual offer-acknowledgement false pass even when a later user volunteers food", () => {
    const trace = [
      ...offer(),
      speech("The offer is applied. Your total is AED96."),
      user("My usual popcorn and cola, please."),
      call("suggest_fnb", {}),
      result("suggest_fnb", invoke("offer-snacks", "suggest_fnb", {}).value),
      speech("Would you like your usual?"),
    ];
    expect(audit("offer-snacks", trace)).toContainEqual(
      expect.stringContaining("later user prompts cannot supply"),
    );
  });

  it.each(["en", "ar"])(
    "%s: a separate one-booking scenario verifies identity without any preview",
    (language) => {
      const lookup = invoke("single-booking", "list_my_bookings", {}, language).value;
      expect(lookup.data.bookings).toHaveLength(1);
      expect(lookup.data.bookings[0].verified).toBe(true);
      expect(lookup.ui.items).toEqual(lookup.data.bookings);
      expect(testFor("single-booking", language).success_conditions.join(" ")).toContain(
        "Identity confirmation",
      );
      for (const tool of ["prepare_swap", "search_sessions", "swap_booking", "prepare_payment"])
        expect(invoke("single-booking", tool, {}, language).error).toBe(true);
      expect(
        invoke("single-booking", "list_my_bookings", { customerId: "someone_else" }, language).error,
      ).toBe(true);
      const trace = [
        user("I would like to make changes to my current booking."),
        call("list_my_bookings", {}),
        result("list_my_bookings", lookup),
        speech("Is this your intended booking?"),
        user("Yes, that is the booking."),
        speech("What would you like to change?"),
        user("Leave it unchanged."),
        speech("Understood."),
      ];
      expect(audit("single-booking", trace, language)).toEqual([]);
      expect(audit("single-booking", [trace[0]!, ...trace.slice(3)], language)).not.toEqual([]);
    },
  );

  it("accepts actual completion then proactive menu before speech, but rejects early/failed/unexecuted evidence", () => {
    const menu = [
      call("suggest_fnb", {}),
      result("suggest_fnb", invoke("offer-snacks", "suggest_fnb", {}).value),
    ];
    const correct = [
      ...offer(),
      ...menu,
      speech("Offer applied. Would you like your usual popcorn and cola?"),
      user("No snacks; stop here."),
      speech("Understood."),
    ];
    expect(audit("offer-snacks", correct)).toEqual([]);
    const early = [
      ...offer().slice(0, 3),
      ...menu,
      ...offer().slice(3),
      speech("Would you like your usual?"),
    ];
    expect(audit("offer-snacks", early)).not.toEqual([]);
    for (const flags of [{ is_error: true }, { is_blocked: true }, { tool_has_been_called: false }]) {
      const bad = [...correct];
      bad[4] = result(
        "get_action_result",
        invoke("offer-snacks", "get_action_result", { actionId: "fixture_offer_action" }).value,
        flags,
      );
      expect(audit("offer-snacks", bad)).not.toEqual([]);
    }
  });

  it("rejects the observed same-day preview after only identifying the existing booking", () => {
    expect(
      audit("identify-booking", [
        user("The one at City Centre Deira."),
        call("prepare_swap", { bookingId: "FIXRAH2", date: "today", time: "18:25" }),
        result("prepare_swap", { ok: true, data: { needs: "swap_change" } }),
        speech("What would you like to change?"),
      ]),
    ).toContainEqual(expect.stringContaining("prepare_swap is not authorized"));
    expect(
      audit("identify-booking", [
        user("The one at City Centre Deira."),
        speech("What would you like to change?"),
        user("Leave it unchanged."),
        speech("Understood."),
      ]),
    ).toEqual([]);
  });

  it("requires the actual Procedure and complete proposal before the first family-plan response", () => {
    const proposal = invoke("enquiry-plan", "propose_booking", {
      hoCode: "FIX_SPIDER",
      tickets: 1,
      childTickets: 1,
      date: "tomorrow",
    }).value;
    const entered = [
      call("start_procedure", { procedure_index: "2" }),
      result("start_procedure", {
        result_type: "start_procedure_success",
        status: "success",
        procedure_name: "VOX · Discover and book",
      }),
    ];
    const prepared = [
      call("propose_booking", { hoCode: "FIX_SPIDER", tickets: 1, childTickets: 1, date: "tomorrow" }),
      result("propose_booking", proposal),
    ];
    expect(
      audit("enquiry-plan", [
        user("I would like to watch a movie with my son tomorrow."),
        ...entered,
        ...prepared,
        speech("Here is the evening proposal."),
      ]),
    ).toEqual([]);
    expect(
      audit("enquiry-plan", [
        user("I would like to watch a movie with my son tomorrow."),
        call("search_sessions", { date: "tomorrow", title: "Spider-Man" }),
        speech("Which time?"),
        user("Show a proposal."),
        ...entered,
        ...prepared,
        speech("Here it is."),
      ]),
    ).toContainEqual(expect.stringContaining("Missing complete"));
    expect(
      audit("enquiry-plan", [
        user("I would like to watch a movie with my son tomorrow."),
        ...prepared,
        speech("Here is the evening proposal."),
      ]),
    ).toContainEqual(expect.stringContaining("Procedure was not entered"));
  });

  it("does not use a future or missing user age to authorize the current admission call", () => {
    const film = [
      call("get_film", { hoCode: "FIX_SPIDER" }),
      result("get_film", invoke("named-rating-age", "get_film", { hoCode: "FIX_SPIDER" }).value),
    ];
    const rule = [
      call("get_age_rules", { rating: "PG13", childAge: 7 }),
      result(
        "get_age_rules",
        invoke("named-rating-age", "get_age_rules", { rating: "PG13", childAge: 7 }).value,
      ),
    ];
    expect(
      audit("named-rating-age", [
        user("What is Spider-Man's age rating?"),
        ...film,
        speech("PG13. If this is for your child, how old are they?"),
        user("He is 7."),
        ...rule,
        speech("He may attend accompanied."),
      ]),
    ).toEqual([]);
    expect(
      audit("named-rating-age", [
        user("What is Spider-Man's age rating?"),
        ...film,
        ...rule,
        speech("How old?"),
        user("He is 7."),
        speech("Allowed."),
      ]),
    ).not.toEqual([]);
  });

  it("rejects a second user repairing the first response even before any agent speech", () => {
    const trace = [
      ...offer(),
      user("Please offer my usual snacks now."),
      call("suggest_fnb", {}),
      result("suggest_fnb", invoke("offer-snacks", "suggest_fnb", {}).value),
      speech("Would you like your usual?"),
    ];
    expect(audit("offer-snacks", trace)).toContainEqual(expect.stringContaining("later user prompts"));
  });

  it("rejects a mismatched provider request ID instead of counting a same-name success", () => {
    const trace = [
      ...offer(),
      call("suggest_fnb", {}),
      result("suggest_fnb", invoke("offer-snacks", "suggest_fnb", {}).value, { request_id: "other_request" }),
      speech("Would you like your usual?"),
    ];
    expect(audit("offer-snacks", trace)).toContainEqual(expect.stringContaining("matching request ID"));
  });

  it("requires the changed film's age check before proposal creation, not merely before speech", () => {
    const args = {
      hoCode: "FIX_SPIDER",
      tickets: 1,
      childTickets: 1,
      cinemaId: "0002",
      date: "tomorrow",
      time: "18:45",
      experience: "Premier",
    };
    const prefix = [
      user("Change only the movie to Spider-Man."),
      call("start_procedure", { procedure_index: "2" }),
      result("start_procedure", {
        result_type: "start_procedure_success",
        status: "success",
        procedure_name: "VOX · Discover and book",
      }),
      call("get_film", { hoCode: "FIX_SPIDER" }),
      result("get_film", invoke("film-only-edit", "get_film", { hoCode: "FIX_SPIDER" }).value),
    ];
    const age = [
      call("get_age_rules", { rating: "PG13", childAge: 7 }),
      result(
        "get_age_rules",
        invoke("film-only-edit", "get_age_rules", { rating: "PG13", childAge: 7 }).value,
      ),
    ];
    const proposal = [
      call("propose_booking", args),
      result("propose_booking", invoke("film-only-edit", "propose_booking", args).value),
    ];
    expect(
      audit("film-only-edit", [...prefix, ...age, ...proposal, speech("Premier at 18:30 is available.")]),
    ).toEqual([]);
    expect(
      audit("film-only-edit", [...prefix, ...proposal, ...age, speech("Premier at 18:30 is available.")]),
    ).toContainEqual(expect.stringContaining("verify the new film/age"));
  });

  it.each(["en", "ar"])(
    "%s: an omitted cheaper-swap refund method returns choices, never a default confirmation",
    (language) => {
      const input = {
        bookingId: "FIXRAH1",
        date: "2027-01-02",
        time: "20:00",
        experience: "Standard",
        keepSeatsIfPossible: true,
      };
      expect(TOOL_REGISTRY.prepare_swap.input.safeParse(input).success).toBe(true);
      const discovery = invoke("swap-refund-choice", "prepare_swap", input, language).value;
      const next = discovery.data.recommendedPreviewInput;
      expect(discovery.data).toMatchObject({
        needs: "swap_session",
        bookingId: input.bookingId,
        sameCinemaRequired: true,
        nextStep: "preview_recommended",
      });
      expect(discovery.data.sessions).toBeUndefined();
      expect(discovery.ui).toMatchObject({
        type: "showtimes",
        items: discovery.data.alternatives,
        meta: { journey: "swap", bookingId: input.bookingId },
      });
      const unselected = invoke("swap-refund-choice", "prepare_swap", next, language).value;
      expect(unselected.data).toMatchObject({
        needs: "swap_refund_method",
        bookingId: input.bookingId,
        targetSessionKey: next.targetSessionKey,
        summary: { refundCents: 750, chargeCents: 0, refundMethodSelected: false },
      });
      expect(unselected.data.confirmationId).toBeUndefined();
      expect(unselected.data.summary.refundMethod).toBeUndefined();
      expect(unselected.data.summary.refundEta).toBeUndefined();
      expect(unselected.ui).toMatchObject({
        type: "refund_options",
        actions: [],
        meta: { journey: "swap", targetSessionKey: next.targetSessionKey },
      });
      const selected = invoke(
        "swap-refund-choice",
        "prepare_swap",
        { ...next, refundMethodForDifference: "VOX_CREDIT" },
        language,
      ).value;
      expect(selected.data).toMatchObject({
        confirmationId: "FIX_SWAP_CONFIRMATION",
        summary: { refundMethodSelected: true, refundMethod: "VOX_CREDIT", refundCents: 750 },
      });
      expect(selected.ui.meta.confirmationId).toBe(selected.data.confirmationId);
      expect(selected.ui.actions.map((a: { value: string }) => a.value)).toEqual([
        `confirm:${selected.data.confirmationId}`,
        "abort",
      ]);
      expect(selected.ui.items[0].swapTo).toMatchObject({
        refundMethodSelected: true,
        refundMethod: selected.data.summary.refundMethod,
        refundEta: selected.data.summary.refundEta,
        refundCents: 750,
        chargeCents: 0,
        showtimeLabel: selected.data.summary.targetShowtimeLabel,
        cinemaName: selected.data.summary.targetCinemaName,
        seats: ["G8", "G9"],
      });
      for (const mismatch of [
        { bookingId: "OTHER" },
        { targetSessionKey: "OTHER" },
        { date: "today" },
        { time: "16:50" },
        { refundMethodForDifference: "OTHER_CARD" },
        { keepSeatsIfPossible: false },
      ])
        expect(invoke("swap-refund-choice", "prepare_swap", { ...next, ...mismatch }, language).error).toBe(
          true,
        );
    },
  );

  it("requires actual refund-method choice before the selected preview, with exchange still unexecuted", () => {
    const args = {
      bookingId: "FIXRAH1",
      date: "2027-01-02",
      time: "20:00",
      experience: "Standard",
      keepSeatsIfPossible: true,
    };
    const discovery = invoke("swap-refund-choice", "prepare_swap", args).value;
    const target = discovery.data.recommendedPreviewInput;
    const choices = invoke("swap-refund-choice", "prepare_swap", target).value;
    const selected = invoke("swap-refund-choice", "prepare_swap", {
      ...target,
      refundMethodForDifference: "VOX_CREDIT",
    }).value;
    const trace = [
      user("Move my booking to 2027-01-02 at the same time. Preview only."),
      call("prepare_swap", args),
      result("prepare_swap", discovery),
      call("prepare_swap", target),
      result("prepare_swap", choices),
      speech("The difference is AED7.50. Wallet credit valid90days or original card in5–10days?"),
      user("VOX Wallet credit, please."),
      call("prepare_swap", { ...target, refundMethodForDifference: "VOX_CREDIT" }),
      result("prepare_swap", selected),
      speech("Wallet selected. Confirm this exchange?"),
      user("Do not confirm; leave my booking unchanged."),
      speech("Understood."),
    ];
    expect(audit("swap-refund-choice", trace)).toEqual([]);
    const premature = [...trace];
    premature[3] = call("prepare_swap", { ...target, refundMethodForDifference: "ORIGINAL_PAYMENT" });
    premature[4] = result(
      "prepare_swap",
      invoke("swap-refund-choice", "prepare_swap", {
        ...target,
        refundMethodForDifference: "ORIGINAL_PAYMENT",
      }).value,
    );
    expect(audit("swap-refund-choice", premature)).toContainEqual(
      expect.stringContaining("preceding explicit wallet choice"),
    );
    const negated = [...trace];
    negated[6] = user("Not VOX Wallet credit; I have not chosen.");
    expect(audit("swap-refund-choice", negated)).toContainEqual(
      expect.stringContaining("preceding explicit wallet choice"),
    );
    expect(
      audit("swap-refund-choice", [
        ...trace,
        call("swap_booking", { confirmed: true, confirmationId: "FIX_SWAP_CONFIRMATION" }),
      ]),
    ).toContainEqual(expect.stringContaining("swap_booking is not authorized"));
  });
});
