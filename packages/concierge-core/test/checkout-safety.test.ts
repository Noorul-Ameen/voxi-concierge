import { randomUUID } from "node:crypto";
import { schema as S, createDb } from "@voxi/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { executeAction } from "../src/actions/executor.js";
import { type ActionRow, enqueue } from "../src/actions/ledger.js";
import { createContext } from "../src/context.js";
import { consumeConfirmation } from "../src/services/confirmations.js";
import { orderingTools } from "../src/tools/ordering.js";
import type { ToolCtx } from "../src/tools/types.js";

const connection = createDb(assertLocalTestDatabase(), { max: 8 });
const db = connection.db;
const ids: string[] = [];
afterAll(async () => {
  if (ids.length) {
    await db.delete(S.actions).where(inArray(S.actions.conversationId, ids));
    await db.delete(S.conversationEvents).where(inArray(S.conversationEvents.conversationId, ids));
    await db.delete(S.pendingConfirmations).where(inArray(S.pendingConfirmations.conversationId, ids));
    await db.delete(S.conversations).where(inArray(S.conversations.id, ids));
  }
  await connection.close();
});

async function fixture() {
  const id = `conv_checkout_${randomUUID()}`;
  ids.push(id);
  const orderId = `order_${randomUUID()}`;
  const [conversation] = await db
    .insert(S.conversations)
    .values({ id, metadata: { activeOrder: orderId } })
    .returning();
  const order: Record<string, any> = {
    UserSessionId: orderId,
    CinemaId: "0002",
    Version: 1,
    State: "seats_selected",
    TotalValueCents: 5000,
    ExpiryDateUtc: "2070-09-10T16:06:00Z",
    Sessions: [
      {
        SessionId: "123",
        FilmTitle: "The Journey",
        SeatsAllocated: true,
        ShowingRealDateTimeOffset: "2070-09-10T20:00:00+04:00",
        Tickets: [
          {
            Id: "ticket",
            Description: "Adult",
            TicketTypeCode: "ADULT",
            SeatRowId: "G",
            SeatNumber: "8",
            SeatData: "G8",
            PriceCents: 5000,
            FinalPriceCents: 5000,
          },
        ],
      },
    ],
    Concessions: [],
    AppliedOffers: [],
  };
  let charges = 0;
  const completeOrder = vi.fn(async (request: Record<string, any>) => {
    if (order.State !== "paid") {
      charges++;
      order.State = "paid";
      order.Version++;
    }
    return {
      Booking: {
        VistaBookingId: "CHECKOUT1",
        CinemaId: "0002",
        Status: "confirmed",
        FilmTitle: "The Journey",
        Showtime: "2070-09-10T20:00:00",
        Tickets: order.Sessions[0].Tickets,
        Concessions: order.Concessions,
        TotalValueCents: order.TotalValueCents,
        Customer: { FirstName: "Guest", Email: request.CustomerEmail },
        QrPayload: "checkout-qr",
      },
    };
  });
  const app = createContext(db);
  app.log.level = "silent";
  const ctx = {
    ...app,
    conversation: conversation!,
    lang: "en",
    nowLocal: "2070-09-10T16:00:00",
    toolCallId: "checkout-test",
    correlationId: "checkout-test",
    catalog: { cinema: async () => ({ name: "Mall of the Emirates" }), invalidateSessions: () => {} },
    vista: { getOrder: vi.fn(async () => ({ Order: structuredClone(order) })), completeOrder },
  } as unknown as ToolCtx;
  const review = () =>
    orderingTools.prepare_payment(ctx, {
      userSessionId: orderId,
      method: "CARD",
      customer: { name: "Guest", email: "guest@example.com", phone: "+971500000001" },
    });
  const edit = async (key = randomUUID()) =>
    (
      await enqueue(db, null, {
        conversationId: id,
        type: "add_concessions",
        resourceKey: `order:${orderId}`,
        idempotencyKey: key,
        payload: { userSessionId: orderId, items: [{ itemId: "POP", quantity: 1 }] },
      })
    ).action;
  const settle = async (action: ActionRow, success: boolean) => {
    await db
      .update(S.actions)
      .set({ status: success ? "succeeded" : "failed", finishedAt: new Date() })
      .where(eq(S.actions.id, action.id));
    if (success) {
      order.Version++;
      order.TotalValueCents = 6500;
      order.Concessions = [
        {
          Id: "popcorn",
          ItemId: "POP",
          Description: "Popcorn",
          Quantity: 1,
          PriceCents: 1500,
          FinalPriceCents: 1500,
        },
      ];
    }
  };
  const queuePayment = async (reviewed: Awaited<ReturnType<typeof review>>) => {
    const conf = await consumeConfirmation(db, {
      id: String(reviewed.data!.confirmationId),
      conversationId: id,
      actionType: "pay_order",
      resourceKey: `order:${orderId}`,
    });
    return (
      await enqueue(db, null, {
        conversationId: id,
        type: "pay_order",
        resourceKey: `order:${orderId}`,
        idempotencyKey: `pay:${conf.id}`,
        payload: { ...conf.summary, confirmationId: conf.id, paymentToken: "tok_test" },
      })
    ).action;
  };
  const execute = async (action: ActionRow) => {
    const [claimed] = await db
      .update(S.actions)
      .set({
        status: "running",
        attempts: action.attempts + 1,
        lockedBy: "checkout-test",
        leaseUntil: new Date(Date.now() + 60000),
      })
      .where(eq(S.actions.id, action.id))
      .returning();
    return executeAction(ctx, ctx.catalog, claimed!);
  };
  return {
    id,
    orderId,
    order,
    ctx,
    completeOrder,
    charges: () => charges,
    review,
    edit,
    settle,
    queuePayment,
    execute,
  };
}

