import { randomUUID } from "node:crypto";
import { RedeemPointsInput } from "@voxi/contracts";
import { schema as S, createDb } from "@voxi/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { executeAction } from "../src/actions/executor.js";
import { type ActionRow, enqueue } from "../src/actions/ledger.js";
import { createContext } from "../src/context.js";
import { relinkConversationWork } from "../src/services/relink.js";
import { orderingTools } from "../src/tools/ordering.js";
import type { ToolCtx } from "../src/tools/types.js";

const connection = createDb(assertLocalTestDatabase(), { max: 8 });
const db = connection.db;
const ids: string[] = [];
afterAll(async () => {
  if (ids.length) {
    await db.delete(S.actions).where(inArray(S.actions.conversationId, ids));
    await db.delete(S.pendingConfirmations).where(inArray(S.pendingConfirmations.conversationId, ids));
    await db.delete(S.conversationEvents).where(inArray(S.conversationEvents.conversationId, ids));
    await db.delete(S.conversations).where(inArray(S.conversations.id, ids));
  }
  await connection.close();
});

async function fixture() {
  const id = `conv_balance_${randomUUID()}`;
  const orderId = `order_${randomUUID()}`;
  ids.push(id);
  const [conversation] = await db
    .insert(S.conversations)
    .values({
      id,
      customerId: "test_customer",
      memberId: "test_member",
      isLoggedIn: true,
      metadata: { activeOrder: orderId, widgetAuthGeneration: 1 },
    })
    .returning();
  const expiry = new Date(Date.now() + 6 * 60_000).toISOString();
  const order: Record<string, any> = {
    UserSessionId: orderId,
    CustomerId: "test_customer",
    CinemaId: "0002",
    Version: 1,
    State: "seats_selected",
    TotalValueCents: 14550,
    TaxValueCents: 693,
    ExpiryDateUtc: expiry,
    LoyaltyPointsPayableValueInCents: 0,
    AppliedOffers: [],
    Sessions: [
      {
        SessionId: "42",
        FilmTitle: "Test film",
        SeatsAllocated: true,
        ShowingRealDateTimeOffset: "2070-09-15T19:00:00+04:00",
        Tickets: [
          {
            Id: "t1",
            TicketTypeCode: "ADULT",
            Description: "Adult",
            SeatRowId: "D",
            SeatNumber: "8",
            SeatData: "D8",
            PriceCents: 10850,
            FinalPriceCents: 10850,
          },
        ],
      },
    ],
    Concessions: [
      {
        Id: "f1",
        ItemId: "POP",
        Description: "Popcorn",
        Quantity: 1,
        PriceCents: 3700,
        FinalPriceCents: 3700,
      },
    ],
  };
  const mutations: unknown[] = [];
  const events: any[] = [];
  const app = createContext(db);
  app.log.level = "silent";
  const ctx = {
    ...app,
    conversation: conversation!,
    lang: "en",
    nowLocal: "2070-09-15T16:00:00",
    toolCallId: "test",
    correlationId: "test",
    catalog: { cinema: async () => ({ name: "Cinema" }) },
    vista: {
      getOrder: vi.fn(async () => ({ Order: structuredClone(order) })),
      customer: vi.fn(async () => ({
        firstName: "Test",
        lastName: "Member",
        email: "test@example.com",
        phone: "+971500000001",
        savedCards: [],
      })),
      balances: vi.fn(async () => ({
        Balances: [
          { BalanceTypeId: "VOX_REWARDS", ValueCents: 12000 },
          { BalanceTypeId: "SHARE_POINTS", ValueCents: 24500, Points: 2450 },
        ],
      })),
      offers: vi.fn(async () => ({ offers: [] })),
      completeOrder: vi.fn(() => {
        throw new Error("This flow must not charge");
      }),
      redeemLoyalty: vi.fn(async (input: any) => {
        mutations.push(input);
        const amount =
          input.Points === 0
            ? 0
            : input.BalanceType === "VOX_REWARDS"
              ? (input.Points ?? 12000)
              : (input.Points ?? 1200) * 10;
        order.TotalValueCents = 14550 - amount;
        order.LoyaltyPointsPayableValueInCents = amount;
        order.AppliedOffers = amount
          ? [{ type: "loyalty_redeem", offerId: input.BalanceType, discountCents: amount }]
          : [];
        order.Version++;
        return { Order: structuredClone(order), Redeemed: { Amount: amount } };
      }),
    },
  } as unknown as ToolCtx;
  ctx.events.subscribe(id, (ev) => events.push(ev));
  const prepare = async () => {
    const result = await orderingTools.prepare_payment(ctx, { userSessionId: orderId, method: "VOX_CREDIT" });
    expect(result.data?.needs).toBe("balance_split_confirmation");
    return RedeemPointsInput.parse(result.data!.redemptionInput);
  };
  const accept = async (input: ReturnType<typeof RedeemPointsInput.parse>) => {
    const result = await orderingTools.redeem_points(ctx, input);
    return { result, actionId: (result.data?.action as any)?.actionId as string | undefined };
  };
  const run = async (actionId: string) => {
    const [previous] = await db.select().from(S.actions).where(eq(S.actions.id, actionId));
    const [claimed] = await db
      .update(S.actions)
      .set({
        status: "running",
        attempts: previous!.attempts + 1,
        lockedBy: "balance-test",
        leaseUntil: new Date(Date.now() + 120_000),
      })
      .where(eq(S.actions.id, actionId))
      .returning();
    await executeAction(ctx, ctx.catalog, claimed!);
    return (await db.select().from(S.actions).where(eq(S.actions.id, actionId)))[0]!;
  };
  return { ctx, id, orderId, order, expiry, mutations, events, prepare, accept, run };
}

