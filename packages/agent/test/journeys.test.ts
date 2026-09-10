import { readFileSync } from "node:fs";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { assessResponse } from "../src/coaching.js";
import { buildWebhookTools } from "../src/index.js";
import { auditJourneyEvidence } from "../src/journey-evidence.js";
import { buildJourneySimulationSuite } from "../src/journey-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

describe("eight approved journeys", () => {
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
    expect(tests).toHaveLength(38);
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
