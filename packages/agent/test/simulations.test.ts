import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { loadSimulationSuite, materializeSimulations } from "../src/simulations.js";

const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  id: `fixture_id_${name}`,
  name,
}));

describe("ElevenLabs synthetic simulation preparation", () => {
  it("covers all 13 acceptance groups with 17 bounded, runnable variants", () => {
    const suite = loadSimulationSuite();
    const tests = materializeSimulations(suite, tools);
    expect(tests).toHaveLength(17);
    expect(new Set(tests.map((test) => test.scenario_group)).size).toBe(13);
    for (const { body } of tests) {
      expect(body.simulation_max_turns).toBeGreaterThanOrEqual(2);
      expect(body.simulation_max_turns).toBeLessThanOrEqual(5);
      expect(body.success_conditions.length).toBeGreaterThanOrEqual(4);
      expect(body.tool_mock_overrides.fixture_id_get_session_context).toBeDefined();
      expect(body).not.toHaveProperty("id");
      expect(body).not.toHaveProperty("scenario_group");
    }
  });

  it("mocks every attached tool and blocks unmatched parameters or newly attached tools", () => {
    const tests = materializeSimulations(loadSimulationSuite(), [
      ...tools,
      { id: "new_tool", name: "future_tool" },
    ]);
    for (const { body } of tests) {
      expect(body.tool_mock_config.mocking_strategy).toBe("all");
      expect(body.tool_mock_config.fallback_strategy).toBe("raise_error");
      expect(Object.keys(body.tool_mock_overrides).sort()).toEqual(
        [...tools.map((tool) => tool.id), "new_tool"].sort(),
      );
      const unplanned = body.tool_mock_overrides.new_tool[0];
      expect(unplanned.is_error).toBe(true);
      expect(JSON.parse(unplanned.mock_result).error.code).toBe("UNEXPECTED_SIMULATION_TOOL");
      for (const responses of Object.values(body.tool_mock_overrides)) {
        expect(responses.some((response) => response.parameter_conditions.length === 0)).toBe(true);
      }
    }
    const timeWindow = tests.find((test) => test.id === "02")!;
    const responses = timeWindow.body.tool_mock_overrides.fixture_id_get_recommendations;
    expect(responses[0].parameter_conditions.map((condition) => condition.path)).toEqual([
      "timeFrom",
      "timeTo",
    ]);
    expect(responses.at(-1)!.is_error).toBe(true);
  });

  it("rejects partial, ambiguous and unsafe inputs before producing upload bodies", () => {
    expect(() => materializeSimulations(loadSimulationSuite(), tools.slice(1))).toThrow(
      "Missing attached tool",
    );
    expect(() => materializeSimulations(loadSimulationSuite(), [...tools, tools[0]])).toThrow("unique");
    const unsafe = loadSimulationSuite();
    Object.assign(unsafe.tests[0].tool_mock_config, { fallback_strategy: "call_real_tool" });
    expect(() => materializeSimulations(unsafe, tools)).toThrow("Unsafe");
    const missing = loadSimulationSuite();
    const { cancel_booking: _cancel, ...remainingMocks } = missing.common_tool_mock_overrides;
    missing.common_tool_mock_overrides = remainingMocks;
    expect(() => materializeSimulations(missing, tools)).toThrow("Missing common mock");
  });

  it("keeps booking and recovery consent assertions and avoids fixtures granting payment approval", () => {
    const tests = materializeSimulations(loadSimulationSuite(), tools);
    const booking = tests.find((test) => test.id === "06a")!;
    expect(booking.body.tool_mock_overrides.fixture_id_pay_order.every((mock) => mock.is_error)).toBe(true);
    const recovery = tests.find((test) => test.id === "10b")!;
    const recoverMocks = recovery.body.tool_mock_overrides.fixture_id_recover_order;
    expect(recoverMocks[0].parameter_conditions).toEqual([
      { path: "confirmed", eval: { type: "exact", expected_value: "true" } },
    ]);
    expect(recoverMocks.at(-1)!.is_error).toBe(true);
    const bankCases = tests.filter((test) => test.scenario_group === "09-bank-offer");
    expect(bankCases).toHaveLength(2);
    expect(JSON.stringify(bankCases)).toContain("ticketCount");
    const percentOffer = bankCases.find((test) => test.id === "09a")!;
    expect(JSON.parse(percentOffer.body.tool_mock_overrides.fixture_id_suggest_fnb[0].mock_result).ok).toBe(
      true,
    );
    for (const name of ["order_fnb", "add_concessions", "prepare_payment", "pay_order"]) {
      expect(percentOffer.body.tool_mock_overrides[`fixture_id_${name}`].every((mock) => mock.is_error)).toBe(
        true,
      );
    }
    expect(
      tests
        .find((test) => test.id === "13a")!
        .body.tool_mock_overrides.fixture_id_submit_feedback.every((mock) => mock.is_error),
    ).toBe(true);
    for (const { body } of tests) {
      const session = JSON.parse(body.tool_mock_overrides.fixture_id_get_session_context[0].mock_result);
      expect(session.data.isLoggedIn).toBe(true);
      expect(session.data.customer.id).toMatch(/^fixture_/);
      expect(JSON.stringify(session)).not.toMatch(/password|paymentToken|cardBin/i);
    }
  });

  it("uses supported primitive food conditions and requires a separate exact-item trace audit", () => {
    const booking = materializeSimulations(loadSimulationSuite(), tools).find((test) => test.id === "06a")!;
    const mocks = booking.body.tool_mock_overrides.fixture_id_add_concessions;
    expect(mocks[0].parameter_conditions).toEqual([
      { path: "userSessionId", eval: { type: "exact", expected_value: "fixture_order" } },
    ]);
    expect(mocks.at(-1)!.is_error).toBe(true);
    expect(JSON.parse(mocks[0].mock_result).data.action.status).toBe("queued");
    expect(booking.body.tool_mock_overrides.fixture_id_get_action_result[0].parameter_conditions).toEqual([
      { path: "actionId", eval: { type: "exact", expected_value: "fixture_food_action" } },
    ]);
    expect(booking.body.success_conditions.join(" ")).toContain("independent saved-trace audit");
  });

  it("blocks invented contact details while accepting either generic payment-sheet opening", () => {
    const booking = materializeSimulations(loadSimulationSuite(), tools).find((test) => test.id === "06a")!;
    const mocks = booking.body.tool_mock_overrides.fixture_id_prepare_payment;
    expect(mocks[0].is_error).toBe(true);
    expect(mocks[0].parameter_conditions[0].path).toBe("customer");
    const contactCondition = mocks[0].parameter_conditions[0].eval;
    if (contactCondition.type !== "regex") throw new Error("Contact override must fail closed");
    expect(
      new RegExp(contactCondition.pattern).test(JSON.stringify({ email: "invented@example.invalid" })),
    ).toBe(true);
    for (const method of ["CARD", "SAVED_CARD"]) {
      const mock = mocks.find(
        (candidate) =>
          !candidate.is_error &&
          candidate.parameter_conditions.some(
            (condition) =>
              condition.path === "method" &&
              condition.eval.type === "exact" &&
              condition.eval.expected_value === method,
          ),
      )!;
      expect(mock).toBeDefined();
      const result = JSON.parse(mock.mock_result);
      expect(result.data.summary.method).toBe(method);
      expect(result.data.summary.amountCents).toBe(12000);
      expect(result.ui.meta.savedCards[0].token).toBe(result.ui.meta.preferredToken);
      expect(result.ui.meta.savedCards[0].default).toBe(true);
    }
    expect(mocks.at(-1)!.is_error).toBe(true);
  });

  it("accepts equivalent fixed-clock dates without accepting a different weekday", () => {
    const weekday = loadSimulationSuite().tests.find((test) => test.id === "11")!;
    const condition = weekday.tool_mock_overrides.get_recommendations[0].parameter_conditions[0].eval;
    if (condition.type !== "regex") throw new Error("Expected bounded date alternatives");
    const date = new RegExp(condition.pattern.replace("(?i)", ""), "i");
    for (const value of ["2030-06-03", "Monday", "today"]) expect(date.test(value)).toBe(true);
    for (const value of ["tomorrow", "Saturday", "2030-06-08"]) expect(date.test(value)).toBe(false);
    expect(weekday.success_conditions.join(" ")).toContain("weekday");
  });
});