it("persists an exact scoped choice without reservation or payment consent", async () => {
  const f = await fixture();
  const input = await f.prepare();
  expect(input).toMatchObject({
    userSessionId: f.orderId,
    balanceType: "VOX_CREDIT",
    amountCents: 12000,
    confirmed: true,
  });
  const [conf] = await db
    .select()
    .from(S.pendingConfirmations)
    .where(eq(S.pendingConfirmations.id, input.confirmationId!));
  expect(conf).toMatchObject({
    actionType: "redeem_points",
    consumedAt: null,
    summary: {
      purpose: "reserve_and_open_card_review",
      amountCents: 14550,
      reserveCents: 12000,
      remainingCents: 2550,
      authGeneration: 1,
    },
  });
  expect(conf!.expiresAt.getTime()).toBeLessThanOrEqual(Date.parse(f.expiry));
  expect(f.mutations).toHaveLength(0);
});

it("accepted VOX120 plus CARD25.50 produces actual payment UI in ledger/SSE once, preserving expiry and no charge", async () => {
  const f = await fixture();
  const input = await f.prepare();
  const [a, retry] = await Promise.all([f.accept(input), f.accept(input)]);
  expect(a.actionId).toBe(retry.actionId);
  const done = await f.run(a.actionId!);
  expect(done.status).toBe("succeeded");
  expect(done.result).toMatchObject({
    paymentReviewOpened: true,
    balancePayment: { method: "VOX_CREDIT", amountCents: 12000, remainingCents: 2550, totalCents: 14550 },
    review: { ok: true },
    ui: {
      type: "payment",
      meta: {
        requiresSheet: true,
        method: "CARD",
        amountCents: 2550,
        userSessionId: f.orderId,
        expiresAtUtc: f.expiry,
        vat: { beforeVatCents: 13857, vatCents: 693 },
      },
    },
  });
  const confirmationId = (done.result!.review as any).confirmationId;
  expect((done.result!.ui as any).meta.confirmationId).toBe(confirmationId);
  const completedEvent = f.events.find((x) => x.type === "action.completed");
  expect(completedEvent?.ui).toEqual(done.result!.ui);
  expect((completedEvent?.ui as any)?.meta.confirmationId).toBe(confirmationId);
  const again = await f.accept(input);
  expect(again.actionId).toBe(done.id);
  expect((again.result.data!.action as any).result.review.confirmationId).toBe(confirmationId);
  expect(f.mutations).toHaveLength(1);
  expect(f.order.ExpiryDateUtc).toBe(f.expiry);
  expect(f.ctx.vista.completeOrder).not.toHaveBeenCalled();
});

