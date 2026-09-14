import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildAreaSimulationSuite } from "../src/area-simulations.js";
import { type SimulationMock, materializeSimulations } from "../src/simulations.js";

const clock = "2026-09-14T12:00:00+04:00";
const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  name,
  id: `fixture_${name}`,
}));
function resolve(mocks: SimulationMock[], args: Record<string, unknown>) {
  const match = mocks.find((mock) =>
    mock.parameter_conditions.every(({ path, eval: rule }) => {
      const value = args[path];
      if (value === undefined) return false;
      return rule.type === "exact"
        ? String(value) === rule.expected_value
        : new RegExp(rule.pattern).test(String(value));
    }),
  );
  if (!match) throw new Error("No mock matched");
  return { ...JSON.parse(match.mock_result), transportError: match.is_error };
}

describe("guest named-area conversation fixtures", () => {
  const tests = materializeSimulations(buildAreaSimulationSuite(clock), tools);

  it("contains six unique EN/AR cases with every external tool mocked and business/GPS calls denied", () => {
    expect(tests).toHaveLength(6);
    expect(new Set(tests.map((test) => test.id)).size).toBe(6);
    for (const { body } of tests) {
      expect(body.tool_mock_config).toMatchObject({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
      });
      expect(body.tool_mock_config.mocked_tool_ids).toHaveLength(tools.length);
      for (const [name, mocks] of Object.entries(body.tool_mock_overrides))
        if (!["fixture_get_session_context", "fixture_nearest_cinemas"].includes(name))
          expect(mocks.every((mock) => mock.is_error)).toBe(true);
      const context = resolve(body.tool_mock_overrides.fixture_get_session_context!, {});
      expect(context.data).toMatchObject({ isLoggedIn: false, customer: null, activeOrder: null });
      expect(body.dynamic_variables.customerId).toBe("");
    }
  });

  it("requires the supplied area and grounds both guest/no-GPS and old-GPS replies in the same result", () => {
    for (const language of ["en", "ar"]) {
      const a = tests.find((test) => test.id === `area-supplied-guest-${language}`)!.body;
      const b = tests.find((test) => test.id === `area-overrides-gps-${language}`)!.body;
      expect(resolve(a.tool_mock_overrides.fixture_get_session_context!, {}).data.hasLocation).toBe(false);
      expect(resolve(b.tool_mock_overrides.fixture_get_session_context!, {}).data).toMatchObject({
        hasLocation: true,
        location: "Previously shared GPS in Ras Al Khaimah",
      });
      for (const area of ["Al Barsha", "البرشاء"]) {
        const one = resolve(a.tool_mock_overrides.fixture_nearest_cinemas!, { area });
        expect(one).toEqual(resolve(b.tool_mock_overrides.fixture_nearest_cinemas!, { area }));
        expect(one.data.origin).toMatchObject({
          source: "named_area",
          approximate: true,
          lat: 25.1181,
          lng: 55.2004,
          distanceMethod: "straight_line",
        });
        expect(one.data.cinemas.map((cinema: { cinemaId: string }) => cinema.cinemaId)).toEqual([
          "0002",
          "0045",
          "0049",
        ]);
        expect(one.ui.items).toEqual(one.data.cinemas);
        expect(one.ui.meta.origin).toEqual(one.data.origin);
      }
      expect(
        resolve(a.tool_mock_overrides.fixture_nearest_cinemas!, { area: "Al Barsha", limit: 1 }).data.cinemas,
      ).toHaveLength(1);
      for (const args of [
        {},
        { area: "Ras Al Khaimah" },
        { area: "Al Barsha", experience: "IMAX" },
        { area: "Al Barsha", lat: 1 },
        { area: "Al Barsha", limit: 5 },
      ])
        expect(resolve(a.tool_mock_overrides.fixture_nearest_cinemas!, args).transportError).toBe(true);
    }
  });

  it("returns the actual unsupported-area domain failure without permitting silent GPS fallback", () => {
    for (const test of tests.filter((test) => test.id.includes("unsupported"))) {
      const mocks = test.body.tool_mock_overrides.fixture_nearest_cinemas!;
      for (const area of ["Unknown Barsha Hills", "تلال البرشاء غير المعروفة", "تلال البرشاء"]) {
        const result = resolve(mocks, { area });
        expect(result).toMatchObject({
          ok: false,
          transportError: false,
          error: { code: "LOCATION_REQUIRED", retryable: false },
          data: { requestedArea: area, needs: "supported_area" },
        });
        expect(result.data.supportedAreas).toContainEqual({
          label: "Al Barsha",
          labelAr: "البرشاء",
          group: "Dubai",
        });
        expect(result.error.message).toContain(area);
        expect(result.error.message).toContain(
          test.id.endsWith("-ar") ? "لم أتمكن من مطابقة" : "I couldn't match",
        );
        expect(result.data.cinemas).toBeUndefined();
        expect(result.ui).toBeUndefined();
      }
      expect(resolve(mocks, {}).transportError).toBe(true);
      expect(resolve(mocks, { area: "Al Barsha" }).transportError).toBe(true);
      expect(resolve(mocks, { area: "البرشاء" }).transportError).toBe(true);
    }
  });

  it("requires an explicit Dubai clock instead of introducing an old fixture date", () => {
    expect(() => buildAreaSimulationSuite("2030-06-03")).toThrow("Dubai local clock");
    expect(buildAreaSimulationSuite(clock).fixture.clock_local).toBe(clock);
  });
});
