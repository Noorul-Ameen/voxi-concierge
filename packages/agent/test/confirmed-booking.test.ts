import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildConfirmedBookingSuite } from "../src/confirmed-booking-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  name,
  id: `fixture_${name}`,
}));
const clock = "2026-12-31T23:59:59+04:00";

describe("reference-less confirmed-booking regression fixtures", () => {
  it("reproduces a signed-in account with no unfinished checkout, without feeding a reference or a second account-lookup instruction", () => {
    const suite = buildConfirmedBookingSuite(clock);
    expect(suite.tests.map((test) => test.id)).toEqual(["confirmed-booking-en", "confirmed-booking-ar"]);
    for (const test of suite.tests) {
      const context = JSON.parse(test.tool_mock_overrides.get_session_context![0]!.mock_result);
      expect(context.data).toMatchObject({
        isLoggedIn: true,
        customer: { id: "fixture_rahul", firstName: "Rahul" },
        activeOrder: null,
      });
      expect(test.chat_history).toHaveLength(2);
      expect(JSON.stringify(test.chat_history)).not.toContain("FIXRAH");
      expect(test.simulation_scenario).toContain(
        test.id.endsWith("-ar")
          ? "أود إجراء تغييرات على حجزي الحالي."
          : "I would like to make changes to my current booking.",
      );
      expect(test.success_conditions.join(" ")).toContain("call list_my_bookings");
      expect(test.success_conditions.join(" ")).toContain("before asking for a booking reference");
    }
  });

  it("returns current-clock future confirmed records and the same owned cards, including across a year boundary", () => {
    for (const test of buildConfirmedBookingSuite(clock).tests) {
      const result = JSON.parse(test.tool_mock_overrides.list_my_bookings![0]!.mock_result);
      expect(result.data.bookings).toHaveLength(2);
      expect(result.ui.items).toEqual(result.data.bookings);
      expect(result.data.bookings.map((booking: { showtime: string }) => booking.showtime)).toEqual([
        "2027-01-01T20:00:00+04:00",
        "2027-01-02T18:25:00+04:00",
      ]);
      expect(
        new Set(result.data.bookings.map((booking: { bookingId: string }) => booking.bookingId)).size,
      ).toBe(2);
      for (const booking of result.data.bookings) {
        expect(booking).toMatchObject({ status: "confirmed", verified: true, refundedCents: 0 });
        expect(
          result.ui.actions.some(
            (action: { value: string }) => action.value === `booking:${booking.bookingId}`,
          ),
        ).toBe(true);
        expect(booking).not.toHaveProperty("expiresAtUtc");
        expect(booking).not.toHaveProperty("qrPayload");
      }
      expect(JSON.stringify(result)).not.toMatch(/JYRAHL1|WKGRP33|password|cardToken|email|phone/i);
    }
  });

  it("fails closed for every non-lookup tool and keeps every attached tool mocked after materialization", () => {
    const tests = materializeSimulations(buildConfirmedBookingSuite(clock), tools);
    expect(tests).toHaveLength(2);
    for (const test of tests) {
      expect(test.body.tool_mock_config).toEqual({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
        mocked_tool_ids: tools.map((tool) => tool.id),
      });
      expect(Object.keys(test.body.tool_mock_overrides)).toHaveLength(tools.length);
      for (const [id, mocks] of Object.entries(test.body.tool_mock_overrides)) {
        const lookup = ["fixture_get_session_context", "fixture_list_my_bookings"].includes(id);
        expect(mocks.every((mock) => mock.is_error)).toBe(!lookup);
        if (!lookup) for (const mock of mocks) expect(JSON.parse(mock.mock_result).ok).toBe(false);
      }
      expect(test.body.simulation_max_turns).toBe(2);
      expect(test.body.success_conditions.join(" ")).toContain(
        "No change, cancellation, refund or new booking may be claimed",
      );
      expect(test.body.simulation_scenario).toContain("Do not select a booking");
    }
  });

  it.each(["tomorrow", "2026-02-30T12:00:00+04:00", "2026-09-14T25:00:00+04:00", "2026-09-14T12:00:00Z"])(
    "rejects an invalid or non-Dubai clock: %s",
    (invalid) => {
      expect(() => buildConfirmedBookingSuite(invalid)).toThrow(/Dubai/);
    },
  );

  it("accepts the existing zone-less Dubai clock format without using the machine's timezone", () => {
    const withZone = buildConfirmedBookingSuite("2026-09-14T23:59:59+04:00");
    const local = buildConfirmedBookingSuite("2026-09-14T23:59:59");
    expect(local.tests[0]!.tool_mock_overrides.list_my_bookings).toEqual(
      withZone.tests[0]!.tool_mock_overrides.list_my_bookings,
    );
  });
});