it("does not create a payment sheet or confirmation while a requested snack is queued or running", async () => {
  const f = await fixture();
  const edit = await f.edit();
  for (const status of ["queued", "running"] as const) {
    await db.update(S.actions).set({ status }).where(eq(S.actions.id, edit.id));
    const result = await f.review();
    expect(result).toMatchObject({
      ok: false,
      data: { needs: "pending_basket", pendingActions: [{ actionId: edit.id, status }] },
    });
    expect(result.ui).toBeUndefined();
    expect(result.data?.confirmationId).toBeUndefined();
  }
  expect(
    await db.select().from(S.pendingConfirmations).where(eq(S.pendingConfirmations.conversationId, f.id)),
  ).toHaveLength(0);
});

it("rechecks pending edits under the confirmation lock if a change arrives while the review loads", async () => {
  const f = await fixture();
  f.ctx.catalog.cinema = vi.fn(async () => {
    await f.edit();
    return { name: "Mall of the Emirates" };
  }) as typeof f.ctx.catalog.cinema;
  const result = await f.review();
  expect(result).toMatchObject({ ok: false, data: { needs: "review_updated_basket" } });
  expect(result.ui).toBeUndefined();
  expect(result.data?.confirmationId).toBeUndefined();
});

it.each(["total", "same-total seat", "version"])(
  "rejects payment after a %s change to the reviewed basket",
  async (change) => {
    const f = await fixture();
    const reviewed = await f.review();
    expect(reviewed.ok).toBe(true);
    const action = await f.queuePayment(reviewed);
    if (change === "total") f.order.TotalValueCents += 1500;
    else if (change === "same-total seat") f.order.Sessions[0].Tickets[0].SeatNumber = "9";
    else f.order.Version++;
    const result = await f.execute(action);
    expect(result).toMatchObject({ status: "failed", error: { code: "CONFIRMATION_REQUIRED" } });
    expect(f.completeOrder).not.toHaveBeenCalled();
  },
);

it("invalidates consumed consent when a later requested edit fails without changing the basket", async () => {
  const f = await fixture();
  const payment = await f.queuePayment(await f.review());
  await f.settle(await f.edit(), false);
  const result = await f.execute(payment);
  expect(result).toMatchObject({ status: "failed", error: { code: "CONFIRMATION_REQUIRED" } });
  expect(f.completeOrder).not.toHaveBeenCalled();
});

