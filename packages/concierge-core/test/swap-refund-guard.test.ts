import { beforeEach, expect, it, vi } from "vitest";
import { enqueue, findByKey } from "../src/actions/ledger.js";
import { consumeConfirmation, getConfirmation } from "../src/services/confirmations.js";
import { assertSwapRefundSelection } from "../src/services/swap-refund.js";
import { bookingTools } from "../src/tools/bookings.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/confirmations.js", () => ({
  getConfirmation: vi.fn(),
  consumeConfirmation: vi.fn(),
  createConfirmation: vi.fn(),
}));
vi.mock("../src/actions/ledger.js", () => ({
  enqueue: vi.fn(),
  findByKey: vi.fn(),
  idem: (_: string, k: string) => k,
  toRef: (x: unknown) => x,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findByKey).mockResolvedValue(undefined as never);
});

it.each([
  {},
  { refundMethod: "ORIGINAL_PAYMENT" },
  { refundMethod: "VOX_CREDIT", refundMethodSelected: true, permittedRefundMethods: ["ORIGINAL_PAYMENT"] },
])("rejects an unselected or unavailable negative refund before consuming or enqueuing", async (fields) => {
  vi.mocked(getConfirmation).mockResolvedValue({
    id: "review",
    conversationId: "conv",
    actionType: "swap_booking",
    resourceKey: "booking:BOOK",
    summary: { differenceCents: -1000, ...fields },
  } as never);
  const result = await bookingTools.swap_booking(
    { conversation: { id: "conv" }, db: {}, lang: "en" } as ToolCtx,
    { bookingId: "BOOK", confirmationId: "review", confirmed: true },
  );
  expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
  expect(consumeConfirmation).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it("validates the same proof before provider execution and leaves zero/charge paths unaffected", () => {
  expect(() =>
    assertSwapRefundSelection({ differenceCents: -1000, refundMethod: "ORIGINAL_PAYMENT" }),
  ).toThrow("Choose a permitted");
  expect(() =>
    assertSwapRefundSelection({
      differenceCents: -1000,
      refundMethod: "VOX_CREDIT",
      refundMethodSelected: true,
      permittedRefundMethods: ["VOX_CREDIT"],
    }),
  ).not.toThrow();
  for (const differenceCents of [0, 1000])
    expect(() => assertSwapRefundSelection({ differenceCents })).not.toThrow();
});
