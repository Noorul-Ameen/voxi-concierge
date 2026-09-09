import { randomUUID } from "node:crypto";
import { schema as S, createDb, prefixedId } from "@voxi/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { pendingBasketActions } from "../src/services/checkout.js";
import { createConfirmation, getConfirmation } from "../src/services/confirmations.js";
import { beginInlineBasketMutation, finishInlineBasketMutation } from "../src/services/inline-mutation.js";

const url = assertLocalTestDatabase();
const database = createDb(url, { max: 4 });
const observer = createDb(url, { max: 1 });
const db = database.db;
const ids: string[] = [];
async function conversation() {
  const id = `conv_inline_${randomUUID()}`;
  ids.push(id);
  await db.insert(S.conversations).values({ id, metadata: { activeOrder: `order-${id}` } });
  return id;
}
const confirm = (id: string, excludeBasketActionId?: string) =>
  createConfirmation(db, {
    conversationId: id,
    actionType: "pay_order",
    resourceKey: `order:order-${id}`,
    summary: {},
    spokenSummary: "Current basket",
    ttlSeconds: 60,
    excludeBasketActionId,
  });
const begin = (id: string) =>
  beginInlineBasketMutation(db, {
    conversationId: id,
    type: "order_fnb",
    idempotencyKey: randomUUID(),
    payload: { items: [{ itemId: "POP", quantity: 1 }] },
    toolCallId: randomUUID(),
    authGeneration: 0,
  });
afterAll(async () => {
  if (ids.length) {
    await db.delete(S.actions).where(inArray(S.actions.conversationId, ids));
    await db.delete(S.pendingConfirmations).where(inArray(S.pendingConfirmations.conversationId, ids));
    await db.delete(S.conversations).where(inArray(S.conversations.id, ids));
  }
  await observer.close();
  await database.close();
});

it("makes an inline edit visible to another connection, revokes old consent and permits only its own final review", async () => {
  const id = await conversation();
  const old = await confirm(id);
  const { action } = await begin(id);
  expect(
    (await pendingBasketActions(observer.db, `order:order-${id}`, undefined, id)).map((row) => row.id),
  ).toEqual([action.id]);
  expect((await getConfirmation(observer.db, old.id))!.expiresAt.getTime()).toBe(0);
  await expect(confirm(id)).rejects.toThrow(/still being applied/);
  expect((await confirm(id, action.id)).id).toBeTruthy();
  expect(await finishInlineBasketMutation(db, action, { ok: true, data: { updated: true } })).toBe(true);
  expect(await pendingBasketActions(observer.db, `order:order-${id}`, undefined, id)).toEqual([]);
  expect((await confirm(id)).id).toBeTruthy();
});

it("does not start an inline edit alongside a running payment or invalidate that payment on rejection", async () => {
  const id = await conversation();
  const old = await confirm(id);
  await db.insert(S.actions).values({
    id: prefixedId("act", 12),
    conversationId: id,
    type: "pay_order",
    status: "running",
    resourceKey: `order:order-${id}`,
    idempotencyKey: randomUUID(),
    input: {},
    attempts: 1,
    lockedBy: "payment-worker",
    leaseUntil: new Date(Date.now() + 60_000),
  });
  await expect(begin(id)).rejects.toThrow(/payment is still running/);
  expect((await getConfirmation(observer.db, old.id))!.expiresAt).toEqual(old.expiresAt);
});

it("keeps a moved inline marker visible after reconnect and fences expired completion", async () => {
  const original = await conversation();
  const current = await conversation();
  const { action } = await begin(original);
  await db.update(S.actions).set({ conversationId: current }).where(eq(S.actions.id, action.id));
  expect(
    (await pendingBasketActions(observer.db, "order:new-order", undefined, current)).map((row) => row.id),
  ).toEqual([action.id]);
  await db
    .update(S.actions)
    .set({ leaseUntil: new Date(0) })
    .where(eq(S.actions.id, action.id));
  expect(await finishInlineBasketMutation(db, action, { ok: true })).toBe(false);
  const [row] = await db.select().from(S.actions).where(eq(S.actions.id, action.id));
  expect(row?.status).toBe("running");
  expect(row?.result).toBeNull();
});
