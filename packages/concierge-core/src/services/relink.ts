/** Live-work continuity when a trusted widget changes its ElevenLabs conversation reference. */
import { type Db, schema as S, prefixedId } from "@voxi/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

export type ConversationTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Only server-authored links are followed. Call with a transaction + lock for writes. */
export async function resolveLinkedConversation(db: Db | ConversationTx, id: string, lock = false) {
  let current = id;
  const seen = new Set<string>();
  for (let hop = 0; hop < 32; hop++) {
    if (seen.has(current)) throw new Error("Conversation link cycle");
    seen.add(current);
    const query = db.select().from(S.conversations).where(eq(S.conversations.id, current));
    const [row] = await (lock ? query.for("update") : query);
    if (!row) return null;
    const next = row.metadata?.linkedConversationId;
    if (typeof next !== "string" || !next) return row;
    current = next;
  }
  throw new Error("Conversation link chain is too long");
}

/** Caller has already locked both conversation rows and verified source/target widget ownership. */
export async function relinkConversationWork(tx: ConversationTx, sourceId: string, targetId: string) {
  if (sourceId === targetId) return { eventAfterSeq: 0 };
  const [source] = await tx.select().from(S.conversations).where(eq(S.conversations.id, sourceId));
  const [target] = await tx.select().from(S.conversations).where(eq(S.conversations.id, targetId));
  if (!source || !target || target.metadata?.linkedConversationId)
    throw new Error("Invalid conversation link target");
  const active = await tx
    .select()
    .from(S.actions)
    .where(and(inArray(S.actions.conversationId, [sourceId, targetId]), eq(S.actions.status, "running")));
  if (
    active.some((action) => action.conversationId === sourceId) &&
    active.some((action) => action.conversationId === targetId)
  ) {
    throw new Error("Both conversations have work in progress; retry the link shortly");
  }
  await tx
    .update(S.actions)
    .set({ conversationId: targetId })
    .where(and(eq(S.actions.conversationId, sourceId), inArray(S.actions.status, ["queued", "running"])));
  await tx
    .update(S.pendingConfirmations)
    .set({ conversationId: targetId })
    .where(
      and(eq(S.pendingConfirmations.conversationId, sourceId), isNull(S.pendingConfirmations.consumedAt)),
    );
  await tx
    .update(S.transfers)
    .set({ conversationId: targetId })
    .where(
      and(
        eq(S.transfers.conversationId, sourceId),
        inArray(S.transfers.status, ["requested", "queued", "connected"]),
      ),
    );
  await tx
    .update(S.orders)
    .set({ conversationId: targetId })
    .where(
      and(
        eq(S.orders.conversationId, sourceId),
        inArray(S.orders.state, ["draft", "tickets_added", "seats_selected", "awaiting_payment", "expired"]),
      ),
    );
  // Copy events with fresh sequence numbers. Originals and completed commerce references stay intact.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`events:${targetId}`}))`);
  const existing = await tx
    .select()
    .from(S.conversationEvents)
    .where(eq(S.conversationEvents.conversationId, targetId));
  const originalId = (event: typeof S.conversationEvents.$inferSelect) =>
    typeof event.payload.linkedFromEventId === "string" ? event.payload.linkedFromEventId : event.id;
  const imported = new Set(existing.map(originalId));
  let seq = Math.max(0, ...existing.map((event) => event.seq));
  const eventAfterSeq = seq;
  const sourceFloor = Number(source.metadata?.widgetEventAfterSeq ?? 0);
  const history = await tx
    .select()
    .from(S.conversationEvents)
    .where(eq(S.conversationEvents.conversationId, sourceId))
    .orderBy(asc(S.conversationEvents.seq));
  const copied = history
    .filter((event) => event.seq > sourceFloor && !imported.has(originalId(event)))
    .map((event) => ({
      ...event,
      id: prefixedId("ev", 10),
      conversationId: targetId,
      seq: ++seq,
      payload: { ...event.payload, linkedFromEventId: originalId(event) },
    }));
  for (let start = 0; start < copied.length; start += 250)
    await tx.insert(S.conversationEvents).values(copied.slice(start, start + 250));
  await tx
    .update(S.conversations)
    .set({ metadata: { ...(source.metadata ?? {}), linkedConversationId: targetId } })
    .where(eq(S.conversations.id, sourceId));
  return { eventAfterSeq };
}
