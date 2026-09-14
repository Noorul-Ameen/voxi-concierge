import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildWebhookTools } from "../src/index.js";
import { auditJourneyTransitionEvidence } from "../src/journey-transition-evidence.js";
import { buildJourneyTransitionSuite } from "../src/journey-transition-simulations.js";
import { proposalEvidence } from "../src/proposal-fixtures.js";
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
      const value = Array.isArray(args[path]) ? JSON.stringify(args[path]) : String(args[path]);
      return check.type === "exact" ? value === check.expected_value : new RegExp(check.pattern).test(value);
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
      const args = {
        intent: "initial",
        hoCode: "FIX_SPIDER",
        tickets: 1,
        childTickets: 1,
        childAges: [7],
        date: "tomorrow",
      };
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
      const ready = invoke(
        "offer-snacks",
        "get_action_result",
        { actionId: "fixture_offer_action" },
        language,
      ).value.data.result.snackSuggestions;
      expect(ready.items).toHaveLength(2);
      expect(ready.usual.map((item: any) => item.itemId)).toEqual(["FIX_POPCORN", "FIX_COLA"]);
      expect(invoke("offer-snacks", "suggest_fnb", { cinemaId: "0001" }, language).error).toBe(true);
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
      const criteria = testFor("named-rating-age", language).success_conditions.join(" ");
      expect(criteria).toContain("BEFORE the user's final thanks");
      expect(criteria).toContain("AFTER the final thanks, close briefly without any question or invitation");
    });
    it(`${language}: a film-only edit cannot silently discard the current proposal's time or experience`, () => {
      const args = {
        intent: "edit",
        baseProposalRef: "FIX_OLD_REF",
        hoCode: "FIX_SPIDER",
        tickets: 1,
        childTickets: 1,
        cinemaId: "0002",
        date: "tomorrow",
        time: "18:45",
        experience: "Premier",
      };
      expect(
        invoke(
          "film-only-edit",
          "propose_booking",
          { intent: "edit", baseProposalRef: "FIX_OLD_REF", hoCode: "FIX_SPIDER" },
          language,
        ).value.data.admission,
      ).toMatchObject({ verified: true, childAges: [7] });
      for (const date of ["tomorrow", "2027-01-01"])
        expect(
          invoke("film-only-edit", "propose_booking", { ...args, date }, language).value.data.proposal,
        ).toMatchObject({
          experience: "Premier",
          showtime: "2027-01-01T18:30:00+04:00",
          held: false,
          requested: { time: "18:45" },
        });
      for (const change of [
        { date: "2027-01-02" },
        { date: "2026-12-31" },
        { baseProposalRef: undefined },
        { baseProposalRef: "wrong" },
        { intent: "initial" },
        { childAges: [8] },
        { time: "23:00", experience: "KIDS" },
        { childTickets: 0 },
      ])
        expect(invoke("film-only-edit", "propose_booking", { ...args, ...change }, language).error).toBe(
          true,
        );
    });
  }

  it("rejects missing ready facts that a later user/menu lookup cannot repair", () => {
    const trace = offer();
    const completed = JSON.parse(trace[4]!.tool_results![0]!.result_value);
    completed.data.result.snackSuggestions = { status: "unavailable", cinemaId: "0001" };
    trace[4] = result("get_action_result", completed);
    expect(
      audit("offer-snacks", [
        ...trace,
        speech("Offer applied."),
        user("Offer my usual now."),
        call("suggest_fnb", {}),
        result("suggest_fnb", { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } }),
        speech("Would you like popcorn?"),
      ]),
    ).toContainEqual(expect.stringContaining("later user prompts"));
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

  it("accepts verified ready facts without a duplicate menu but rejects failed or mismatched evidence", () => {
    const correct = [
      ...offer(),
      speech("Offer applied. Would you like your usual popcorn and cola?"),
      user("No snacks; stop here."),
      speech("Understood."),
    ];
    expect(audit("offer-snacks", correct)).toEqual([]);
    expect(
      audit("offer-snacks", [
        ...offer(),
        call("suggest_fnb", {}),
        result("suggest_fnb", { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } }),
        speech("Usual popcorn?"),
      ]),
    ).toContainEqual(expect.stringContaining("duplicate menu"));
    for (const flags of [{ is_error: true }, { is_blocked: true }, { tool_has_been_called: false }]) {
      const bad = [...correct];
      bad[4] = result(
        "get_action_result",
        invoke("offer-snacks", "get_action_result", { actionId: "fixture_offer_action" }).value,
        flags,
      );
      expect(audit("offer-snacks", bad)).not.toEqual([]);
    }
    for (const changes of [
      { cinemaId: "0002" },
      { purchaseRequiresConsent: false },
      { usual: [{ itemId: "invented", quantity: 1 }] },
      { items: [] },
    ]) {
      const bad = offer();
      const value = JSON.parse(bad[4]!.tool_results![0]!.result_value);
      Object.assign(value.data.result.snackSuggestions, changes);
      bad[4] = result("get_action_result", value);
      expect(audit("offer-snacks", [...bad, speech("Your usual popcorn?")])).not.toEqual([]);
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
      intent: "initial",
      childAges: [7],
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
      call("propose_booking", {
        intent: "initial",
        hoCode: "FIX_SPIDER",
        tickets: 1,
        childTickets: 1,
        childAges: [7],
        date: "tomorrow",
      }),
      result("propose_booking", proposal),
    ];
    expect(audit("enquiry-plan", [...entered, ...prepared, speech("Here is the evening proposal.")])).toEqual(
      [],
    );
    expect(
      audit("enquiry-plan", [
        call("search_sessions", { date: "tomorrow", title: "Spider-Man" }),
        speech("Which time?"),
        user("Show a proposal."),
        ...entered,
        ...prepared,
        speech("Here it is."),
      ]),
    ).toContainEqual(expect.stringContaining("Missing complete"));
    expect(audit("enquiry-plan", [...prepared, speech("Here is the evening proposal.")])).toContainEqual(
      expect.stringContaining("Procedure was not entered"),
    );
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
    const trace = offer();
    const completion = trace.splice(3);
    expect(
      audit("offer-snacks", [
        ...trace,
        user("Please offer snacks now."),
        ...completion,
        speech("Usual popcorn?"),
      ]),
    ).toContainEqual(expect.stringContaining("later user prompts"));
  });

  it("rejects a mismatched provider request ID instead of counting a same-name success", () => {
    const trace = offer();
    trace[4] = result(
      "get_action_result",
      invoke("offer-snacks", "get_action_result", { actionId: "fixture_offer_action" }).value,
      { request_id: "other_request" },
    );
    expect(audit("offer-snacks", [...trace, speech("Usual popcorn?")])).toContainEqual(
      expect.stringContaining("matching request ID"),
    );
  });

  it.each(["tomorrow", "2027-01-01"])(
    "%s: requires current admission on the new anchored proposal",
    (date) => {
      const args = {
        intent: "edit",
        baseProposalRef: "FIX_OLD_REF",
        hoCode: "FIX_SPIDER",
        tickets: 1,
        childTickets: 1,
        cinemaId: "0002",
        date,
        time: "18:45",
        experience: "Premier",
      };
      const prefix = [
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
        audit("film-only-edit", [...prefix, ...proposal, speech("Premier at 18:30 is available.")]),
      ).toEqual([]);
      for (const admission of [
        undefined,
        { verified: false },
        {
          verified: true,
          rating: "PG15",
          experience: "Premier",
          childAges: [7],
          children: [{ allowed: true, checkedChildAge: 7 }],
        },
      ]) {
        const invalid = invoke("film-only-edit", "propose_booking", args).value;
        invalid.data.admission = admission;
        expect(
          audit("film-only-edit", [
            ...prefix,
            ...age,
            proposal[0]!,
            result("propose_booking", invalid),
            speech("Available."),
          ]),
        ).toContainEqual(expect.stringContaining("Missing complete"));
      }
      expect(
        audit("film-only-edit", [
          user("Use 18:45 and Premier, then show it."),
          ...prefix,
          ...age,
          ...proposal,
          speech("Premier at 18:30 is available."),
        ]),
      ).toContainEqual(expect.stringContaining("first generated turn to be agent"));
      const wrongDateCall = {
        ...proposal[0],
        tool_calls: proposal[0]!.tool_calls!.map((c) => ({
          ...c,
          params_as_json: JSON.stringify({ ...args, date: "2027-01-02" }),
        })),
      };
      expect(
        audit("film-only-edit", [
          ...prefix,
          ...age,
          wrongDateCall,
          proposal[1]!,
          speech("Premier at 18:30 is available."),
        ]),
      ).toContainEqual(expect.stringContaining("preserve prior proposal choices"));
    },
  );

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
        { language: "unsupported" },
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
    expect(audit("swap-refund-choice", trace.slice(1))).toEqual([]);
    const premature = [...trace];
    premature[3] = call("prepare_swap", { ...target, refundMethodForDifference: "ORIGINAL_PAYMENT" });
    premature[4] = result(
      "prepare_swap",
      invoke("swap-refund-choice", "prepare_swap", {
        ...target,
        refundMethodForDifference: "ORIGINAL_PAYMENT",
      }).value,
    );
    expect(audit("swap-refund-choice", premature.slice(1))).toContainEqual(
      expect.stringContaining("preceding explicit wallet choice"),
    );
    const negated = [...trace];
    negated[6] = user("Not VOX Wallet credit; I have not chosen.");
    expect(audit("swap-refund-choice", negated.slice(1))).toContainEqual(
      expect.stringContaining("preceding explicit wallet choice"),
    );
    expect(
      audit("swap-refund-choice", [
        ...trace.slice(1),
        call("swap_booking", { confirmed: true, confirmationId: "FIX_SWAP_CONFIRMATION" }),
      ]),
    ).toContainEqual(expect.stringContaining("swap_booking is not authorized"));
  });

  it.each(["en", "ar"])("%s: fixed current-user triggers cannot be skipped by the simulator", (language) => {
    const plan = testFor("enquiry-plan", language);
    const refund = testFor("swap-refund-choice", language);
    const edit = testFor("film-only-edit", language);
    for (const t of [plan, refund, edit]) expect(t.chat_history.at(-1)).toMatchObject({ role: "user" });
    expect(edit.chat_history).toHaveLength(11);
    expect(JSON.stringify(edit.chat_history.at(-1))).toContain(
      language === "en" ? "do not hold or book anything" : "من دون حجز مؤقت للمقاعد أو إتمام أي حجز",
    );
    expect(audit("film-only-edit", [speech("Here is the edited suggestion.")], language)).toContainEqual(
      expect.stringContaining("Missing complete"),
    );
    expect(JSON.stringify(plan.chat_history.at(-1))).toMatch(/tomorrow|غداً/);
    expect(JSON.stringify(refund.chat_history.at(-1))).toContain("2027-01-02");
    expect(audit("enquiry-plan", [speech("Here it is.")], language)).toContainEqual(
      expect.stringContaining("Missing complete"),
    );
    expect(audit("enquiry-plan", [user("Actually, stop."), speech("Understood.")], language)).toContainEqual(
      expect.stringContaining("Missing complete"),
    );
  });

  it("never counts an authored proposal result as a generated response to a fixed user trigger", () => {
    const t = testFor("enquiry-plan");
    const args = {
      intent: "initial",
      hoCode: "FIX_SPIDER",
      tickets: 1,
      childTickets: 1,
      childAges: [7],
      date: "tomorrow",
    };
    const modified = {
      ...t,
      chat_history: [
        ...t.chat_history.slice(0, -1),
        call("propose_booking", args),
        result("propose_booking", invoke("enquiry-plan", "propose_booking", args).value),
        t.chat_history.at(-1),
      ],
    };
    expect(
      auditJourneyTransitionEvidence(modified, [
        ...(modified.chat_history as Turns),
        speech("Here is your proposal."),
      ]),
    ).toContainEqual(expect.stringContaining("Missing complete"));
  });

  it("accepts only the known no-history configured greeting before a definition question", () => {
    expect(
      audit("rating-definition", [
        speech("Welcome back, Sara."),
        user("What does PG13 mean?"),
        speech("Guests13 and under must be accompanied by someone13 or older."),
      ]),
    ).toEqual([]);
    expect(
      audit("rating-definition", [
        call("get_age_rules", { rating: "PG13" }),
        user("What does PG13 mean?"),
        speech("PG13."),
      ]),
    ).toContainEqual(expect.stringContaining("Missing generated first user"));
  });

  it("handles native boolean casing without weakening cheaper-swap scope rejection", () => {
    const t = materialized.find((x) => x.id === "transition-swap-refund-choice-en")!;
    const booleanGuard = t.body.tool_mock_overrides.prepare_swap!.find(
      (m) => m.is_error && m.parameter_conditions[0]?.path === "keepSeatsIfPossible",
    )!;
    const condition = booleanGuard.parameter_conditions[0]!.eval;
    expect(condition.type).toBe("regex");
    if (condition.type !== "regex") throw Error("Expected boolean guard");
    const guard = new RegExp(condition.pattern);
    for (const value of ["true", "True"]) expect(guard.test(value)).toBe(false);
    for (const value of ["false", "False", "0", "unknown"]) expect(guard.test(value)).toBe(true);
    const exact = {
      bookingId: "FIXRAH1",
      date: "2027-01-02",
      time: "20:00",
      experience: "Standard",
      keepSeatsIfPossible: true,
    };
    expect(invoke("swap-refund-choice", "prepare_swap", exact).error).toBe(false);
    for (const change of [
      { date: "2027-01-03" },
      { time: "21:00" },
      { experience: "IMAX" },
      { keepSeatsIfPossible: false },
    ])
      expect(invoke("swap-refund-choice", "prepare_swap", { ...exact, ...change }).error).toBe(true);
  });

  it("matches the generated native swap language schema rather than only the business Zod input", () => {
    const native = buildWebhookTools({
      conciergeUrl: "https://fixture.invalid",
      toolSecretHeader: { secret_id: "fixture-secret" },
    });
    const swap = native.find((t) => t.name === "prepare_swap")!;
    const proposal = native.find((t) => t.name === "propose_booking")!;
    expect(swap.api_schema.request_body_schema.properties.language).toMatchObject({
      type: "string",
      enum: ["en", "ar"],
    });
    expect(proposal.api_schema.request_body_schema.properties.language).toBeUndefined();
    for (const language of ["en", "ar"]) {
      expect(
        invoke(
          "swap-refund-choice",
          "prepare_swap",
          {
            bookingId: "FIXRAH1",
            date: "2027-01-02",
            time: "20:00",
            experience: "Standard",
            keepSeatsIfPossible: true,
            language,
          },
          language,
        ).error,
      ).toBe(false);
      expect(
        invoke(
          "enquiry-plan",
          "propose_booking",
          { hoCode: "FIX_SPIDER", date: "tomorrow", tickets: 1, childTickets: 1, language },
          language,
        ).error,
      ).toBe(true);
    }
  });
  it("never turns missing ages or unknown quantity into acceptance proof", () => {
    const full = invoke("enquiry-plan", "propose_booking", {
      intent: "initial",
      hoCode: "FIX_SPIDER",
      tickets: 1,
      childTickets: 1,
      childAges: [7],
      date: "tomorrow",
    }).value.data.proposal;
    const missing = proposalEvidence(full, "needs_age", [], "must_not_survive");
    expect(missing.data).toMatchObject({ needs: "child_age", admission: { verified: false, children: [] } });
    expect(missing.data).not.toHaveProperty("proposalToken");
    expect(missing.ui.actions.some((a) => a.value === "proposal:accept")).toBe(false);
    const unknown = proposalEvidence(
      {
        ...full,
        adultTickets: null,
        childTickets: 0,
        ticketQuantity: null,
        selectedSeats: [],
        totalCents: null,
      },
      "needs_count",
      [],
      "must_not_survive",
      "tickets",
    );
    expect(unknown.data).not.toHaveProperty("proposalToken");
    expect(unknown.ui.actions.some((a) => a.value === "proposal:accept")).toBe(false);
    for (const rating of ["18TC", "TBC", "15+", undefined])
      expect(() => proposalEvidence({ ...full, rating }, "bad", [7], "token")).toThrow("restricted-rating");
  });

  it("array conditions accept only the supplied list and never a scalar or invented age", () => {
    for (const childAges of [[8], [], [7, 7], 7, "7"])
      expect(
        invoke("enquiry-plan", "propose_booking", {
          intent: "initial",
          hoCode: "FIX_SPIDER",
          tickets: 1,
          childTickets: 1,
          childAges,
          date: "tomorrow",
        }).error,
      ).toBe(true);
    const test = materialized.find((t) => t.id === "transition-enquiry-plan-en")!;
    const success = test.body.tool_mock_overrides.propose_booking!.find((m) => !m.is_error)!;
    const age = success.parameter_conditions.find((c) => c.path === "childAges")!.eval;
    if (age.type !== "regex") throw Error("Expected exact list regex");
    for (const value of ["[7]", "[ 7 ]"]) expect(new RegExp(age.pattern).test(value)).toBe(true);
    for (const value of ["7", "[8]", "[7,7]", "[]"]) expect(new RegExp(age.pattern).test(value)).toBe(false);
  });

  it("allows a safe context refresh before Procedure entry without counting it as booking preparation", () => {
    const args = {
      intent: "initial",
      hoCode: "FIX_SPIDER",
      tickets: 1,
      childTickets: 1,
      childAges: [7],
      date: "tomorrow",
    };
    expect(
      audit("enquiry-plan", [
        call("get_session_context", {}),
        result("get_session_context", invoke("enquiry-plan", "get_session_context", {}).value),
        call("start_procedure", {}),
        result("start_procedure", {
          result_type: "start_procedure_success",
          status: "success",
          procedure_name: "VOX · Discover and book",
        }),
        call("propose_booking", args),
        result("propose_booking", invoke("enquiry-plan", "propose_booking", args).value),
        speech("Here is the plan."),
      ]),
    ).toEqual([]);
  });
});
