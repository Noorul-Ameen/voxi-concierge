import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildBalanceContinuationSuite } from "../src/balance-continuation-simulations.js";
import { buildChildClassificationSuite } from "../src/child-classification-simulations.js";
import { buildAgentConfig } from "../src/index.js";
import { buildProposalEditSuite } from "../src/proposal-edit-simulations.js";
import { materializeSimulations } from "../src/simulations.js";
import { buildUiAcknowledgementSuite } from "../src/ui-acknowledgement-simulations.js";

describe("verified UI acknowledgement regression fixtures", () => {
  const clock = "2026-09-14T12:00:00+04:00";
  const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
    name,
    id: `fixture_${name}`,
  }));

  it("binds each VOX split and rejected SHARE correction to the exact balance and cents without executing payment", () => {
    const tests = materializeSimulations(buildBalanceContinuationSuite(clock), tools);
    expect(tests).toHaveLength(4);
    for (const test of tests) {
      const redemption = test.body.tool_mock_overrides.fixture_redeem_points;
      const allowed = redemption.filter((mock) => !mock.is_error);
      expect(allowed).toHaveLength(test.id.includes("correct-share") ? 2 : 1);
      for (const mock of allowed)
        expect(mock.parameter_conditions.some((condition) => condition.path === "balanceType")).toBe(true);
      const vox = allowed.at(-1)!;
      expect(vox.parameter_conditions).toContainEqual({
        path: "amountCents",
        eval: { type: "exact", expected_value: "12000" },
      });
      expect(JSON.parse(vox.mock_result).data.result.balancePayment).toMatchObject({
        method: "VOX_CREDIT",
        amountCents: 12000,
        remainingCents: 2550,
      });
      expect(test.body.tool_mock_overrides.fixture_pay_order.every((mock) => mock.is_error)).toBe(true);
      expect(test.body.tool_mock_overrides.fixture_quick_book.every((mock) => mock.is_error)).toBe(true);
      expect(redemption.at(-1)?.is_error).toBe(true);
      if (test.id.includes("correct-share"))
        expect(JSON.parse(allowed[0]!.mock_result).data.result.nextPaymentMethod).toBeNull();
    }
  });

  it("covers every member and a guest in both languages with bounded non-executing controls", () => {
    const suite = buildUiAcknowledgementSuite(clock);
    expect(suite.fixture.clock_local).toBe(clock);
    const tests = materializeSimulations(suite, tools);
    expect(tests).toHaveLength(10);
    for (const persona of ["Sara", "Rahul", "James", "Layla"])
      for (const language of ["en", "ar"])
        expect(tests.some((test) => test.body.name.includes(`${persona} ${language}`))).toBe(true);
    for (const test of tests) {
      expect(test.body.tool_mock_config).toMatchObject({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
      });
      for (const [id, mocks] of Object.entries(test.body.tool_mock_overrides))
        if (id !== "fixture_get_session_context") expect(mocks.every((mock) => mock.is_error)).toBe(true);
      expect(test.body.simulation_max_turns).toBe(2);
      expect(test.body.simulation_scenario).not.toContain("2030");
    }
    expect(() => buildUiAcknowledgementSuite("tomorrow")).toThrow("current Dubai");
  });

  it("distinguishes completed, pending, failed and unsubmitted events instead of fabricating consent", () => {
    const tests = buildUiAcknowledgementSuite(clock).tests;
    const event = (key: string) => {
      const history = tests.find((test) => test.id === `ui-${key}-en`)!.chat_history;
      const scenario = (history.at(-1) as { message: string }).message;
      const json = scenario.split("User interface updates: ")[1]!.split(". Briefly acknowledge")[0]!;
      return JSON.parse(json);
    };
    expect(event("paid")).toMatchObject({ action: "payment.token", succeeded: true, pending: false });
    expect(event("reheld")).toMatchObject({ action: "order.recover", succeeded: true, pending: false });
    expect(event("pending")).toMatchObject({ succeeded: false, pending: true });
    expect(event("failed")).toMatchObject({ succeeded: false, pending: false });
    expect(event("selection")).toMatchObject({
      succeeded: false,
      state: { selection: { status: "unsubmitted" } },
    });
    expect(JSON.stringify(event("pending"))).not.toContain("actionId");
  });

  it("keeps provisional and unknown child classifications strict and rejects invented rating parameters", () => {
    const suite = buildChildClassificationSuite(clock, {
      title: "Red Flag",
      hoCode: "HO00013575",
      rating: "18TC",
    });
    const tests = materializeSimulations(suite, tools);
    expect(tests).toHaveLength(6);
    for (const test of tests) {
      const age = test.body.tool_mock_overrides.fixture_get_age_rules;
      expect(age[0].parameter_conditions).toContainEqual({
        path: "childAge",
        eval: { type: "exact", expected_value: "7" },
      });
      const expectedAllowed = test.id.includes("accompanied-child")
        ? true
        : test.id.includes("known-restriction")
          ? false
          : null;
      expect(JSON.parse(age[0].mock_result).data.allowed).toBe(expectedAllowed);
      expect(age.at(-1)?.is_error).toBe(true);
      expect(test.body.tool_mock_overrides.fixture_quick_book.every((mock) => mock.is_error)).toBe(true);
      expect(test.body.tool_mock_overrides.fixture_propose_booking.every((mock) => mock.is_error)).toBe(true);
    }
    expect(() =>
      buildChildClassificationSuite(clock, { title: "Red Flag", hoCode: "HO00013575", rating: "PG" }),
    ).toThrow("actual 18TC");
  });

  it("grounds language in guest dialogue and keeps guest identity separate from member preferences", () => {
    const tests = buildUiAcknowledgementSuite(clock).tests;
    for (const test of tests) {
      const turn = test.chat_history[2] as { tool_results: { result_value: string }[] };
      const context = JSON.parse(turn.tool_results[0]!.result_value).data;
      if (test.name.includes("Layla")) {
        expect(context).toMatchObject({ isLoggedIn: false, customer: null });
        expect(test.dynamic_variables.firstName).toBe("");
      } else {
        expect(context.customer.preferredLanguage).not.toBe(test.dynamic_variables.language);
      }
    }
    const config = buildAgentConfig({
      conciergeUrl: "https://fixture.invalid",
      toolSecretHeader: { secret_id: "fixture" },
    });
    expect(config.platform_settings.data_collection.language_used.description).toContain(
      "substantive spoken or typed sentences",
    );
    expect(config.platform_settings.data_collection.language_used.description).toContain("unknown");
    const consent = config.platform_settings.evaluation.criteria.find(
      (criterion) => criterion.id === "confirmation_before_action",
    )!.conversation_goal_prompt;
    expect(consent).toContain("Opening a payment review is not charging");
    expect(consent).toContain("pending/failed events");
    expect(consent).toContain("Changed terms require fresh consent");
  });

  it("preserves captured proposal terms and denies unaccepted financial actions after a time edit", () => {
    const common = {
      filmTitle: "Spider-Man: Brand New Day",
      hoCode: "HO00013065",
      cinemaId: "0002",
      cinemaName: "Mall of the Emirates",
      date: "2026-09-15",
      tickets: 1,
      childTickets: 1,
    };
    const initial = {
      ...common,
      sessionKey: "0002-628865",
      showtime: "2026-09-15T23:00:00",
      experience: "KIDS",
      seats: [
        { row: "E", number: "9" },
        { row: "E", number: "10" },
      ],
      totalCents: 7550,
      total: "AED 75.50",
    };
    const revised = {
      ...common,
      sessionKey: "0002-629100",
      showtime: "2026-09-15T18:30:00",
      experience: "Premier",
      seats: [
        { row: "E", number: "6" },
        { row: "E", number: "7" },
      ],
      totalCents: 10850,
      total: "AED 108.50",
    };
    const tests = materializeSimulations(buildProposalEditSuite(clock, initial, revised), tools);
    expect(tests).toHaveLength(2);
    for (const test of tests) {
      const searches = test.body.tool_mock_overrides.fixture_search_sessions.filter((mock) => !mock.is_error);
      expect(
        searches.some((mock) =>
          mock.parameter_conditions.some((condition) => condition.path === "cinemaName"),
        ),
      ).toBe(true);
      const previews = test.body.tool_mock_overrides.fixture_propose_booking
        .filter((entry) => !entry.is_error)
        .map((entry) => JSON.parse(entry.mock_result));
      expect(previews[0].data.proposal).toMatchObject({
        experience: "Premier",
        totalCents: 10850,
        held: false,
      });
      expect(previews.at(-1)?.data.proposal).toMatchObject({
        experience: "KIDS",
        totalCents: 7550,
        held: false,
      });
      expect(test.body.tool_mock_overrides.fixture_quick_book.every((entry) => entry.is_error)).toBe(true);
      for (const entry of test.body.tool_mock_overrides.fixture_propose_booking.filter(
        (mock) => !mock.is_error,
      )) {
        expect(entry.parameter_conditions).toContainEqual({
          path: "tickets",
          eval: { type: "exact", expected_value: "1" },
        });
        expect(entry.parameter_conditions).toContainEqual({
          path: "childTickets",
          eval: { type: "exact", expected_value: "1" },
        });
      }
    }
    expect(() => buildProposalEditSuite(clock, initial, { ...revised, cinemaId: "another_cinema" })).toThrow(
      "same-film/site",
    );
  });
});
