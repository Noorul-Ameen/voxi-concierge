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
              arguments: {
                userSessionId: "fixture_order",
                method: "SAVED_CARD",
                customer: { name: "Invented Name", email: "made-up@example.invalid", phone: "+971500000000" },
              },
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
          {
            calls: [
              {
                name: "pay_order",
                arguments: {
                  userSessionId: "fixture_order",
                  confirmationId: "fixture_confirmation",
                  confirmed: true,
                },
              },
            ],
          },
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
    const payment = {
      tool_calls: [
        { name: "prepare_payment", arguments: { userSessionId: "fixture_order", method: "CARD" } },
      ],
    };
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

  it("accepts backend usual-seat inference but rejects an explicit unverified position", () => {
    const map = { results: [{ name: "render_seat_map", value: { ok: true, rendered: true } }] };
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 08",
        transcript: [{ calls: [{ name: "quick_book", arguments: { tickets: 2 } }] }, map],
      }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 08",
        transcript: [
          { calls: [{ name: "quick_book", arguments: { tickets: 2, seatPreference: "middle" } }] },
          map,
        ],
      }),
    ).toEqual(["Turn 0: usual-seat booking proceeded without verified context."]);
  });

  it.each(["time", "timeFrom", "timeTo"])(
    "rejects an invalid %s even when the recommendation mock succeeds",
    (field) => {
      const findings = auditSimulationEvidence({
        name: "Recommendation contract",
        transcript: [
          {
            tool_calls: [
              {
                name: "get_recommendations",
                arguments: { language: "English", date: "tonight", [field]: "tonight" },
              },
            ],
          },
          {
            tool_results: [
              { name: "get_recommendations", result: JSON.stringify({ ok: true, data: { movies: [] } }) },
            ],
          },
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(`${field}: HH:mm`);
    },
  );

  it("accepts actual HH:mm arguments and does not inject an unrelated dynamic clock", () => {
    expect(
      auditSimulationEvidence({
        name: "Recommendation contract",
        dynamic_variables: { time: "tonight", language: "not-a-film-language" },
        transcript: [
          {
            calls: [
              {
                name: "get_recommendations",
                arguments: { date: "tonight", time: "22:00", timeFrom: "20:00", timeTo: "23:00" },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({
        name: "Recommendation contract",
        dynamic_variables: { time: "tonight" },
        transcript: [{ calls: [{ name: "get_recommendations", arguments: { date: "tonight" } }] }],
      }),
    ).toEqual([]);
  });

  it("never replaces an invalid supplied clock with a dynamic value", () => {
    const findings = auditSimulationEvidence({
      name: "Recommendation contract",
      dynamic_variables: { time: "22:00" },
      transcript: [{ calls: [{ name: "get_recommendations", arguments: { time: "tonight" } }] }],
    });
    expect(findings[0]).toContain("time: HH:mm");
  });

  it("does not invent a missing required action argument from an unbound dynamic variable", () => {
    const findings = auditSimulationEvidence({
      name: "Payment contract",
      dynamic_variables: { userSessionId: "fixture_order" },
      transcript: [{ calls: [{ name: "prepare_payment", arguments: { method: "CARD" } }] }],
    });
    expect(findings[0]).toContain("userSessionId: Required");
  });

  it("rejects invented feedback in the thanks-only scenario even when a mock accepts it", () => {
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 13a — Concise English spoken response",
        transcript: [
          { tool_calls: [{ name: "submit_feedback", arguments: { rating: 5, resolved: true } }] },
          { tool_results: [{ name: "submit_feedback", result: JSON.stringify({ ok: true }) }] },
        ],
      }),
    ).toEqual(["Turn 0: feedback submitted without a guest-provided rating or resolution."]);
  });

  it("allows silent journey logging in the thanks-only scenario", () => {
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 13a",
        transcript: [
          { calls: [{ name: "log_journey", arguments: { journey: "movie_info", status: "completed" } }] },
        ],
      }),
    ).toEqual([]);
  });

  it("does not ban feedback in other scenarios that may explicitly collect a rating", () => {
    expect(
      auditSimulationEvidence({
        name: "Explicit guest feedback",
        transcript: [{ calls: [{ name: "submit_feedback", arguments: { rating: 4 } }] }],
      }),
    ).toEqual([]);
  });
});

describe("recommendation filters require earlier explicit guest evidence", () => {
  const weekendRequest = { role: "user", message: "Suggest something for Saturday 8 June 2030." };
  const recommend = (arguments_: Record<string, unknown>) => ({
    role: "agent",
    tool_calls: [{ name: "get_recommendations", arguments: arguments_ }],
  });
  const success = {
    role: "agent",
    tool_results: [
      {
        name: "get_recommendations",
        result: JSON.stringify({
          ok: true,
          data: { movies: [{ title: "Harbour Lights", time: "18:00" }] },
        }),
      },
    ],
  };

  it("rejects the exact provider-passed Saturday retry that invented 20:30", () => {
    // trun_7501m245xpdcecta3bapvnk4tgd0: the broad mock returned 18:00 despite this invalid filter.
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 12 — Saturday uses separate weekend history",
      transcript: [
        { role: "agent", message: "Hi Rahul, how can I help?" },
        weekendRequest,
        recommend({ kind: "movies", date: "2030-06-08", time: "20:30", limit: 1 }),
        success,
        { role: "agent", message: "Harbour Lights is showing at six in the evening." },
        { role: "user", message: "Why that time rather than my usual late evening?" },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(
      'Turn 2: get_recommendations.time="20:30" has no matching preceding explicit guest request',
    );
  });

  it.each([
    ["11", "Suggest something for Monday 3 June 2030.", "2030-06-03"],
    ["11", "Suggest something for Monday 3 June 2030.", "today"],
    ["12", weekendRequest.message, "2030-06-08"],
    ["12", weekendRequest.message, "saturday"],
  ])("accepts %s with its actual requested date %s / %s and omitted profile filters", (id, message, date) => {
    expect(
      auditSimulationEvidence({
        name: `VOX Enhancement ${id}`,
        transcript: [{ role: "user", message }, recommend({ date, limit: 1 }), success],
      }),
    ).toEqual([]);
  });

  it.each([
    ["time", "20:30"],
    ["timeFrom", "18:00"],
    ["timeTo", "23:00"],
    ["language", "Tamil"],
    ["cinemaId", "0004"],
    ["cinemaName", "Burjuman"],
    ["withChildren", true],
    ["withChildren", false],
    ["date", "2030-06-09"],
  ])("rejects an unrequested %s=%s even when profile hints and successful mocks agree", (field, value) => {
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 12",
      dynamic_variables: { language: "Tamil", cinemaId: "0004", time: "20:30" },
      transcript: [
        weekendRequest,
        {
          results: [
            {
              name: "get_session_context",
              value: {
                ok: true,
                data: { customer: { profile: { time: "20:30", cinemaId: "0004", language: "Tamil" } } },
              },
            },
          ],
        },
        recommend({ date: "saturday", [field]: value }),
        success,
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`get_recommendations.${field}=`);
  });

  it("accepts the explicit 4–6 pm window and rejects an additional invented clock", () => {
    const prefix = { role: "user", message: "Anything good today between 4 and 6 pm?" };
    const args = { date: "today", timeFrom: "16:00", timeTo: "18:00" };
    expect(
      auditSimulationEvidence({ name: "VOX Enhancement 02", transcript: [prefix, recommend(args), success] }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 02",
        transcript: [prefix, recommend({ ...args, time: "17:00" }), success],
      })[0],
    ).toContain('get_recommendations.time="17:00"');
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 02",
        transcript: [prefix, recommend({ ...args, timeTo: "19:00" }), success],
      })[0],
    ).toContain('get_recommendations.timeTo="19:00"');
  });

  it("accepts an explicit 10 pm override but does not fill other filters from history", () => {
    const prefix = { role: "user", message: "Anything around 10 pm tonight?" };
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 05",
        transcript: [prefix, recommend({ date: "tonight", time: "22:00" })],
      }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 05",
        transcript: [prefix, recommend({ date: "tonight", time: "21:00" })],
      })[0],
    ).toContain('get_recommendations.time="21:00"');
  });

  it("allows only the actually requested English film language or Mirdif cinema", () => {
    for (const [id, message, filters] of [
      ["03", "Show me an English movie for tonight.", { language: "English" }],
      ["04", "Anything at City Centre Mirdif tonight?", { cinemaName: "City Centre Mirdif" }],
      ["04", "Anything at City Centre Mirdif tonight?", { cinemaId: "0003" }],
    ] as const) {
      expect(
        auditSimulationEvidence({
          name: `VOX Enhancement ${id}`,
          transcript: [{ role: "user", message }, recommend({ date: "tonight", ...filters })],
        }),
      ).toEqual([]);
    }
  });

  it("does not confuse the language of an Arabic conversation with a requested film language", () => {
    const prefix = { role: "user", message: "اقترحي لي فيلم الليلة لو سمحتِ" };
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 13b",
        transcript: [prefix, recommend({ date: "tonight" })],
      }),
    ).toEqual([]);
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 13b",
        transcript: [prefix, recommend({ date: "tonight", language: "ar" }), success],
      })[0],
    ).toContain('get_recommendations.language="ar"');
  });

  it("requires the same explicit evidence for filmLanguage and the legacy language alias", () => {
    for (const field of ["filmLanguage", "language"]) {
      expect(
        auditSimulationEvidence({
          name: "VOX Enhancement 03",
          transcript: [
            { role: "user", message: "Show me an English movie for tonight." },
            recommend({ date: "tonight", [field]: "English" }),
          ],
        }),
      ).toEqual([]);
      const findings = auditSimulationEvidence({
        name: "VOX Enhancement 13b",
        transcript: [
          { role: "user", message: "اقترحي لي فيلم الليلة لو سمحتِ" },
          recommend({ date: "tonight", [field]: "ar" }),
          success,
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(`get_recommendations.${field}="ar"`);
    }
    const conflicting = auditSimulationEvidence({
      name: "VOX Enhancement 03",
      transcript: [
        { role: "user", message: "Show me an English movie for tonight." },
        recommend({ filmLanguage: "English", language: "Arabic" }),
      ],
    });
    expect(conflicting).toHaveLength(1);
    expect(conflicting[0]).toContain('get_recommendations.language="Arabic"');
  });

  it("accepts a reviewed explicit 20:30 request only after that exact user turn", () => {
    const request = { role: "user", message: "Please find a film for Saturday at 20:30." };
    const expectation = {
      source_turn: 0,
      user_message: request.message,
      filters: { date: "saturday", time: "20:30" },
    };
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 12",
        recommendation_filter_expectations: [expectation],
        transcript: [request, recommend({ date: "saturday", time: "20:30" }), success],
      }),
    ).toEqual([]);
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 12",
      recommendation_filter_expectations: [{ ...expectation, source_turn: 3 }],
      transcript: [weekendRequest, recommend({ date: "saturday", time: "20:30" }), success, request],
    });
    expect(findings[0]).toContain('get_recommendations.time="20:30"');
  });

  it("never treats an agent claim or a mismatched evidence quote as a guest instruction", () => {
    const message = "Please find a film for Saturday at 20:30.";
    for (const source of [
      { role: "agent", message },
      { role: "user", message: "Why not 20:30?" },
    ]) {
      const findings = auditSimulationEvidence({
        name: "VOX Enhancement 12",
        recommendation_filter_expectations: [
          { source_turn: 1, user_message: message, filters: { date: "saturday", time: "20:30" } },
        ],
        transcript: [weekendRequest, source, recommend({ date: "saturday", time: "20:30" }), success],
      });
      expect(findings.some((finding) => finding.includes('get_recommendations.time="20:30"'))).toBe(true);
    }
  });

  it("revokes an earlier allowed clock when the guest rejects it instead of mining the number from the negation", () => {
    const message = "Please find a film for Saturday at 20:30.";
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 12",
      recommendation_filter_expectations: [
        { source_turn: 0, user_message: message, filters: { date: "saturday", time: "20:30" } },
        {
          source_turn: 3,
          user_message: "Not 20:30. Use my usual Saturday timing instead.",
          filters: { date: "saturday" },
        },
      ],
      transcript: [
        { role: "user", message },
        recommend({ date: "saturday", time: "20:30" }),
        success,
        { role: "user", message: "Not 20:30. Use my usual Saturday timing instead." },
        recommend({ date: "saturday", time: "20:30" }),
        success,
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('Turn 4: get_recommendations.time="20:30"');
  });

  it("does not transfer a prior account's explicit filter or accept missing user evidence", () => {
    const message = "Please find a film for Saturday at 20:30.";
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 12",
      recommendation_filter_expectations: [
        { source_turn: 0, user_message: message, filters: { time: "20:30" } },
      ],
      transcript: [
        { role: "user", message, session_epoch: 0 },
        { ...recommend({ time: "20:30" }), session_epoch: 1 },
      ],
    });
    expect(findings).toEqual([
      "Turn 1: recommendation has no preceding user request in the current session.",
    ]);
    expect(
      auditSimulationEvidence({ name: "VOX Enhancement 12", transcript: [recommend({ time: "20:30" })] }),
    ).toEqual(["Turn 0: recommendation has no preceding user request in the current session."]);
  });

  it("does not authorize Saturday from the scenario name when the guest asks for Sunday", () => {
    const correction = {
      role: "user",
      message: "Not Saturday. Please suggest a movie for Sunday 9 June 2030.",
    };
    for (const prefix of [
      [correction],
      [weekendRequest, recommend({ date: "saturday" }), success, correction],
    ]) {
      const findings = auditSimulationEvidence({
        name: "VOX Enhancement 12",
        transcript: [...prefix, recommend({ date: "2030-06-08", limit: 1 }), success],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('get_recommendations.date="2030-06-08"');
    }
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 12",
        recommendation_filter_expectations: [
          { source_turn: 0, user_message: correction.message, filters: { date: "2030-06-09" } },
        ],
        transcript: [correction, recommend({ date: "2030-06-09" }), success],
      }),
    ).toEqual([]);
  });
});

