import { readFileSync } from "node:fs";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { assessResponse } from "../src/coaching.js";
import { buildWebhookTools } from "../src/index.js";
import { auditJourneyEvidence } from "../src/journey-evidence.js";
import { buildJourneySimulationSuite } from "../src/journey-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

describe("eight approved journeys", () => {
  it("does not let broad mocks hide invented preferences, saved-card sentinels or conversation IDs", () => {
    const tests = buildJourneySimulationSuite().tests;
    const invoke = (id: string, tool: string, args: Record<string, unknown>) => {
      const matches = tests.find((test) => test.id === id)!.tool_mock_overrides[tool];
      const mock = matches.find((entry) =>
        entry.parameter_conditions.every(({ path, eval: check }) => {
          const value = args[path];
          if (value === undefined) return false;
          return check.type === "exact"
            ? String(value) === check.expected_value
            : new RegExp(check.pattern).test(String(value));
        }),
      );
      return mock ? JSON.parse(mock.mock_result) : { ok: false };
    };
    expect(invoke("02-positive-ar", "get_recommendations", {})).toMatchObject({ ok: true });
    for (const args of [{ cinemaName: "Mirdif" }, { timeFrom: "16:00" }, { language: "ar" }])
      expect(invoke("02-positive-ar", "get_recommendations", args)).toMatchObject({ ok: false });
    expect(invoke("03-negative-ar-offer-error", "list_offers", { bank: "saved_card" })).toMatchObject({
      ok: false,
    });
    expect(invoke("03-positive-ar", "list_offers", { bank: "Fixture Bank" })).toMatchObject({ ok: true });
    expect(
      invoke("07-negative-ar", "investigate_payment", { userSessionId: "test-trun_unowned" }),
    ).toMatchObject({ ok: false });
    expect(invoke("07-negative-ar", "investigate_payment", {})).toMatchObject({ ok: true });
    expect(
      invoke("07-negative-ar", "investigate_payment", {
        transactionReference: "DEMO-TXN-22",
        cardLast4: "1234",
      }),
    ).toMatchObject({ ok: true, data: { status: "unresolved" } });
    expect(invoke("08-positive-ar", "search_sessions", { cinemaId: "0001", language: "ar" })).toMatchObject({
      ok: false,
    });
  });
  it("keeps the six legacy proposal controls explicit without inventing child attendance or consent", () => {
    const suite = buildJourneySimulationSuite();
    const resolve = (id: string, args: Record<string, unknown>) => {
      const mocks = suite.tests.find((t) => t.id === id)!.tool_mock_overrides.propose_booking!;
      const match = mocks.find((m) =>
        m.parameter_conditions.every(({ path, eval: rule }) => {
          if (args[path] === undefined) return false;
          const value = Array.isArray(args[path]) ? JSON.stringify(args[path]) : String(args[path]);
          return rule.type === "exact" ? value === rule.expected_value : new RegExp(rule.pattern).test(value);
        }),
      );
      return match ? JSON.parse(match.mock_result) : { ok: false };
    };
    for (const lang of ["en", "ar"]) {
      const family = resolve(`02-positive-${lang}`, {
        intent: "initial",
        tickets: 1,
        childTickets: 1,
        childAges: [7],
      });
      expect(family.data).toMatchObject({
        proposalRef: "fixture_family_ref",
        proposalToken: "fixture_proposal",
        admission: { verified: true, childAges: [7], children: [{ allowed: true }] },
        proposal: { adultTickets: 1, childTickets: 1, ticketQuantity: 2 },
      });
      expect(resolve(`02-positive-${lang}`, { intent: "initial", tickets: 1, childTickets: 1 }).ok).toBe(
        false,
      );
      expect(
        resolve(`02-positive-${lang}`, { intent: "initial", tickets: 1, childTickets: 1, childAges: [8] }).ok,
      ).toBe(false);
      const adult = resolve(`02-positive-${lang}-accept`, { intent: "initial", tickets: 2 });
      expect(adult.data).toMatchObject({
        proposalRef: "fixture_adult_ref",
        proposalToken: "fixture_proposal",
        admission: { verified: true, childAges: [], children: [] },
      });
      expect(
        resolve(`02-positive-${lang}-accept`, { intent: "initial", tickets: 2, childAges: [7] }).ok,
      ).toBe(false);
      const unknown = resolve(`02-negative-${lang}`, { intent: "initial" });
      expect(unknown.data).toMatchObject({
        needs: "tickets",
        admission: { childAges: [], children: [] },
        proposal: { adultTickets: null, ticketQuantity: null, selectedSeats: [] },
      });
      expect(unknown.data).not.toHaveProperty("proposalToken");
      for (const result of [family, adult, unknown]) {
        expect(result.ui.items).toEqual([result.data.proposal]);
        expect(result.ui.items[0]).not.toHaveProperty("tickets");
        expect(result.ui.items[0]).not.toHaveProperty("seats");
      }
      expect(unknown.ui.actions.some((a: any) => a.value === "proposal:accept")).toBe(false);
      for (const args of [
        { intent: "initial", childAges: [7] },
        { intent: "initial", tickets: 2 },
        { intent: "edit", baseProposalRef: "invented" },
      ])
        expect(resolve(`02-negative-${lang}`, args).ok).toBe(false);
      expect(
        suite.tests.find((t) => t.id === `02-negative-${lang}-age`)!.tool_mock_overrides.propose_booking,
      ).toBeUndefined();
    }
  });
  it("matches asynchronous offer edits, valid title lookups and consistent switch amounts", () => {
    const tests = buildJourneySimulationSuite().tests;
    for (const language of ["en", "ar"]) {
      const offer = tests.find((test) => test.id === `03-positive-${language}`)!;
      const apply = offer.tool_mock_overrides.apply_offer[0];
      expect(apply.parameter_conditions.some((condition) => condition.path === "confirmed")).toBe(false);
      const queued = JSON.parse(apply.mock_result).data.action;
      expect(queued.status).toBe("queued");
      expect(
        JSON.parse(offer.tool_mock_overrides.list_offers.find((mock) => !mock.is_error)!.mock_result).speech,
      ).toContain("96");
      expect(JSON.parse(offer.tool_mock_overrides.get_order[0].mock_result).data.order.totalCents).toBe(
        12600,
      );
      expect(offer.tool_mock_overrides.get_action_result[0].parameter_conditions).toContainEqual({
        path: "actionId",
        eval: { type: "exact", expected_value: queued.actionId },
      });
      expect(
        JSON.parse(offer.tool_mock_overrides.get_action_result[0].mock_result).data.result.order.totalCents,
      ).toBe(9600);
      const age = tests.find((test) => test.id === `02-negative-${language}-age`)!;
      expect(
        age.tool_mock_overrides.get_film.some((mock) =>
          mock.parameter_conditions.some((condition) => condition.path === "title"),
        ),
      ).toBe(true);
      const switching = tests.find((test) => test.id === `04-positive-${language}`)!;
      const current = JSON.parse(switching.tool_mock_overrides.get_session_context[0].mock_result).data
        .activeOrder.summary;
      expect(current).toMatchObject({ totalCents: 9600, total: "AED 96.00" });
      const initialRead = JSON.parse(switching.tool_mock_overrides.get_order[0].mock_result).data.order;
      expect(initialRead).toMatchObject(current);
      expect(initialRead.offers).toHaveLength(1);
      const removed = JSON.parse(switching.tool_mock_overrides.apply_offer[0].mock_result);
      expect(removed.data.result.order).toMatchObject({
        totalCents: 12000,
        total: "AED 120.00",
        offers: [],
      });
      expect(removed.ui).toMatchObject({ type: "order", items: [removed.data.result.order] });
      const rendered = switching.tool_mock_overrides.render_order_summary[0];
      expect(rendered.parameter_conditions).toEqual([
        { path: "userSessionId", eval: { type: "exact", expected_value: "fixture_order" } },
      ]);
      expect(rendered.is_error).toBe(false);
      expect(JSON.parse(rendered.mock_result)).toBe("The order summary is shown after each order step.");
      expect(switching.success_conditions.join(" ")).toContain("static fixture");
      const fresh = tests.find((test) => test.id === `04-positive-${language}-after-removal`)!;
      expect(JSON.parse(fresh.tool_mock_overrides.get_order[0].mock_result).data.order).toMatchObject({
        totalCents: 12000,
        total: "AED 120.00",
        offers: [],
      });
      const preview = JSON.parse(switching.tool_mock_overrides.prepare_payment[0].mock_result);
      expect(preview.speech).toContain("96");
      expect(preview.speech).toContain("120");
      expect(preview.ui.type).toBe("payment_switch");
      const failed = tests.find((test) => test.id === `03-negative-${language}-offer-error`)!;
      expect(failed.tool_mock_overrides.apply_offer[0].is_error).toBe(true);
      expect(failed.tool_mock_overrides.transfer_to_agent[0].is_error).toBe(true);
      expect(JSON.parse(failed.tool_mock_overrides.transfer_to_agent[0].mock_result).data).toBeUndefined();
      expect(JSON.parse(failed.tool_mock_overrides.get_order[0].mock_result).data.order.totalCents).toBe(
        12000,
      );
    }
  });

  it("detects guessed ratings, fabricated action polling and unnecessary unpaid completion logging", () => {
    const bad = auditJourneyEvidence({
      name: "VOX Journey 03-negative-ar-offer-error fixture-v5",
      transcript: [
        { calls: [{ name: "get_age_rules", arguments: { rating: "18+", childAge: 7 } }] },
        {
          results: [
            { name: "transfer_to_agent", value: { ok: false, error: { code: "TRANSFER_UNAVAILABLE" } } },
          ],
        },
        { calls: [{ name: "get_action_result", arguments: { actionId: "transfer_action" } }] },
        { calls: [{ name: "log_journey", arguments: { journey: "booking", status: "completed" } }] },
      ],
    });
    expect(bad).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rating absent"),
        expect.stringContaining("pending actionId"),
        expect.stringContaining("backend owns"),
      ]),
    );
    const good = auditJourneyEvidence({
      name: "VOX Journey 03-positive-en fixture-v5",
      transcript: [
        { results: [{ name: "get_film", value: { ok: true, data: { film: { rating: "PG" } } } }] },
        { calls: [{ name: "get_age_rules", arguments: { rating: "PG", childAge: 7 } }] },
        {
          results: [
            {
              name: "apply_offer",
              value: { ok: true, data: { action: { actionId: "actual_action", status: "queued" } } },
            },
          ],
        },
        { calls: [{ name: "get_action_result", arguments: { actionId: "actual_action" } }] },
      ],
    });
    expect(good).toEqual([]);
  });

  it("matches swap provider seats and returns a fresh booking reference in the real completion envelope", () => {
    for (const language of ["en", "ar"]) {
      const test = buildJourneySimulationSuite().tests.find((item) => item.id === `08-positive-${language}`)!;
      const prepared = JSON.parse(test.tool_mock_overrides.prepare_swap[0].mock_result).data.summary;
      expect(prepared.selectedSeats).toEqual([
        { Row: "D", Number: "8", TicketTypeCode: "FIX_TICKET" },
        { Row: "D", Number: "9", TicketTypeCode: "FIX_TICKET" },
      ]);
      const completed = JSON.parse(test.tool_mock_overrides.swap_booking[0].mock_result);
      expect(completed.data.action.status).toBe("succeeded");
      expect(completed.data.result.newBookingId).not.toBe(prepared.bookingId);
      expect(completed.data.result).toMatchObject({
        newBookingId: "fixture_swapped",
        differenceCents: prepared.differenceCents,
        settlement: { direction: "charge", amountCents: prepared.chargeCents },
      });
      expect(completed.ui.items[0]).toMatchObject({
        bookingId: completed.data.result.newBookingId,
        totalCents: prepared.newTotalCents,
        swappedFrom: prepared.bookingId,
        status: "confirmed",
        qrPayload: "fixture-swapped-qr-only",
        time: "19:05",
      });
      expect(completed.data.booking).toBeUndefined();
      for (const path of ["positive", "negative"]) {
        const swap = buildJourneySimulationSuite().tests.find(
          (item) => item.id === `08-${path}-${language}`,
        )!;
        const dated = swap.tool_mock_overrides.prepare_swap.filter((entry) =>
          entry.parameter_conditions.some((condition) => condition.path === "date"),
        );
        expect(
          dated.map(
            (entry) => entry.parameter_conditions.find((condition) => condition.path === "date")!.eval,
          ),
        ).toEqual([
          { type: "exact", expected_value: "tomorrow" },
          { type: "exact", expected_value: "2030-06-04" },
        ]);
        expect(dated[0].mock_result).toBe(dated[1].mock_result);
        expect(
          dated.every((entry) =>
            entry.parameter_conditions.some(
              (condition) =>
                condition.path === "bookingId" &&
                condition.eval.type === "exact" &&
                condition.eval.expected_value === "fixture_booking",
            ),
          ),
        ).toBe(true);
      }
    }
  });
  it("grounds an empty swap fixture in its original scope without granting a wider search", () => {
    for (const language of ["en", "ar"]) {
      const test = buildJourneySimulationSuite().tests.find((item) => item.id === `08-negative-${language}`)!;
      const results = test.tool_mock_overrides.prepare_swap
        .filter((entry) => !entry.is_error)
        .map((entry) => JSON.parse(entry.mock_result));
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.data).toMatchObject({
          needs: "swap_session",
          nextStep: "ask_before_widening",
          alternatives: [],
          requestedScope: {
            hoCode: "FIX_FILM",
            cinemaId: "0001",
            date: "2030-06-04",
            dateMatch: "requested_day",
            time: "19:00",
            timeMatch: "closest_to",
            experience: "Premier",
            experienceMatch: "original_preferred",
          },
          availabilityScope: "closest_matches_only",
          canConcludeNoShowsAllDay: false,
          originalBookingUnchanged: true,
        });
        expect(result.data).not.toHaveProperty("confirmationId");
        expect(result.data).not.toHaveProperty("recommendedPreviewInput");
        expect(result.ui).toMatchObject({
          type: "showtimes",
          items: [],
          actions: [],
          meta: { requestedScope: result.data.requestedScope, nextStep: "ask_before_widening" },
        });
        expect(result.speech).toContain(language === "en" ? "Would you like to change" : "هل ترغب في تغيير");
      }
      expect(test.success_conditions.join(" ")).toContain("Do not silently broaden cinema");
      expect(
        test.tool_mock_overrides.search_sessions.some(
          (entry) =>
            entry.is_error && entry.parameter_conditions.some((condition) => condition.path === "language"),
        ),
      ).toBe(true);
    }
  });

  it("allows a polite farewell and evaluates waiting only when the user explicitly asks to pause", () => {
    const tests = buildJourneySimulationSuite().tests;
    for (const language of ["en", "ar"]) {
      const positive = tests.find((test) => test.id === `01-positive-${language}`)!;
      const pause = tests.find((test) => test.id === `01-negative-${language}`)!;
      expect(positive.success_conditions.join(" ")).toContain(
        "a brief polite acknowledgment or farewell is allowed",
      );
      expect(positive.success_conditions.join(" ")).toContain("no unsolicited follow-up question");
      expect(positive.success_conditions.join(" ")).not.toContain("explicit pause");
      expect(pause.success_conditions.join(" ")).toContain("On an explicit pause acknowledge once");
      expect(pause.success_conditions.join(" ")).toContain("do not promise extended seat holds");
    }
  });
  it("matches fixture parameter names and enum values to the actual generated server contracts", () => {
    const schemas = new Map(
      buildWebhookTools({
        conciergeUrl: "https://fixture.invalid",
        toolSecretHeader: { secret_id: "fixture_secret" },
      }).map((tool) => [tool.name as string, tool.api_schema.request_body_schema.properties]),
    );
    for (const test of buildJourneySimulationSuite().tests) {
      for (const [name, mocks] of Object.entries(test.tool_mock_overrides)) {
        const schema = schemas.get(name);
        if (!schema) continue;
        // Denial guards deliberately catch undeclared arguments; only successful
        // responses may assert that an input is a supported contract field.
        for (const condition of mocks
          .filter((mock) => !mock.is_error)
          .flatMap((mock) => mock.parameter_conditions)) {
          const prop = schema[condition.path];
          expect(prop, `${test.id}/${name}.${condition.path}`).toBeDefined();
          if (prop && "enum" in prop && prop.enum && condition.eval.type === "exact")
            expect(prop.enum).toContain(condition.eval.expected_value);
        }
      }
    }
  });
  it("covers each journey in both languages and preserves nonexecution for every tool including new tools", () => {
    const suite = buildJourneySimulationSuite();
    const tools = [
      ...Object.keys(TOOL_REGISTRY),
      ...Object.keys(CLIENT_TOOLS),
      "future_financial_action",
    ].map((name) => ({ name, id: `fixture_${name}` }));
    const tests = materializeSimulations(suite, tools);
    expect(tests).toHaveLength(42);
    expect(new Set(tests.map((t) => t.scenario_group)).size).toBe(8);
    for (const test of tests) {
      expect(test.body.tool_mock_config).toMatchObject({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
      });
      expect(test.body.tool_mock_config.mocked_tool_ids).toHaveLength(tools.length);
      expect(test.body.tool_mock_overrides.fixture_pay_order.every((m) => m.is_error)).toBe(true);
      expect(test.body.tool_mock_overrides.fixture_future_financial_action[0].is_error).toBe(true);
      for (const mocks of Object.values(test.body.tool_mock_overrides))
        expect(mocks.some((m) => !m.parameter_conditions.length)).toBe(true);
    }
    expect(JSON.stringify(suite)).not.toMatch(/paymentToken|password|\"cardBin\"/);
  });

  it("grounds existing baskets and separates successful QR rendering from its explicit failure", () => {
    const tests = buildJourneySimulationSuite().tests;
    const offers = tests.find((test) => test.id === "03-positive-en")!;
    expect(JSON.stringify(offers.chat_history)).toContain("fixture_order");
    expect(offers.tool_mock_overrides.apply_offer[0].parameter_conditions).toEqual(
      expect.arrayContaining([
        { path: "userSessionId", eval: { type: "exact", expected_value: "fixture_order" } },
        { path: "offerId", eval: { type: "exact", expected_value: "FIX_OFFER" } },
      ]),
    );
    const qr = tests.find((test) => test.id === "05-positive-en")!;
    const failed = tests.find((test) => test.id === "05-negative-en-render-failure")!;
    expect(JSON.parse(qr.tool_mock_overrides.render_qr[0].mock_result)).toMatchObject({
      ok: true,
      rendered: true,
    });
    expect(JSON.parse(failed.tool_mock_overrides.render_qr[0].mock_result)).toMatchObject({
      ok: false,
      rendered: false,
      reason: "display_failed",
      bookingVerified: true,
      bookingId: "FIXTURE_BOOKING",
      guidance: JSON.parse(
        readFileSync(
          new URL("../../../apps/web/src/lib/receipt-failure-guidance.json", import.meta.url),
          "utf8",
        ),
      ).verified,
    });
    expect(failed.tool_mock_overrides.render_qr[0].is_error).toBe(false);
    expect(JSON.parse(failed.tool_mock_overrides.find_booking[0].mock_result).ui).toBeUndefined();
    const bank = tests.find((test) => test.id === "06-negative-en")!;
    expect(
      JSON.parse(bank.tool_mock_overrides.check_cancellation_eligibility[0].mock_result).data.booking,
    ).toMatchObject({
      bookingId: "fixture_bank_booking",
      bookingRef: "fixture_bank_booking",
      experience: "IMAX",
    });
    expect(bank.success_conditions.join(" ")).not.toContain("Original-card demo ETA");
  });

  it("catches the observed Arabic unsolicited follow-up while allowing a necessary consent question", () => {
    expect(
      assessResponse({
        text: "اليوم الخميس. كيف يمكنني مساعدتك في فوكس سينما اليوم؟",
        modality: "voice",
        answerOnly: true,
      }).flags,
    ).toContain("unsolicited_followup");
    expect(assessResponse({ text: "أحذف العرض وأستخدم رصيد فوكس؟", modality: "voice" }).flags).toEqual([]);
    expect(
      assessResponse({ text: "كم تذكرة تريد؟", modality: "voice", known: { quantity: true } }).flags,
    ).toContain("asks_known_information");
  });

  it("flags a fabricated order ID even when a permissive mock returned success", () => {
    const calls = [
      { role: "user", message: "Yes, apply that offer." },
      {
        calls: [
          {
            name: "apply_offer",
            arguments: { userSessionId: "sess_unpaid_hold", offerId: "FIX_OFFER", confirmed: true },
          },
        ],
      },
    ];
    expect(
      auditJourneyEvidence({ name: "VOX Journey 03-positive-en fixture-v2", transcript: calls }),
    ).toContainEqual(expect.stringContaining("order identifier absent"));
    expect(
      auditJourneyEvidence({
        name: "VOX Journey 03-positive-en fixture-v2",
        transcript: [
          {
            results: [
              {
                name: "get_session_context",
                value: { ok: true, data: { activeOrder: { userSessionId: "sess_unpaid_hold" } } },
              },
            ],
          },
          ...calls,
        ],
      }).some((finding) => finding.includes("order identifier absent")),
    ).toBe(false);
  });

  it("rejects an invented offer identifier before a permissive response can disguise it", () => {
    const result = auditJourneyEvidence({
      name: "VOX Journey 03-negative-en fixture-v7",
      transcript: [
        { calls: [{ name: "check_offer_eligibility", arguments: { offerId: "bank_offer" } }] },
        {
          results: [
            {
              name: "check_offer_eligibility",
              value: { ok: true, data: { offerId: "FIX_OFFER", eligible: true } },
            },
          ],
        },
      ],
    });
    expect(result).toContainEqual(expect.stringContaining("offer identifier absent"));
    const mock = buildJourneySimulationSuite().tests.find((test) => test.id === "03-negative-en")!
      .tool_mock_overrides.check_offer_eligibility[0];
    expect(mock.parameter_conditions).toContainEqual({
      path: "offerId",
      eval: { type: "exact", expected_value: "FIX_OFFER" },
    });
  });

  it("rejects a refusal being treated as offer-removal consent and a handover before investigation", () => {
    const offer = auditJourneyEvidence({
      name: "VOX Journey 04-negative-en",
      transcript: [
        { role: "user", message: "Keep the bank offer and my saved card." },
        {
          calls: [
            { name: "apply_offer", arguments: { remove: true, confirmationId: "invented", confirmed: true } },
          ],
        },
      ],
    });
    expect(offer.some((s) => s.includes("explicit fixture consent"))).toBe(true);
    expect(offer.some((s) => s.includes("unverified"))).toBe(true);
    expect(
      auditJourneyEvidence({
        name: "VOX Journey 07-negative-en",
        transcript: [{ calls: [{ name: "transfer_to_agent", arguments: { investigationId: "guessed" } }] }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("verified investigation"),
        "No successful payment investigation occurred.",
      ]),
    );
  });

  it("accepts verified investigation context but never a cross-cinema swap workaround", () => {
    expect(
      auditJourneyEvidence({
        name: "VOX Journey 07-negative-en",
        transcript: [
          {
            results: [
              {
                name: "investigate_payment",
                value: { ok: true, data: { status: "unresolved", investigationId: "fixture_investigation" } },
              },
            ],
          },
          { role: "user", message: "Please transfer me with what you found." },
          { calls: [{ name: "transfer_to_agent", arguments: { investigationId: "fixture_investigation" } }] },
        ],
      }),
    ).toEqual([]);
    expect(
      auditJourneyEvidence({
        name: "VOX Journey 08-positive-en",
        transcript: [
          {
            calls: [
              { name: "search_sessions", arguments: { cinemaId: "0003" } },
              { name: "quick_book", arguments: {} },
            ],
          },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("original cinema"),
        expect.stringContaining("replacement"),
      ]),
    );
  });

  it("keeps the approved demo refund rule consistent across the knowledge sources", () => {
    for (const name of [
      "refund-policy",
      "checkout-payments-and-receipts",
      "how-to-book-and-manage",
      "terms-and-conditions",
      "faq",
      "offers-and-bank-offers",
    ]) {
      const text = readFileSync(new URL(`../kb/${name}.md`, import.meta.url), "utf8");
      expect(text).toContain("5–10 days (not working days)");
      expect(text).toContain("valid for 90 days");
      expect(text).toContain("not a universal promise");
    }
    const generator = readFileSync(new URL("../scripts/build-kb.ts", import.meta.url), "utf8");
    expect(generator).not.toContain("100 points = AED 1");
    expect(generator).toContain("if (curated.has(meta.id)) continue");
  });
});