it.each(["missing-id", "missing-yes", "fake-id", "wrong-order", "wrong-amount", "wrong-balance", "expired"])(
  "rejects %s without any reservation",
  async (kind) => {
    const f = await fixture();
    const input = await f.prepare();
    const bad: any = { ...input };
    if (kind === "missing-id") bad.confirmationId = undefined;
    if (kind === "missing-yes") bad.confirmed = undefined;
    if (kind === "fake-id") bad.confirmationId = "cnf_fabricated";
    if (kind === "wrong-order") bad.userSessionId = "someone_else";
    if (kind === "wrong-amount") bad.amountCents = 11000;
    if (kind === "wrong-balance") {
      bad.balanceType = "SHARE_POINTS";
      bad.points = 1200;
      bad.amountCents = undefined;
    }
    if (kind === "expired")
      await db
        .update(S.pendingConfirmations)
        .set({ expiresAt: new Date(0) })
        .where(eq(S.pendingConfirmations.id, input.confirmationId!));
    expect((await f.accept(bad)).result.ok).toBe(false);
    expect(f.mutations).toHaveLength(0);
    expect(await db.select().from(S.actions).where(eq(S.actions.conversationId, f.id))).toHaveLength(0);
  },
);

it.each(["basket", "account", "expiry", "active-order"])(
  "rejects stale %s before execution",
  async (kind) => {
    const f = await fixture();
    const input = await f.prepare();
    const a = await f.accept(input);
    if (kind === "basket") {
      f.order.Concessions[0].ItemId = "OTHER";
      f.order.Version++;
    }
    if (kind === "expiry") f.order.ExpiryDateUtc = new Date(0).toISOString();
    if (kind === "account")
      await db
        .update(S.conversations)
        .set({
          customerId: "another",
          memberId: "another",
          metadata: { activeOrder: f.orderId, widgetAuthGeneration: 2 },
        })
        .where(eq(S.conversations.id, f.id));
    if (kind === "active-order")
      await db
        .update(S.conversations)
        .set({ metadata: { activeOrder: "new-order", widgetAuthGeneration: 1 } })
        .where(eq(S.conversations.id, f.id));
    const done = await f.run(a.actionId!);
    expect(done.status).toBe("failed");
    expect(f.mutations).toHaveLength(0);
    expect(f.events.some((ev) => ev.ui?.type === "payment")).toBe(false);
  },
);

it("a queued basket edit revokes the accepted continuation rather than bypassing pending guards", async () => {
  const f = await fixture();
  const input = await f.prepare();
  const a = await f.accept(input);
  await enqueue(db, null, {
    conversationId: f.id,
    type: "add_concessions",
    resourceKey: `order:${f.orderId}`,
    idempotencyKey: randomUUID(),
    payload: {},
  });
  expect((await f.run(a.actionId!)).status).toBe("failed");
  expect(f.mutations).toHaveLength(0);
});

it("a later requested balance method invalidates the old intent even if the new balance has no value", async () => {
  const f = await fixture();
  const input = await f.prepare();
  vi.mocked(f.ctx.vista.balances).mockResolvedValue({
    Balances: [{ BalanceTypeId: "SHARE_POINTS", ValueCents: 0, Points: 0 }],
  } as any);
  const next = await orderingTools.prepare_payment(f.ctx, {
    userSessionId: f.orderId,
    method: "SHARE_POINTS",
  });
  expect(next.data?.needs).toBe("payment_method");
  expect((await f.accept(input)).result.ok).toBe(false);
  expect(f.mutations).toHaveLength(0);
});

it.each([12000, 0])(
  "ordinary redemption %s retains order-only UI, with no automatic payment review",
  async (amountCents) => {
    const f = await fixture();
    const a = await f.accept({ userSessionId: f.orderId, balanceType: "VOX_CREDIT", amountCents });
    const done = await f.run(a.actionId!);
    expect(done.status).toBe("succeeded");
    expect(done.result!.ui).toMatchObject({ type: "order" });
    expect(done.result).not.toHaveProperty("paymentReviewOpened");
    expect(
      await db.select().from(S.pendingConfirmations).where(eq(S.pendingConfirmations.conversationId, f.id)),
    ).toHaveLength(0);
    expect(f.ctx.vista.completeOrder).not.toHaveBeenCalled();
  },
);

it("review failure reports reserved-but-not-open and retries only the review with the same action", async () => {
  const f = await fixture();
  const input = await f.prepare();
  const a = await f.accept(input);
  vi.mocked(f.ctx.vista.customer).mockRejectedValueOnce(new Error("temporary profile read failure"));
  const failedReview = await f.run(a.actionId!);
  expect(failedReview.status).toBe("succeeded");
  expect(failedReview.result).toMatchObject({
    paymentReviewOpened: false,
    review: { ok: false },
    ui: { type: "order" },
  });
  expect(failedReview.result!.speech).toContain("reserved");
  expect(failedReview.result!.speech).toContain("could not be opened");
  expect(f.mutations).toHaveLength(1);
  const retry = await f.accept(input);
  expect(retry.actionId).toBe(a.actionId);
  const recovered = await f.run(retry.actionId!);
  expect(recovered.result).toMatchObject({ paymentReviewOpened: true, ui: { type: "payment" } });
  expect(f.mutations).toHaveLength(1);
  expect(f.order.ExpiryDateUtc).toBe(f.expiry);
});

