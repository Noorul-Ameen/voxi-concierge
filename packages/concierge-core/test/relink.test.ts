import { randomUUID } from "node:crypto";
import { schema as S, createDb, prefixedId } from "@voxi/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { executeAction } from "../src/actions/executor.js";
import { complete, enqueue } from "../src/actions/ledger.js";
import { createContext } from "../src/context.js";
import { appendEvent, createEventBus, eventsSince, toWidgetEvent } from "../src/events.js";
import type { Catalog } from "../src/services/catalog.js";
import { consumeConfirmation, createConfirmation } from "../src/services/confirmations.js";
import { updateConversation } from "../src/services/conversation.js";
import { relinkConversationWork, resolveLinkedConversation } from "../src/services/relink.js";

const database = createDb(assertLocalTestDatabase(), { max: 4 });
const db = database.db;
const conversations: string[] = [];
async function conversation(metadata: Record<string, unknown> = {}) {
  const id = `conv_link_${randomUUID()}`;
  conversations.push(id);
  await db.insert(S.conversations).values({ id, metadata });
  return id;
}
async function link(sourceId: string, targetId: string) {
  return db.transaction(async (tx) => {
    await tx
      .select()
      .from(S.conversations)
      .where(inArray(S.conversations.id, [sourceId, targetId]))
      .for("update");
    return relinkConversationWork(tx, sourceId, targetId);
  });
}
afterAll(async () => {
  if (conversations.length) {
    await db.delete(S.orders).where(inArray(S.orders.conversationId, conversations));
    await db.delete(S.actions).where(inArray(S.actions.conversationId, conversations));
    await db
      .delete(S.pendingConfirmations)
      .where(inArray(S.pendingConfirmations.conversationId, conversations));
    await db.delete(S.transfers).where(inArray(S.transfers.conversationId, conversations));
    await db.delete(S.conversationEvents).where(inArray(S.conversationEvents.conversationId, conversations));
    await db.delete(S.conversations).where(inArray(S.conversations.id, conversations));
  }
  await database.close();
});

