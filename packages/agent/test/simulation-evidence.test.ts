import { describe, expect, it } from "vitest";
import { type SimulationEvidence, auditSimulationEvidence } from "../src/simulation-evidence.js";

const menu = {
  results: [{ name: "suggest_fnb", value: { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } } }],
};
const add = {
  calls: [
    {
      name: "add_concessions",
      arguments: { userSessionId: "fixture_order", items: [{ itemId: "FIX_POPCORN", quantity: 1 }] },
    },
  ],
};
const added = {
  results: [{ name: "add_concessions", value: { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } } }],
};

describe("independent simulation trace checks", () => {
  it("accepts grounded food and a generic unpaid payment sheet", () => {
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 06a",
        transcript: [
          menu,
          add,
          added,
          {
            calls: [
              { name: "prepare_payment", arguments: { method: "CARD", userSessionId: "fixture_order" } },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("catches previously judged passes containing invented items or contact details", () => {
    const test: SimulationEvidence = {
      name: "VOX Enhancement 06a",
      transcript: [
        {
          calls: [
            {
              name: "add_concessions",
              arguments: {
                userSessionId: "fixture_order",
                items: [{ itemId: "popcorn_salted", quantity: 1 }],
              },
            },
          ],
        },
        {
          results: [
            { name: "add_concessions", value: { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } } },
          ],
        },
        {
          calls: [
            {
              name: "prepare_payment",
              arguments: { method: "SAVED_CARD", customer: { email: "made-up@example.invalid" } },
            },
          ],
        },
      ],
    };
    expect(auditSimulationEvidence(test)).toHaveLength(3);
  });

  it("requires lookup before mutation even when the guessed ID happened to be correct", () => {
    expect(auditSimulationEvidence({ name: "VOX Enhancement 06a", transcript: [add, added, menu] })).toEqual([
      "Turn 0: food ID was used before a matching menu/suggestion result.",
    ]);
  });

  it("rejects payment attempts and unexpected mock errors regardless of judge verdict", () => {
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 10b",
        transcript: [
          { calls: [{ name: "pay_order", arguments: { confirmed: true } }] },
          {
            results: [
              { name: "pay_order", value: { ok: false, error: { code: "UNEXPECTED_SIMULATION_TOOL" } } },
            ],
          },
        ],
      }),
    ).toHaveLength(2);
  });

  it.each([
    undefined,
    [],
    [{ itemId: "popcorn_salted", quantity: 1 }],
    [{ itemId: "FIX_POPCORN", quantity: 10 }],
    [{ itemId: "FIX_POPCORN", quantity: 0 }],
    [
      { itemId: "FIX_POPCORN", quantity: 1 },
      { itemId: "FIX_DRINK", quantity: 1 },
    ],
    [{ itemId: "FIX_POPCORN", quantity: 1, modifierIds: ["invented"] }],
  ])("rejects invalid food arguments even when a broad provider mock succeeds: %j", (items) => {
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 06a",
      transcript: [
        menu,
        { calls: [{ name: "add_concessions", arguments: { userSessionId: "fixture_order", items } }] },
        added,
      ],
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("reads the provider tool_calls/tool_results layout and requires completed queued food", () => {
    const queued = {
      tool_results: [
        {
          name: "add_concessions",
          result: JSON.stringify({ ok: true, data: { action: { actionId: "food", status: "queued" } } }),
        },
      ],
    };
    const complete = {
      tool_results: [
        {
          name: "get_action_result",
          result: JSON.stringify({
            ok: true,
            data: {
              action: { actionId: "food", status: "succeeded" },
              result: { ok: true, data: { items: [{ itemId: "FIX_POPCORN" }] } },
            },
          }),
        },
      ],
    };
    const payment = { tool_calls: [{ name: "prepare_payment", arguments: { method: "CARD" } }] };
    const prefix = [
      { tool_results: [{ name: "suggest_fnb", result: JSON.stringify(menu.results[0]?.value) }] },
      { tool_calls: add.calls },
      queued,
    ];
    expect(
      auditSimulationEvidence({ name: "VOX Enhancement 06a", transcript: [...prefix, complete, payment] }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({ name: "VOX Enhancement 06a", transcript: [...prefix, payment] }),
    ).toContain("Turn 3: payment preparation preceded a successful food mutation.");
  });

  it("refuses empty or message-only traces and a seat-map claim without a map result", () => {
    expect(auditSimulationEvidence({ name: "VOX Enhancement 01", transcript: [] })).toHaveLength(1);
    expect(auditSimulationEvidence({ name: "VOX Enhancement 01", transcript: [{}] })).toHaveLength(1);
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 08",
      transcript: [{ calls: [{ name: "quick_book", arguments: { seatPreference: "middle" } }] }],
    });
    expect(findings).toContain("Turn 0: usual-seat booking proceeded without verified context.");
    expect(findings).toContain("No successful seat-map tool result; a spoken display claim is insufficient.");
  });
});