it("refuses replay after logout even when the old action completed", async () => {
  const f = await fixture();
  const input = await f.prepare();
  const a = await f.accept(input);
  await f.run(a.actionId!);
  await db
    .update(S.conversations)
    .set({ isLoggedIn: false, customerId: null, memberId: null, metadata: { widgetAuthGeneration: 2 } })
    .where(eq(S.conversations.id, f.id));
  expect((await f.accept(input)).result.ok).toBe(false);
  expect(f.mutations).toHaveLength(1);
});

it.each(["basket", "hold-expiry", "confirmation-expiry"])(
  "refuses to republish a completed payment review after %s",
  async (kind) => {
    const f = await fixture();
    const input = await f.prepare();
    const a = await f.accept(input);
    await f.run(a.actionId!);
    if (kind === "basket") {
      f.order.Concessions[0].ItemId = "OTHER";
      f.order.Version++;
    }
    if (kind === "hold-expiry") f.order.ExpiryDateUtc = new Date(0).toISOString();
    if (kind === "confirmation-expiry")
      await db
        .update(S.pendingConfirmations)
        .set({ expiresAt: new Date(0) })
        .where(eq(S.pendingConfirmations.id, input.confirmationId!));
    const retry = await f.accept(input);
    expect(retry.result.ok).toBe(false);
    expect(retry.actionId).toBeUndefined();
    expect(retry.result.ui).toBeUndefined();
    expect(f.mutations).toHaveLength(1);
  },
);

it("reclaims a worker retry using its durable reservation/review checkpoints without fresh consent or reservation", async () => {
  const f = await fixture();
  const input = await f.prepare();
  const a = await f.accept(input);
  const first = await f.run(a.actionId!);
  const repeated = await f.run(a.actionId!);
  expect(repeated.result!.ui).toEqual(first.result!.ui);
  expect(f.mutations).toHaveLength(1);
});

it.each(["queued", "partial", "completed", "changed-account"])(
  "preserves only authorized %s continuation across a trusted reconnect",
  async (stage) => {
    const f = await fixture();
    const input = await f.prepare();
    const a = await f.accept(input);
    if (stage === "partial")
      vi.mocked(f.ctx.vista.customer).mockRejectedValueOnce(new Error("temporary profile read failure"));
    const first = stage === "partial" || stage === "completed" ? await f.run(a.actionId!) : null;
    const targetId = `conv_balance_target_${randomUUID()}`;
    ids.push(targetId);
    const [source] = await db.select().from(S.conversations).where(eq(S.conversations.id, f.id));
    await db.insert(S.conversations).values({
      id: targetId,
      customerId: source!.customerId,
      memberId: source!.memberId,
      isLoggedIn: true,
      metadata: source!.metadata,
    });
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(S.conversations)
        .where(inArray(S.conversations.id, [f.id, targetId]))
        .for("update");
      await relinkConversationWork(tx, f.id, targetId);
    });
    if (stage === "changed-account") {
      await db
        .update(S.conversations)
        .set({
          customerId: "different",
          memberId: "different",
          metadata: { ...source!.metadata, widgetAuthGeneration: 2 },
        })
        .where(eq(S.conversations.id, targetId));
      expect((await f.accept(input)).result.ok).toBe(false);
      expect((await f.run(a.actionId!)).status).toBe("failed");
      expect(f.mutations).toHaveLength(0);
      return;
    }
    const retry = await f.accept(input);
    expect(retry.actionId).toBe(a.actionId);
    if (stage === "completed") {
      expect((retry.result.data!.action as any).result.ui).toEqual(first!.result!.ui);
    } else {
      const delivered: any[] = [];
      f.ctx.events.subscribe(targetId, (event) => delivered.push(event));
      const done = await f.run(retry.actionId!);
      expect(done.result).toMatchObject({ paymentReviewOpened: true, ui: { type: "payment" } });
      expect(delivered.find((event) => event.type === "action.completed")?.ui).toEqual(done.result!.ui);
    }
    expect(f.mutations).toHaveLength(1);
  },
);