it("moves only live work, preserves confirmations and sends stale-worker completion to the new stream", async () => {
  const source = await conversation({ widgetSessionKey: "old-key", widgetEventAfterSeq: 1 });
  const target = await conversation({ widgetSessionKey: "old-key", widgetEventAfterSeq: 9 });
  await appendEvent(db, null, source, "human.message", { text: "previous account" });
  await appendEvent(db, null, source, "human.message", { text: "current account" });
  await appendEvent(db, null, target, "human.message", { text: "old target content" });
  const confirmation = await createConfirmation(db, {
    conversationId: source,
    actionType: "pay_order",
    resourceKey: "order:held",
    summary: {},
    spokenSummary: "One ticket",
    ttlSeconds: 60,
  });
  const running = (
    await db
      .insert(S.actions)
      .values({
        id: prefixedId("act", 12),
        conversationId: source,
        type: "pay_order",
        resourceKey: "order:held",
        idempotencyKey: randomUUID(),
        input: {},
        status: "running",
        attempts: 1,
        lockedBy: "worker",
        leaseUntil: new Date(Date.now() + 60000),
      })
      .returning()
  )[0]!;
  const past = (
    await db
      .insert(S.actions)
      .values({
        id: prefixedId("act", 12),
        conversationId: source,
        type: "pay_order",
        resourceKey: "order:past",
        idempotencyKey: randomUUID(),
        input: {},
        status: "succeeded",
      })
      .returning()
  )[0]!;
  const queued = (
    await enqueue(db, null, {
      conversationId: source,
      // A later basket edit intentionally revokes this payment consent; unrelated work does not.
      type: "transfer_to_agent",
      resourceKey: "order:held",
      idempotencyKey: randomUUID(),
      payload: {},
    })
  ).action;
  const transferId = prefixedId("tr", 10);
  await db.insert(S.transfers).values({
    id: transferId,
    conversationId: source,
    reason: "customer_request",
    summary: "Help",
    adapter: "simulated",
    status: "connected",
  });
  const orderId = prefixedId("order", 12);
  await db.insert(S.orders).values({
    userSessionId: orderId,
    conversationId: source,
    cinemaId: "0002",
    state: "seats_selected",
    expiryAt: new Date(Date.now() + 60000),
  });
  const { eventAfterSeq } = await link(source, target);
  expect(eventAfterSeq).toBe(1);
  const history = await eventsSince(db, target, eventAfterSeq);
  expect(history.some((event) => event.payload.text === "current account")).toBe(true);
  expect(
    history.some(
      (event) => event.payload.text === "previous account" || event.payload.text === "old target content",
    ),
  ).toBe(false);
  expect((await db.select().from(S.actions).where(eq(S.actions.id, past.id)))[0]?.conversationId).toBe(
    source,
  );
  expect((await db.select().from(S.actions).where(eq(S.actions.id, queued.id)))[0]?.conversationId).toBe(
    target,
  );
  expect((await db.select().from(S.transfers).where(eq(S.transfers.id, transferId)))[0]?.conversationId).toBe(
    target,
  );
  expect(
    (await db.select().from(S.orders).where(eq(S.orders.userSessionId, orderId)))[0]?.conversationId,
  ).toBe(target);
  expect(
    (
      await consumeConfirmation(db, {
        id: confirmation.id,
        conversationId: target,
        actionType: "pay_order",
        resourceKey: "order:held",
      })
    ).consumedAt,
  ).not.toBeNull();
  const bus = createEventBus();
  const received: string[] = [];
  const off = bus.subscribe(target, (event) => received.push(event.type));
  const card = { type: "booking", items: [{ bookingId: "BOOKED" }] };
  const completed = await complete(db, bus, running, { bookingId: "BOOKED" }, card);
  expect(completed?.conversationId).toBe(target);
  expect(completed?.result?.ui).toEqual(card);
  await appendEvent(db, bus, source, "human.message", { text: "late provider message" });
  expect(received).toEqual(["action.completed", "human.message"]);
  off();
  await updateConversation(db, source, {
    metadata: {
      widgetSessionKey: "old-key",
      widgetEventAfterSeq: 0,
      linkedConversationId: source,
      lastBookingId: "BOOKED",
    },
  });
  const live = await resolveLinkedConversation(db, source);
  expect(live?.id).toBe(target);
  expect(live?.metadata).toMatchObject({
    widgetSessionKey: "old-key",
    widgetEventAfterSeq: 9,
    lastBookingId: "BOOKED",
  });
  await db
    .update(S.conversations)
    .set({
      metadata: { widgetSessionKey: "new-account-key", widgetEventAfterSeq: 99, widgetAuthGeneration: 1 },
    })
    .where(eq(S.conversations.id, target));
  await updateConversation(db, source, {
    metadata: {
      widgetSessionKey: "old-key",
      activeOrder: "previous-account-order",
      bookingState: { selectedMovie: "private previous film" },
    },
  });
  expect((await resolveLinkedConversation(db, source))?.metadata).toEqual({
    widgetSessionKey: "new-account-key",
    widgetEventAfterSeq: 99,
    widgetAuthGeneration: 1,
  });
  const later = await createConfirmation(db, {
    conversationId: source,
    actionType: "pay_order",
    resourceKey: "order:later",
    summary: {},
    spokenSummary: "Later",
    ttlSeconds: 60,
  });
  expect(later.conversationId).toBe(target);
  expect(
    (
      await enqueue(db, null, {
        conversationId: source,
        type: "select_seats",
        resourceKey: "order:later",
        idempotencyKey: randomUUID(),
        payload: {},
      })
    ).action.conversationId,
  ).toBe(target);
});

it("delivers a simulated human reply even when relink happens during the worker delay", async () => {
  const source = await conversation();
  const target = await conversation();
  const transferId = prefixedId("tr", 10);
  await db.insert(S.transfers).values({
    id: transferId,
    conversationId: source,
    reason: "customer_request",
    summary: "Help",
    adapter: "simulated",
    status: "connected",
  });
  const action = (
    await db
      .insert(S.actions)
      .values({
        id: prefixedId("act", 12),
        conversationId: source,
        type: "simulated_reply",
        resourceKey: `transfer:${transferId}`,
        idempotencyKey: randomUUID(),
        input: {
          transferId,
          conversationId: source,
          text: "Still here",
          agentName: "Aisha",
          at: Date.now() + 250,
        },
        status: "running",
        attempts: 1,
        lockedBy: "worker",
        leaseUntil: new Date(Date.now() + 60000),
      })
      .returning()
  )[0]!;
  const context = createContext(db);
  context.log.level = "silent";
  const executing = executeAction(context, {} as Catalog, action);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await link(source, target);
  expect((await executing)?.result).toMatchObject({ delivered: true });
  const messages = await db
    .select()
    .from(S.conversationEvents)
    .where(
      and(eq(S.conversationEvents.conversationId, target), eq(S.conversationEvents.type, "human.message")),
    );
  expect(messages).toHaveLength(1);
  expect(messages[0]?.payload.text).toBe("Still here");
});

