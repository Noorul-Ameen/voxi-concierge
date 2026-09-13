import { beforeEach, expect, it, vi } from "vitest";
import { enqueue } from "../src/actions/ledger.js";
import { createConfirmation } from "../src/services/confirmations.js";
import { orderingTools } from "../src/tools/ordering.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/conversation.js", () => ({ updateConversation: vi.fn() }));
vi.mock("../src/services/confirmations.js", () => ({
  createConfirmation: vi.fn(async () => ({ id: "review" })),
}));
vi.mock("../src/services/checkout.js", async (original) => ({
  ...(await original<typeof import("../src/services/checkout.js")>()),
  pendingBasketActions: vi.fn(async () => []),
}));
vi.mock("../src/actions/ledger.js", async (original) => ({
  ...(await original<typeof import("../src/actions/ledger.js")>()),
  enqueue: vi.fn(async () => ({
    action: { id: "action", type: "redeem_points", status: "queued" },
    created: true,
  })),
}));

function fixture(reserved?: "VOX_REWARDS" | "SHARE_POINTS") {
  const order = {
    UserSessionId: "order",
    CinemaId: "0002",
    Version: 1,
    State: "seats_selected",
    TotalValueCents: reserved ? 2550 : 14550,
    TaxValueCents: 693,
    Sessions: [],
    Concessions: [{ ItemId: "food", Quantity: 1, Description: "Food", FinalPriceCents: 14550 }],
    LoyaltyPointsPayableValueInCents: reserved ? 12000 : 0,
    AppliedOffers: reserved ? [{ type: "loyalty_redeem", offerId: reserved, discountCents: 12000 }] : [],
  };
  const ctx = {
    conversation: {
      id: "conversation",
      customerId: "customer",
      memberId: "member",
      isLoggedIn: true,
      metadata: {},
    },
    lang: "en",
    nowLocal: "2070-09-14T12:00:00",
    cfg: { confirmationTtlSeconds: 60 },
    catalog: { cinema: async () => ({ name: "Cinema" }) },
    vista: {
      getOrder: vi.fn(async () => ({ Order: structuredClone(order) })),
      customer: async () => ({
        firstName: "Test",
        lastName: "Member",
        email: "member@example.com",
        phone: "+971500000001",
        savedCards: [],
      }),
      balances: vi.fn(async () => ({
        Balances: [
          { BalanceTypeId: "VOX_REWARDS", ValueCents: 12000 },
          { BalanceTypeId: "SHARE_POINTS", ValueCents: 24500, Points: 2450 },
        ],
      })),
    },
  } as unknown as ToolCtx;
  return { ctx, order };
}
beforeEach(() => vi.clearAllMocks());

it("returns an exact VOX-only split continuation without creating payment consent or a reservation", async () => {
  const { ctx } = fixture();
  const result = await orderingTools.prepare_payment(ctx, { userSessionId: "order", method: "VOX_CREDIT" });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "CONFIRMATION_REQUIRED" },
    data: {
      needs: "balance_split_confirmation",
      requestedMethod: "VOX_CREDIT",
      amountCents: 12000,
      remainingCents: 2550,
      totalCents: 14550,
      redemptionInput: { userSessionId: "order", balanceType: "VOX_CREDIT", amountCents: 12000 },
      nextPaymentMethod: "CARD",
    },
  });
  expect(createConfirmation).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  const mistaken = await orderingTools.redeem_points(ctx, { userSessionId: "order" });
  expect(mistaken).toMatchObject({
    ok: false,
    data: { needs: "explicit_balance_type", requestedMethod: "VOX_CREDIT" },
  });
  expect(enqueue).not.toHaveBeenCalled();
});

it.each(["CARD", "VOX_CREDIT"])(
  "opens only the card remainder after an actual VOX reservation via %s",
  async (method) => {
    const { ctx } = fixture("VOX_REWARDS");
    const result = await orderingTools.prepare_payment(ctx, {
      userSessionId: "order",
      method: method as "CARD" | "VOX_CREDIT",
    });
    expect(result.ok).toBe(true);
    expect(result.ui?.meta).toMatchObject({
      method: "CARD",
      requiresSheet: true,
      amountCents: 2550,
      balancePayment: { method: "VOX_CREDIT", amountCents: 12000, remainingCents: 2550, totalCents: 14550 },
    });
    expect(result.data?.summary).toMatchObject({ method: "CARD", amountCents: 2550 });
    expect(result.ui?.meta?.vat).toEqual({ beforeVatCents: 13857, vatCents: 693, rate: 5 });
    expect(result.speech).toContain("VOX credit");
    expect(result.speech).not.toContain("SHARE Points");
  },
);

it("requires explicit removal of the wrong balance before VOX review", async () => {
  const { ctx } = fixture("SHARE_POINTS");
  const result = await orderingTools.prepare_payment(ctx, { userSessionId: "order", method: "VOX_CREDIT" });
  expect(result).toMatchObject({
    ok: false,
    data: {
      needs: "balance_reset_confirmation",
      requestedMethod: "VOX_CREDIT",
      redemptionInput: { userSessionId: "order", balanceType: "SHARE_POINTS", points: 0 },
      nextPaymentMethod: "VOX_CREDIT",
    },
  });
  expect(createConfirmation).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it("keeps explicit credit units, zero-clear and retry keys distinct from SHARE", async () => {
  const { ctx, order } = fixture();
  for (const input of [
    { balanceType: "VOX_CREDIT" as const, amountCents: 12000 },
    { balanceType: "SHARE_POINTS" as const, points: 1200 },
    { balanceType: "SHARE_POINTS" as const, points: 0 },
  ]) {
    await orderingTools.redeem_points(ctx, { userSessionId: "order", ...input });
  }
  const calls = vi.mocked(enqueue).mock.calls.map((call) => call[2]);
  expect(calls[0]?.payload).toMatchObject({ balanceType: "VOX_CREDIT", amountCents: 12000 });
  expect(calls[0]?.payload).not.toHaveProperty("points");
  expect(calls[2]?.payload).toMatchObject({ balanceType: "SHARE_POINTS", points: 0 });
  expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(3);
  order.Version++;
  await orderingTools.redeem_points(ctx, {
    userSessionId: "order",
    balanceType: "VOX_CREDIT",
    amountCents: 12000,
  });
  expect(vi.mocked(enqueue).mock.calls[3]?.[2].idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
});

it("rejects mixed units and another member before enqueue", async () => {
  const { ctx } = fixture();
  for (const input of [
    { balanceType: "VOX_CREDIT" as const, points: 12000 },
    { balanceType: "SHARE_POINTS" as const, amountCents: 12000 },
    { memberId: "other", balanceType: "VOX_CREDIT" as const, amountCents: 12000 },
  ]) {
    expect((await orderingTools.redeem_points(ctx, { userSessionId: "order", ...input })).ok).toBe(false);
  }
  expect(enqueue).not.toHaveBeenCalled();
});
