import { readFileSync } from "node:fs";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildJourneySimulationSuite } from "../src/journey-simulations.js";
import { materializeSimulations } from "../src/simulations.js";

const suite = buildJourneySimulationSuite();
const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  id: name,
  name,
}));
const published = materializeSimulations(suite, tools);
function invoke(id: string, tool: string, args: Record<string, unknown>) {
  const mocks = published.find((test) => test.id === id)!.body.tool_mock_overrides[tool]!;
  const matched = mocks.find((entry) =>
    entry.parameter_conditions.every(({ path, eval: check }) => {
      const value = args[path];
      if (value === undefined) return false;
      return check.type === "exact"
        ? String(value) === check.expected_value
        : new RegExp(check.pattern).test(String(value));
    }),
  );
  expect(matched, `${id}/${tool} must end with a fail-closed mock`).toBeDefined();
  return { isError: matched!.is_error, result: JSON.parse(matched!.mock_result) };
}

describe("offer journey fixture integrity", () => {
  for (const language of ["en", "ar"]) {
    it(`${language}: accepts omitted optional offer filters but rejects the observed altered key and conflicting scope`, () => {
      for (const path of ["positive", "negative", `negative-${language}-offer-error`]) {
        const id = path.endsWith("offer-error") ? `03-${path}` : `03-${path}-${language}`;
        const context = invoke(id, "get_session_context", {}).result.data.activeOrder;
        const exact = {
          sessionKey: context.sessionKey,
          cinemaId: context.summary.cinemaId,
          experience: context.summary.experience,
        };
        expect(TOOL_REGISTRY.list_offers.input.safeParse({}).success).toBe(true);
        expect(invoke(id, "list_offers", {}).result.ok).toBe(true);
        expect(invoke(id, "list_offers", exact).result.ok).toBe(true);
        for (const mismatch of [
          { sessionKey: `${exact.cinemaId}-${exact.sessionKey}` },
          { cinemaId: "0002" },
          { experience: "IMAX" },
        ]) {
          // Each is schema-valid; it must still fail the fixture's evidence check.
          expect(TOOL_REGISTRY.list_offers.input.safeParse(mismatch).success).toBe(true);
          expect(invoke(id, "list_offers", { ...exact, ...mismatch })).toMatchObject({
            isError: true,
            result: { ok: false, error: { code: "UNEXPECTED_SIMULATION_PARAMETER" } },
          });
        }
      }
    });

    it(`${language}: exposes the actual completed food basket UI with consistent amounts and unchanged hold`, () => {
      const id = `03-positive-${language}`;
      const before = invoke(id, "get_session_context", {}).result.data.activeOrder;
      const food = invoke(id, "order_fnb", {
        items: [
          { itemId: "FIX_POPCORN", quantity: 1 },
          { itemId: "FIX_COLA", quantity: 1 },
        ],
      }).result;
      const applied = invoke(id, "get_action_result", { actionId: "fixture_offer_action" }).result.data.result
        .order;
      expect(before.summary.totalCents).toBe(12000);
      expect(applied.totalCents).toBe(9600);
      expect(food.data.order.totalCents).toBe(applied.totalCents + 2000 + 1000);
      expect(food.data.order.offers).toEqual(applied.offers);
      expect(food.data).toMatchObject({
        userSessionId: before.userSessionId,
        sessionKey: before.sessionKey,
        combinedCheckout: true,
      });
      expect(food.ui).toMatchObject({
        type: "order",
        items: [food.data.order],
        meta: {
          userSessionId: before.userSessionId,
          sessionKey: before.sessionKey,
          expiresAtUtc: before.expiresAtUtc,
          combinedCheckout: true,
          stage: "seats",
        },
      });
      expect(food.data.bookingState).toMatchObject({
        userSessionId: before.userSessionId,
        totalCents: 12600,
        seatHoldExpiry: before.expiresAtUtc,
        ticketQuantity: 2,
        selectedSeats: "D8, D9",
        foodCart: food.data.order.concessions,
        requiresFreshHold: false,
        currentJourneyStage: "seats",
      });
      expect(food.ui.actions.map((action: { value: string }) => action.value)).toEqual([
        "seats:open",
        "fnb:suggest",
        "pay:start",
      ]);
      expect(food.ui.meta.requiresSheet).toBeUndefined();
      expect(food.data.confirmationId).toBeUndefined();
      expect(invoke(id, "prepare_payment", { userSessionId: before.userSessionId }).isError).toBe(true);
      expect(invoke(id, "pay_order", {}).isError).toBe(true);
    });

    it(`${language}: mirrors the scoped summary callback and keeps invalid order reads rejected`, () => {
      const id = `03-positive-${language}`;
      const source = readFileSync(
        new URL("../../../apps/web/src/components/Concierge.tsx", import.meta.url),
        "utf8",
      );
      const callbackLiteral = source.match(
        /render_order_summary:\s*async\s*\(\)\s*=>\s*("(?:[^"\\]|\\.)*")/,
      )?.[1];
      expect(callbackLiteral).toBeDefined();
      expect(invoke(id, "render_order_summary", { userSessionId: "fixture_order" })).toEqual({
        isError: false,
        result: JSON.parse(callbackLiteral!),
      });
      for (const args of [{}, { userSessionId: "another-order" }]) {
        expect(invoke(id, "render_order_summary", args).isError).toBe(true);
        for (const path of ["positive", "negative"])
          expect(invoke(`03-${path}-${language}`, "get_order", args).isError).toBe(true);
      }
      // Static phases stay explicit: refusal is unchanged; the positive refresh models only post-food.
      expect(
        invoke(`03-negative-${language}`, "get_order", { userSessionId: "fixture_order" }).result.data.order
          .totalCents,
      ).toBe(12000);
      expect(invoke(id, "get_order", { userSessionId: "fixture_order" }).result.data.order.totalCents).toBe(
        12600,
      );
      const failed = `03-negative-${language}-offer-error`;
      expect(
        invoke(failed, "get_order", { userSessionId: "fixture_order" }).result.data.order.totalCents,
      ).toBe(12000);
      expect(invoke(failed, "order_fnb", {}).isError).toBe(true);
      expect(invoke(failed, "render_order_summary", { userSessionId: "fixture_order" }).isError).toBe(true);
    });
  }
});