it("keeps guest-to-member work visible but audits late previous-account completion without displaying it", async () => {
  const id = await conversation({ widgetSessionKey: "guest", widgetAuthGeneration: 0 });
  const bus = createEventBus();
  const received: string[] = [];
  const off = bus.subscribe(id, (event) => received.push(event.type));
  const claim = async () => {
    const { action } = await enqueue(db, null, {
      conversationId: id,
      type: "pay_order",
      resourceKey: "order:test",
      idempotencyKey: randomUUID(),
      payload: {},
    });
    return (
      await db
        .update(S.actions)
        .set({ status: "running", attempts: 1, lockedBy: "worker", leaseUntil: new Date(Date.now() + 60000) })
        .where(eq(S.actions.id, action.id))
        .returning()
    )[0]!;
  };
  const guestAction = await claim();
  await db
    .update(S.conversations)
    .set({
      customerId: "cust_sara",
      isLoggedIn: true,
      metadata: { widgetSessionKey: "member", widgetAuthGeneration: 0 },
    })
    .where(eq(S.conversations.id, id));
  await updateConversation(db, id, {
    metadata: { widgetSessionKey: "guest", widgetAuthGeneration: 0, activeOrder: "guest-order" },
  });
  expect((await resolveLinkedConversation(db, id))?.metadata?.activeOrder).toBe("guest-order");
  await complete(db, bus, guestAction, { bookingId: "GUEST" }, { type: "booking", items: [] });
  expect(received).toEqual(["action.completed"]);
  const oldAction = await claim();
  await db
    .update(S.conversations)
    .set({
      customerId: null,
      isLoggedIn: false,
      metadata: { widgetSessionKey: "logged-out", widgetAuthGeneration: 1 },
    })
    .where(eq(S.conversations.id, id));
  await complete(db, bus, oldAction, { bookingId: "PRIVATE" }, { type: "booking", items: [] });
  await appendEvent(db, bus, id, "order.updated", { summary: { filmTitle: "Private movie" } }, "system", 0);
  expect(received).toEqual(["action.completed"]);
  const audit = await db
    .select()
    .from(S.conversationEvents)
    .where(and(eq(S.conversationEvents.conversationId, id), eq(S.conversationEvents.type, "audit.stale_ui")));
  expect(audit).toHaveLength(2);
  expect(audit.every((event) => toWidgetEvent(event.type, event.seq, event.payload) === null)).toBe(true);
  expect((await db.select().from(S.actions).where(eq(S.actions.id, oldAction.id)))[0]?.status).toBe(
    "succeeded",
  );
  off();
});

it("ends a handover that finishes after logout without restoring human mode", async () => {
  const id = await conversation({ widgetAuthGeneration: 0 });
  const action = (
    await db
      .insert(S.actions)
      .values({
        id: prefixedId("act", 12),
        conversationId: id,
        type: "transfer_to_agent",
        resourceKey: `conversation:${id}`,
        idempotencyKey: randomUUID(),
        input: { reason: "customer_request", language: "en", agentSummary: "Help", _widgetAuthGeneration: 0 },
        status: "running",
        attempts: 1,
        lockedBy: "worker",
        leaseUntil: new Date(Date.now() + 60000),
      })
      .returning()
  )[0]!;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const end = vi.fn(async () => {});
  const context = createContext(db);
  context.log.level = "silent";
  context.handover = {
    name: "simulated",
    start: async () => {
      started();
      await wait;
      return { status: "queued", externalConversationId: "external" };
    },
    sendCustomerMessage: async () => {},
    end,
  };
  const executing = executeAction(context, {} as Catalog, action);
  await entered;
  await db
    .update(S.conversations)
    .set({ metadata: { widgetAuthGeneration: 1 }, mode: "bot", status: "active" })
    .where(eq(S.conversations.id, id));
  finish();
  expect((await executing)?.result).toMatchObject({ cancelled: true, reason: "session_changed" });
  expect(end).toHaveBeenCalledWith("external", "session_changed");
  expect((await db.select().from(S.conversations).where(eq(S.conversations.id, id)))[0]?.mode).toBe("bot");
  expect((await db.select().from(S.transfers).where(eq(S.transfers.conversationId, id)))[0]?.status).toBe(
    "ended",
  );
});
