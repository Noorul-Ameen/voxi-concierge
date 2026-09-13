import { randomUUID } from "node:crypto";
import { schema as S, createDb } from "@voxi/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { markJourney } from "../src/services/conversation.js";
import { customerTools } from "../src/tools/customer.js";
import type { ToolCtx } from "../src/tools/types.js";

const database = createDb(assertLocalTestDatabase(), { max: 3 });
const db = database.db;
const ids: string[] = [];
async function conversation(metadata: Record<string, unknown> = {}) {
  const id = `conv_journey_${randomUUID()}`;
  ids.push(id);
  await db.insert(S.conversations).values({ id, metadata });
  return id;
}
async function report(id: string, journey = "booking") {
  const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, id));
  return customerTools.log_journey({ db, conversation: state } as ToolCtx, { journey, status: "completed" });
}
async function payment(id: string, order: string, booking: string, status = "succeeded") {
  const key = randomUUID();
  await db.insert(S.actions).values({
    id: `act_${key.slice(0, 24)}`,
    conversationId: id,
    type: "pay_order",
    status,
    resourceKey: `order:${order}`,
    idempotencyKey: key,
    input: { _widgetAuthGeneration: 0 },
    result: { bookingId: booking, booking: { ticketCount: 2 } },
  });
}
async function financialAction(
  id: string,
  type: "cancel_booking" | "swap_booking" | "transfer_to_agent",
  status = "succeeded",
  generation = 0,
  result: Record<string, unknown> = type === "swap_booking"
    ? { newBookingId: "NEW_BOOKING", differenceCents: 1000 }
    : { refund: { reference: "REFUND_CONFIRMED", amountCents: 12000 }, bookingStatus: "cancelled" },
) {
  await db.insert(S.actions).values({
    id: `act_${randomUUID().slice(0, 24)}`,
    conversationId: id,
    type,
    status,
    resourceKey: "booking:ORIGINAL_BOOKING",
    idempotencyKey: randomUUID(),
    input: { bookingId: "ORIGINAL_BOOKING", _widgetAuthGeneration: generation },
    result,
  });
}
afterAll(async () => {
  if (ids.length) {
    await db.delete(S.actions).where(inArray(S.actions.conversationId, ids));
    await db.delete(S.conversations).where(inArray(S.conversations.id, ids));
  }
  await database.close();
});

it("does not turn an unpaid resumed hold, failed payment or unrelated paid order into a completed booking", async () => {
  const id = await conversation({ activeOrder: "unpaid-order" });
  const unrelated = await conversation();
  await payment(unrelated, "unrelated-order", "PAID_OTHER");
  await payment(id, "unpaid-order", "FAILED_REF", "failed");
  await db.insert(S.actions).values({
    id: `act_${randomUUID().slice(0, 24)}`,
    conversationId: id,
    type: "quick_book",
    status: "succeeded",
    resourceKey: "order:unpaid-order",
    idempotencyKey: randomUUID(),
    input: {},
    result: { toolResult: { ok: true, data: { order: { state: "seats_selected", tickets: [{ id: 1 }] } } } },
  });
  expect((await report(id)).data).toEqual({ logged: false, reason: "payment_not_confirmed" });
  expect((await report(id, "guided_booking")).data?.logged).toBe(false);
  const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, id));
  expect(state?.journeys).toEqual([]);
  expect(state?.topics).toEqual([]);
});

it("accepts authoritative paid booking once, rejects a subsequent unpaid basket and preserves backend journey writes", async () => {
  const id = await conversation({ activeOrder: "paid-order" });
  await payment(id, "paid-order", "PAID_BOOKING");
  expect((await report(id)).data).toEqual({ logged: true });
  expect((await report(id)).data).toEqual({ logged: false, reason: "already_recorded" });
  await db
    .update(S.conversations)
    .set({ metadata: { activeOrder: "next-unpaid-order" } })
    .where(eq(S.conversations.id, id));
  expect((await report(id)).data).toEqual({ logged: false, reason: "payment_not_confirmed" });
  // Real executor results bypass the agent-only guard for payment, refunds and cancellation.
  await markJourney(db, id, "payment", "completed");
  await markJourney(db, id, "cancellation", "completed");
  await markJourney(db, id, "refund", "completed");
  const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, id));
  expect(state?.journeys?.map((journey) => journey.name)).toEqual([
    "booking",
    "payment",
    "cancellation",
    "refund",
  ]);
});