describe("raw provider evidence and card-prefix provenance", () => {
  const rawCall = (tool_name: string, args: Record<string, unknown>) => ({
    tool_name,
    params_as_json: JSON.stringify(args),
  });
  const rawResult = (tool_name: string, value: unknown, is_error = false) => ({
    tool_name,
    result_value: JSON.stringify(value),
    is_error,
  });
  const binCall = { tool_calls: [rawCall("list_offers", { bank: "Fixture Bank", cardBin: "455533" })] };

  it("reads raw food calls/results directly and preserves exact-item lookup checks", () => {
    const transcript = [
      { tool_results: [rawResult("suggest_fnb", menu.results[0]?.value)] },
      { tool_calls: [rawCall("add_concessions", add.calls[0]!.arguments)] },
      { tool_results: [rawResult("add_concessions", added.results[0]?.value)] },
    ];
    expect(auditSimulationEvidence({ name: "VOX Enhancement 06a", transcript })).toEqual([]);
    transcript[1] = {
      tool_calls: [
        rawCall("add_concessions", {
          userSessionId: "fixture_order",
          items: [{ itemId: "popcorn_salted", quantity: 1 }],
        }),
      ],
    };
    const findings = auditSimulationEvidence({ name: "VOX Enhancement 06a", transcript });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("exactly FIX_POPCORN quantity 1");
    expect(findings[1]).toContain("before a matching menu/suggestion result");
  });

  it("reads a real raw seat-map result instead of accepting or rejecting spoken claims", () => {
    expect(
      auditSimulationEvidence({
        name: "VOX Enhancement 08",
        transcript: [
          {
            tool_calls: [
              rawCall("get_seat_plan", { sessionKey: "0002-fixture", userSessionId: "fixture_order" }),
            ],
          },
          { tool_results: [rawResult("get_seat_plan", { ok: true, data: { currentSeats: ["F8", "F9"] } })] },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    {},
    { tool_name: "" },
    { name: "get_recommendations", tool_name: "list_offers", arguments: {} },
    { tool_name: "get_recommendations" },
    { tool_name: "get_recommendations", params_as_json: "{" },
    { tool_name: "get_recommendations", params_as_json: "null" },
    { tool_name: "get_recommendations", params_as_json: "[]" },
    { tool_name: "get_recommendations", params_as_json: '"time=22:00"' },
    { name: "get_recommendations", arguments: null },
    { tool_name: "get_recommendations", params_as_json: "{}", tool_has_been_called: false },
  ])("fails closed on uninspectable or conflicting call evidence: %j", (call) => {
    expect(
      auditSimulationEvidence({ name: "Raw evidence", transcript: [{ tool_calls: [call] }] }).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    {},
    { tool_name: "get_recommendations" },
    { name: "get_recommendations", tool_name: "list_offers", result: {} },
    { tool_name: "get_recommendations", result_value: "not json" },
    { tool_name: "get_recommendations", result_value: "null" },
    { tool_name: "get_recommendations", result_value: "[]" },
  ])("fails closed on missing or unstructured results: %j", (result) => {
    expect(
      auditSimulationEvidence({
        name: "Raw evidence",
        transcript: [{ tool_calls: [rawCall("get_recommendations", {})] }, { tool_results: [result] }],
      }),
    ).toHaveLength(1);
  });

  it("keeps server contract and unexpected-mock checks active for raw calls", () => {
    const findings = auditSimulationEvidence({
      name: "Raw evidence",
      transcript: [
        { tool_calls: [rawCall("get_recommendations", { time: "tonight" })] },
        {
          tool_results: [
            rawResult(
              "get_recommendations",
              { ok: false, error: { code: "UNEXPECTED_SIMULATION_TOOL" } },
              true,
            ),
          ],
        },
      ],
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("time: HH:mm");
    expect(findings[1]).toContain("no permitted mock");
  });

  it("rejects the raw initial09b invented BIN despite a bank name, last4 and offer prefix rules", () => {
    const findings = auditSimulationEvidence({
      name: "VOX Enhancement 09b",
      transcript: [
        {
          role: "user",
          message: "Can my saved Fixture Bank card use buy one get one for the two tickets in this basket?",
        },
        {
          tool_results: [
            rawResult("get_session_context", {
              ok: true,
              data: { customer: { savedCards: [{ brand: "Visa", last4: "1234" }] } },
            }),
          ],
        },
        {
          tool_results: [
            rawResult("list_offers", { ok: true, data: { offers: [{ rules: { bankBins: ["455533"] } }] } }),
          ],
        },
        binCall,
        { tool_results: [rawResult("list_offers", { ok: true })] },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("list_offers.cardBin has no preceding explicit guest declaration");
  });

  it.each(["My card BIN is 455533.", "BIN: 455533", "The first six digits of my card are 455533."])(
    "accepts an exact preceding guest declaration: %s",
    (message) => {
      expect(
        auditSimulationEvidence({ name: "Explicit BIN", transcript: [{ role: "user", message }, binCall] }),
      ).toEqual([]);
    },
  );

  it.each([
    { role: "agent", message: "My card BIN is 455533." },
    { role: "user", message: "My card BIN is not 455533." },
    { role: "user", message: "Is my card BIN 455533?" },
    { role: "user", message: "My Fixture Bank card ends 5533." },
    { role: "user", message: "My card BIN is 455534." },
  ])("does not guess a prefix from a claim, negation, question, last4 or different BIN: %j", (prefix) => {
    expect(auditSimulationEvidence({ name: "Explicit BIN", transcript: [prefix, binCall] })[0]).toContain(
      "cardBin has no preceding",
    );
  });

  it("does not accept a future declaration or one from a revoked session", () => {
    const declaration = { role: "user", message: "My card BIN is 455533." };
    expect(
      auditSimulationEvidence({ name: "Explicit BIN", transcript: [binCall, declaration] })[0],
    ).toContain("cardBin has no preceding");
    expect(
      auditSimulationEvidence({
        name: "Explicit BIN",
        transcript: [
          { ...declaration, session_epoch: 0 },
          { ...binCall, session_epoch: 1 },
        ],
      })[0],
    ).toContain("cardBin has no preceding");
  });

  it("accepts a prefix returned in successful actual card data, never from a failed or future result", () => {
    const value = { ok: true, data: { customer: { savedCards: [{ first6: "455533" }] } } };
    const result = { tool_results: [rawResult("get_session_context", value)] };
    expect(auditSimulationEvidence({ name: "Card data", transcript: [result, binCall] })).toEqual([]);
    expect(auditSimulationEvidence({ name: "Card data", transcript: [binCall, result] })[0]).toContain(
      "cardBin has no preceding",
    );
    expect(
      auditSimulationEvidence({
        name: "Card data",
        transcript: [{ tool_results: [rawResult("get_session_context", value, true)] }, binCall],
      }).some((finding) => finding.includes("cardBin has no preceding")),
    ).toBe(true);
    expect(
      auditSimulationEvidence({
        name: "Card data",
        transcript: [{ tool_results: [rawResult("get_session_context", { ...value, ok: false })] }, binCall],
      })[0],
    ).toContain("cardBin has no preceding");
  });

  it.each([{ is_blocked: true }, { tool_has_been_called: false }])(
    "rejects blocked or unexecuted raw results as card and seat-map evidence: %j",
    (flag) => {
      const findings = auditSimulationEvidence({
        name: "VOX Enhancement 08",
        transcript: [
          {
            tool_results: [
              { ...rawResult("get_session_context", { ok: true, data: { cardBin: "455533" } }), ...flag },
            ],
          },
          binCall,
          { tool_results: [{ ...rawResult("get_seat_plan", { ok: true }), ...flag }] },
        ],
      });
      expect(findings.some((finding) => finding.includes("cannot establish success"))).toBe(true);
      expect(findings.some((finding) => finding.includes("cardBin has no preceding"))).toBe(true);
      expect(findings).toContain(
        "No successful seat-map tool result; a spoken display claim is insufficient.",
      );
    },
  );
});