it("checks pending edits at execution even if payment is claimed before an earlier edit", async () => {
  const f = await fixture();
  const payment = await f.queuePayment(await f.review());
  // Deliberately bypass enqueue invalidation to exercise the independent executor guard.
  await db.insert(S.actions).values({
    id: `act_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    conversationId: f.id,
    type: "add_concessions",
    resourceKey: `order:${f.orderId}`,
    idempotencyKey: randomUUID(),
    input: {},
    status: "queued",
  });
  const result = await f.execute(payment);
  expect(result).toMatchObject({ status: "failed", error: { code: "ORDER_INVALID_STATE" } });
  expect(f.completeOrder).not.toHaveBeenCalled();
});

it("pays the settled tickets and snacks together and recovers a paid retry without a second charge", async () => {
  const f = await fixture();
  await f.settle(await f.edit(), true);
  const reviewed = await f.review();
  expect(reviewed.ok).toBe(true);
  expect(reviewed.data?.summary).toMatchObject({
    amountCents: 6500,
    order: { tickets: [{ seat: "G8" }], concessions: [{ description: "Popcorn" }] },
  });
  const payment = await f.queuePayment(reviewed);
  const result = await f.execute(payment);
  expect(result).toMatchObject({
    status: "succeeded",
    result: {
      bookingId: "CHECKOUT1",
      booking: { ticketCount: 1, concessions: [{ description: "Popcorn" }] },
    },
  });
  expect(f.completeOrder.mock.calls[0]?.[0].PaymentInfoCollection[0].PaymentValueCents).toBe(6500);
  const retried = await f.execute(result!);
  expect(retried?.status).toBe("succeeded");
  expect(f.charges()).toBe(1);
});

it("does not invalidate a fresh review when a duplicate edit request replays the same action", async () => {
  const f = await fixture();
  const key = randomUUID();
  const edit = await f.edit(key);
  await f.settle(edit, true);
  const reviewed = await f.review();
  expect((await f.edit(key)).id).toBe(edit.id);
  expect((await f.execute(await f.queuePayment(reviewed)))?.status).toBe("succeeded");
});

it("routes explicit VOX reservation in cents, revokes prior payment consent and deduplicates its retry", async () => {
  const f = await fixture();
  f.ctx.conversation.memberId = "verified-member";
  const payment = await f.queuePayment(await f.review());
  const redeem = vi.fn(async (request: { Points?: number; BalanceType?: string }) => {
    f.order.TotalValueCents = 1500;
    f.order.Version++;
    f.order.LoyaltyPointsPayableValueInCents = request.Points;
    f.order.AppliedOffers = [
      {
        type: "loyalty_redeem",
        offerId: request.BalanceType,
        discountCents: request.Points,
      },
    ];
    return {
      ResponseCode: 0,
      Order: structuredClone(f.order),
      Redeemed: { Type: request.BalanceType!, Amount: request.Points! },
    };
  });
  f.ctx.vista.redeemLoyalty = redeem as typeof f.ctx.vista.redeemLoyalty;
  const input = {
    userSessionId: f.orderId,
    balanceType: "VOX_CREDIT" as const,
    amountCents: 3500,
    idempotencyKey: "credit-acceptance",
  };
  const queued = await orderingTools.redeem_points(f.ctx, input);
  const actionId = String((queued.data?.action as { actionId: string }).actionId);
  const [action] = await db.select().from(S.actions).where(eq(S.actions.id, actionId));
  const result = await f.execute(action!);
  expect(result).toMatchObject({
    status: "succeeded",
    result: {
      balanceType: "VOX_CREDIT",
      nextPaymentMethod: "CARD",
      balancePayment: {
        method: "VOX_CREDIT",
        amountCents: 3500,
        remainingCents: 1500,
        totalCents: 5000,
      },
    },
  });
  expect(redeem).toHaveBeenCalledWith(
    expect.objectContaining({
      Points: 3500,
      BalanceType: "VOX_REWARDS",
      MemberId: "verified-member",
    }),
  );
  expect(await f.execute(payment)).toMatchObject({
    status: "failed",
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(f.charges()).toBe(0);
  const repeated = await orderingTools.redeem_points(f.ctx, input);
  expect(repeated.data?.action).toMatchObject({
    actionId,
    status: "succeeded",
  });
  expect(redeem).toHaveBeenCalledTimes(1);
});

it("passes an explicit SHARE zero through as removal, restores the review and revokes stale consent", async () => {
  const f = await fixture();
  f.ctx.conversation.memberId = "verified-member";
  f.order.TotalValueCents = 1500;
  f.order.LoyaltyPointsPayableValueInCents = 3500;
  f.order.AppliedOffers = [{ type: "loyalty_redeem", offerId: "SHARE_POINTS", discountCents: 3500 }];
  const payment = await f.queuePayment(await f.review());
  const redeem = vi.fn(async () => {
    f.order.TotalValueCents = 5000;
    f.order.Version++;
    f.order.LoyaltyPointsPayableValueInCents = 0;
    f.order.AppliedOffers = [];
    return {
      ResponseCode: 0,
      Order: structuredClone(f.order),
      Redeemed: { Type: "SHARE_POINTS", Amount: 0 },
    };
  });
  f.ctx.vista.redeemLoyalty = redeem as typeof f.ctx.vista.redeemLoyalty;
  const queued = await orderingTools.redeem_points(f.ctx, {
    userSessionId: f.orderId,
    balanceType: "SHARE_POINTS",
    points: 0,
  });
  const [action] = await db
    .select()
    .from(S.actions)
    .where(eq(S.actions.id, String((queued.data?.action as { actionId: string }).actionId)));
  const result = await f.execute(action!);
  expect(result).toMatchObject({
    status: "succeeded",
    result: { cleared: true, nextPaymentMethod: null, balancePayment: null },
  });
  expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ Points: 0, BalanceType: "SHARE_POINTS" }));
  expect(await f.execute(payment)).toMatchObject({
    status: "failed",
    error: { code: "CONFIRMATION_REQUIRED" },
  });
  expect(f.completeOrder).not.toHaveBeenCalled();
  expect((await f.review()).data?.summary).toMatchObject({ amountCents: 5000 });
});