it("recognizes a paid booking carried through reconnect but never through a new account generation", async () => {
  const previous = await conversation();
  await payment(previous, "paid-before-reconnect", "LINKED_BOOKING");
  const current = await conversation({ lastBookingId: "LINKED_BOOKING" });
  await db
    .update(S.conversations)
    .set({ metadata: { linkedConversationId: current } })
    .where(eq(S.conversations.id, previous));
  expect((await report(current)).data).toEqual({ logged: true });
  await db
    .update(S.conversations)
    .set({ metadata: { lastBookingId: "LINKED_BOOKING", widgetAuthGeneration: 1 } })
    .where(eq(S.conversations.id, current));
  expect((await report(current, "payment")).data).toEqual({ logged: false, reason: "payment_not_confirmed" });
});

it.each(["cancellation", "refund", "swap"])(
  "does not report %s completed from a refusal, pending/failed action or successful handover",
  async (journey) => {
    const id = await conversation();
    const actionType = journey === "swap" ? "swap_booking" : "cancel_booking";
    await financialAction(id, actionType, "queued");
    await financialAction(id, actionType, "failed");
    await financialAction(id, "transfer_to_agent");
    expect((await report(id, journey)).data).toEqual({
      logged: false,
      reason: journey === "swap" ? "swap_not_confirmed" : "cancellation_not_confirmed",
    });
    const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, id));
    expect(state?.journeys).toEqual([]);
  },
);

it("accepts completed cancellation/refund evidence once and preserves authoritative backend writes", async () => {
  const id = await conversation();
  await financialAction(id, "cancel_booking");
  expect((await report(id, "cancellation")).data).toEqual({ logged: true });
  expect((await report(id, "cancellation")).data).toEqual({ logged: false, reason: "already_recorded" });
  expect((await report(id, "refund")).data).toEqual({ logged: true });
  await markJourney(db, id, "cancellation", "completed");
  const [state] = await db.select().from(S.conversations).where(eq(S.conversations.id, id));
  expect(state?.journeys?.map((journey) => journey.name)).toEqual(["cancellation", "refund", "cancellation"]);
});

it("requires a real replacement booking result for a reported swap", async () => {
  const id = await conversation();
  await financialAction(id, "swap_booking", "succeeded", 0, {
    newBookingId: "ORIGINAL_BOOKING",
    differenceCents: 0,
  });
  expect((await report(id, "swap")).data).toEqual({ logged: false, reason: "swap_not_confirmed" });
  await financialAction(id, "swap_booking");
  expect((await report(id, "swap")).data).toEqual({ logged: true });
  expect((await report(id, "swap")).data).toEqual({ logged: false, reason: "already_recorded" });
});

it("does not reuse another conversation or previous account's financial results, or a result without a refund", async () => {
  const id = await conversation({ widgetAuthGeneration: 1 });
  const other = await conversation({ widgetAuthGeneration: 1 });
  await financialAction(other, "cancel_booking", "succeeded", 1);
  await financialAction(other, "swap_booking", "succeeded", 1);
  await financialAction(id, "cancel_booking", "succeeded", 0);
  await financialAction(id, "swap_booking", "succeeded", 0);
  await financialAction(id, "cancel_booking", "succeeded", 1, { bookingStatus: "confirmed" });
  expect((await report(id, "cancellation")).data).toEqual({
    logged: false,
    reason: "cancellation_not_confirmed",
  });
  expect((await report(id, "refund")).data).toEqual({ logged: false, reason: "cancellation_not_confirmed" });
  expect((await report(id, "swap")).data).toEqual({ logged: false, reason: "swap_not_confirmed" });
  await financialAction(id, "cancel_booking", "succeeded", 1);
  expect((await report(id, "cancellation")).data).toEqual({ logged: true });
});
