/**
 * Conversation event log + in-process pub/sub for SSE. The DB row is the source of truth (every event
 * is persisted with a monotonic seq); the bus only accelerates delivery. Multi-instance deployments can
 * replace `createEventBus` with a Postgres LISTEN/NOTIFY or Redis implementation (EventPort).
 */
import { EventEmitter } from "node:events";
import type { WidgetEvent } from "@voxi/contracts";
import type { Db } from "@voxi/db";
import { schema as S, prefixedId } from "@voxi/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";

export type EventBus = {
  publish(conversationId: string, ev: WidgetEvent): void;
  subscribe(conversationId: string, fn: (ev: WidgetEvent) => void): () => void;
};

export function createEventBus(): EventBus {
  const em = new EventEmitter();
  em.setMaxListeners(10_000);
  return {
    publish: (id, ev) => em.emit(id, ev),
    subscribe: (id, fn) => {
      em.on(id, fn);
      return () => em.off(id, fn);
    },
  };
}

export async function appendEvent(
  db: Db,
  bus: EventBus | null,
  conversationId: string,
  type: string,
  payload: Record<string, unknown>,
  actor: "user" | "agent" | "system" | "human_agent" = "system",
): Promise<{ id: string; seq: number }> {
  // seq allocated atomically per conversation
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`events:${conversationId}`}))`);
    const next = (
      await tx
        .select({ next: sql<number>`coalesce(max(${S.conversationEvents.seq}), 0) + 1` })
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, conversationId))
    )[0]!.next;
    const id = prefixedId("ev", 10);
    await tx
      .insert(S.conversationEvents)
      .values({ id, seq: Number(next), conversationId, type, actor, payload });
    return { id, seq: Number(next) };
  });
  if (bus) {
    const ev = toWidgetEvent(type, row.seq, payload);
    if (ev) bus.publish(conversationId, ev);
  }
  return row;
}

export function toWidgetEvent(
  type: string,
  seq: number,
  payload: Record<string, unknown>,
): WidgetEvent | null {
  switch (type) {
    case "ui.render":
      return {
        type: "ui.render",
        seq,
        ui: payload.ui as WidgetEvent extends { ui: infer U } ? U : never,
      } as WidgetEvent;
    case "action.queued":
      return { type: "action.queued", seq, action: payload.action } as WidgetEvent;
    case "action.completed":
      return { type: "action.completed", seq, action: payload.action, ui: payload.ui } as WidgetEvent;
    case "order.updated":
      return {
        type: "order.updated",
        seq,
        userSessionId: payload.userSessionId,
        summary: payload.summary,
      } as WidgetEvent;
    case "transfer.status":
      return {
        type: "transfer.status",
        seq,
        transferId: payload.transferId,
        status: payload.status,
        agentName: payload.agentName,
      } as WidgetEvent;
    case "human.message":
      return {
        type: "human.message",
        seq,
        transferId: payload.transferId,
        text: payload.text,
        agentName: payload.agentName,
      } as WidgetEvent;
    case "language.changed":
      return { type: "language.changed", seq, language: payload.language } as WidgetEvent;
    default:
      return null;
  }
}

export async function eventsSince(db: Db, conversationId: string, afterSeq: number) {
  return db
    .select()
    .from(S.conversationEvents)
    .where(
      and(eq(S.conversationEvents.conversationId, conversationId), gt(S.conversationEvents.seq, afterSeq)),
    )
    .orderBy(asc(S.conversationEvents.seq));
}
