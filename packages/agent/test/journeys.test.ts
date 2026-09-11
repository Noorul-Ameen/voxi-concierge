import { readFileSync } from "node:fs";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { assessResponse } from "../src/coaching.js";
import { buildWebhookTools } from "../src/index.js";
import { auditJourneyEvidence } from "../src/journey-evidence.js";
import { buildJourneySimulationSuite } from "../src/journey-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

describe("eight approved journeys", () => {
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
      });
      expect(completed.data.booking).toBeUndefined();
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
        for (const condition of mocks.flatMap((mock) => mock.parameter_conditions)) {
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
    expect(tests).toHaveLength(40);
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
        { path: "confirmed", eval: { type: "exact", expected_value: "true" } },
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
    });
    expect(JSON.parse(failed.tool_mock_overrides.find_booking[0].mock_result).ui).toBeUndefined();
    const bank = tests.find((test) => test.id === "06-negative-en")!;
    expect(
      JSON.parse(bank.tool_mock_overrides.check_cancellation_eligibility[0].mock_result).data.booking,
    ).toMatchObject({ bookingId: "fixture_bank_booking", bookingRef: "WBANK12", experience: "IMAX" });
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
