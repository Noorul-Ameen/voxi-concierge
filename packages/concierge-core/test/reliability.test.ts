import { randomUUID } from "node:crypto";
import { schema as S, createDb } from "@voxi/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { executeAction } from "../src/actions/executor.js";
import { complete, reclaimExpiredLeases, renewLease } from "../src/actions/ledger.js";
import { createContext } from "../src/context.js";
import { SimulatedHandover } from "../src/handover/simulated.js";
import type { Catalog } from "../src/services/catalog.js";
import { consumeConfirmation, createConfirmation, getConfirmation } from "../src/services/confirmations.js";
import { quickTools } from "../src/tools/quick.js";
import type { ToolCtx } from "../src/tools/types.js";

const database = createDb(assertLocalTestDatabase(), { max: 4 });
const db = database.db;
const conversations: string[] = [];
async function conversation() {
  const id = `conv_reliability_${randomUUID()}`;
  conversations.push(id);
  await db.insert(S.conversations).values({ id });
  return id;
}
afterAll(async () => {
  if (conversations.length) {
    await db.delete(S.actions).where(inArray(S.actions.conversationId, conversations));
    await db.delete(S.conversationEvents).where(inArray(S.conversationEvents.conversationId, conversations));
    await db.delete(S.transfers).where(inArray(S.transfers.conversationId, conversations));
    await db
      .delete(S.pendingConfirmations)
      .where(inArray(S.pendingConfirmations.conversationId, conversations));
    await db.delete(S.conversations).where(inArray(S.conversations.id, conversations));
  }
  await database.close();
});

