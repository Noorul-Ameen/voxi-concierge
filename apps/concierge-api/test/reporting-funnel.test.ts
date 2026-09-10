import { expect, it } from "vitest";
import { bookingFunnel } from "../src/reporting-funnel.js";

it("counts actual quick-booking milestones once alongside legacy actions", () => {
  const action = (conversationId: string, type: string, result: Record<string, unknown> | null = null) => ({
    conversationId,
    type,
    result,
    status: "succeeded",
  });
  const booked = {
    toolResult: { ok: true, data: { order: { tickets: [{ id: "ticket" }], seatsAllocated: true } } },
  };
  const result = bookingFunnel(
    [
      action("quick", "quick_book", booked),
      action("quick", "recover_order", booked),
      action("quick", "pay_order"),
      action("legacy", "start_order"),
      action("legacy", "add_tickets"),
      action("legacy", "select_seats"),
      action("question", "quick_book", { toolResult: { ok: true, data: { needs: "tickets" } } }),
      { ...action("failed", "quick_book", booked), status: "failed" },
    ],
    [],
  );
  expect(result.map((step) => step.n)).toEqual([2, 2, 2, 1]);
});