describe("durable worker ownership and replies", () => {
  it("serializes simultaneous quick-book requests and reuses a matching live hold without extending it", async () => {
    const conversationId = await conversation();
    const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, conversationId));
    const held = new Map<string, Record<string, unknown>>();
    const expiry = "2070-09-10T16:06:00Z";
    const session = {
      key: "0002-123",
      cinemaId: "0002",
      sessionId: "123",
      hoCode: "film",
      filmTitle: "Film",
      showtime: "2070-09-10T20:00:00",
      experience: "Standard",
      soldOut: false,
      allowTicketSales: true,
    };
    const cinema = { id: "0002", name: "Mall of the Emirates" };
    const addTickets = vi.fn(async (request: { UserSessionId: string }) => {
      const order = {
        UserSessionId: request.UserSessionId,
        State: "seats_selected",
        CinemaId: "0002",
        ExpiryDateUtc: expiry,
        TotalValueCents: 10000,
        Sessions: [
          {
            SessionId: "123",
            FilmTitle: "Film",
            ShowingRealDateTimeOffset: "2070-09-10T20:00:00+04:00",
            SeatsAllocated: true,
            Tickets: ["8", "9"].map((seat) => ({
              Id: seat,
              TicketTypeCode: "ADULT",
              SeatRowId: "G",
              SeatNumber: seat,
              SeatData: `G${seat}`,
              PriceCents: 5000,
              FinalPriceCents: 5000,
            })),
          },
        ],
        Concessions: [],
      };
      held.set(request.UserSessionId, order);
      return { Order: order };
    });
    const common = {
      ...createContext(db),
      conversation: state!,
      lang: "en",
      nowLocal: "2070-09-10T16:00:00",
      correlationId: "test",
      catalog: {
        cinemas: async () => [cinema],
        cinema: async () => cinema,
        sessionByKey: async () => session,
        film: async () => ({ rating: "PG" }),
        invalidateSessions: () => {},
      },
      vista: {
        getOrder: async (id: string) => ({ Order: held.get(id) }),
        ticketTypes: async () => ({ Tickets: [{ TicketTypeCode: "ADULT", PriceInCents: 5000 }] }),
        addTickets,
        cancelOrder: vi.fn(),
      },
    };
    const firstCtx = { ...common, toolCallId: "first" } as unknown as ToolCtx;
    const secondCtx = { ...common, toolCallId: "retry" } as unknown as ToolCtx;
    const input = { sessionKey: session.key, tickets: 2, idempotencyKey: "same-user-click" };
    const [first, retry] = await Promise.all([
      quickTools.quick_book(firstCtx, input),
      quickTools.quick_book(secondCtx, input),
    ]);
    expect(first.ok).toBe(true);
    expect(retry.data?.userSessionId).toBe(first.data?.userSessionId);
    const repeat = await quickTools.quick_book(
      { ...common, toolCallId: "another-request" } as unknown as ToolCtx,
      { sessionKey: session.key, tickets: 2 },
    );
    expect(addTickets).toHaveBeenCalledTimes(1);
    expect(repeat.data?.userSessionId).toBe(first.data?.userSessionId);
    expect((repeat.data?.order as { expiresAtUtc: string }).expiresAtUtc).toBe(expiry);
  });
  it("rejects a mismatched order without consuming the legitimate confirmation", async () => {
    const conversationId = await conversation();
    const confirmation = await createConfirmation(db, {
      conversationId,
      actionType: "pay_order",
      resourceKey: "order:correct",
      summary: {},
      spokenSummary: "One ticket",
      ttlSeconds: 60,
    });
    await expect(
      consumeConfirmation(db, {
        id: confirmation.id,
        conversationId,
        actionType: "pay_order",
        resourceKey: "order:wrong",
      }),
    ).rejects.toThrow(/different booking\/order/);
    expect((await getConfirmation(db, confirmation.id))?.consumedAt).toBeNull();
    expect(
      (
        await consumeConfirmation(db, {
          id: confirmation.id,
          conversationId,
          actionType: "pay_order",
          resourceKey: "order:correct",
        })
      ).consumedAt,
    ).not.toBeNull();
  });
  it("renews the current attempt but fences completion from an older owner", async () => {
    const conversationId = await conversation();
    const id = `act_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const [old] = await db
      .insert(S.actions)
      .values({
        id,
        conversationId,
        type: "test",
        resourceKey: conversationId,
        idempotencyKey: id,
        input: {},
        status: "running",
        attempts: 1,
        lockedBy: "old-worker",
        leaseUntil: new Date(Date.now() + 60000),
      })
      .returning();
    expect(await renewLease(db, old!)).toBe(true);
    const [current] = await db
      .update(S.actions)
      .set({ attempts: 2, lockedBy: "new-worker" })
      .where(eq(S.actions.id, id))
      .returning();
    expect(await renewLease(db, old!)).toBe(false);
    expect(await complete(db, null, old!, { stale: true })).toBeNull();
    expect((await complete(db, null, current!, { current: true }))?.result).toEqual({ current: true });
  });
  it("marks an expired final attempt failed instead of leaving an unclaimable queued row", async () => {
    const conversationId = await conversation();
    const id = `act_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await db.insert(S.actions).values({
      id,
      conversationId,
      type: "test",
      resourceKey: conversationId,
      idempotencyKey: id,
      input: {},
      status: "running",
      attempts: 3,
      maxAttempts: 3,
      lockedBy: "dead-worker",
      leaseUntil: new Date(Date.now() - 1000),
    });
    await reclaimExpiredLeases(db);
    const [row] = await db.select().from(S.actions).where(eq(S.actions.id, id));
    expect(row).toMatchObject({ status: "failed", lockedBy: null, leaseUntil: null });
    expect(row?.finishedAt).not.toBeNull();
  });
  it("delivers a follow-up created by a separate simulator instance through the shared ledger", async () => {
    const conversationId = await conversation();
    const transferId = `tr_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await db.insert(S.transfers).values({
      id: transferId,
      conversationId,
      reason: "customer_request",
      summary: "Help",
      adapter: "simulated",
      status: "connected",
    });
    const apiSimulator = new SimulatedHandover(db);
    await apiSimulator.sendCustomerMessage(`sim_${transferId}`, "Thank you", { transferId, conversationId });
    expect(apiSimulator.pending()).toEqual([]);
    const [queued] = await db
      .select()
      .from(S.actions)
      .where(and(eq(S.actions.conversationId, conversationId), eq(S.actions.type, "simulated_reply")));
    expect(queued?.status).toBe("queued");
    const [claimed] = await db
      .update(S.actions)
      .set({
        status: "running",
        attempts: 1,
        lockedBy: "separate-worker",
        leaseUntil: new Date(Date.now() + 60000),
        input: { ...queued!.input, at: Date.now() },
      })
      .where(eq(S.actions.id, queued!.id))
      .returning();
    const workerContext = createContext(db);
    workerContext.log.level = "silent";
    await executeAction(workerContext, {} as Catalog, claimed!);
    const messages = await db
      .select()
      .from(S.conversationEvents)
      .where(
        and(
          eq(S.conversationEvents.conversationId, conversationId),
          eq(S.conversationEvents.type, "human.message"),
        ),
      );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toMatchObject({
      transferId,
      text: "You're welcome! Is there anything else I can help with?",
    });
  });
});
