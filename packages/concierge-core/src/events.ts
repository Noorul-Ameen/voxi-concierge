/**
 * Conversation event log + in-process pub/sub for SSE. The DB row is the source of truth (every event
 * is persisted with a monotonic seq); the bus only accelerates delivery. Multi-instance deployments can
 * replace `createEventBus` with a Postgres LISTEN/NOTIFY or Redis implementation (EventPort).
 */
import { EventEmitter } from "node:events";
import type { WidgetEvent } from "@voxi/contracts";
import type { Db, Sql } from "@voxi/db";
import { schema as S, prefixedId } from "@voxi/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { resolveLinkedConversation } from "./services/relink.js";

export type EventBus = {
  publish(conversationId: string, ev: WidgetEvent): void;
  subscribe(conversationId: string, fn: (ev: WidgetEvent) => void): () => void;
};

/**
 * Cross-process bus on Postgres LISTEN/NOTIFY: the worker publishes, API instances fan out to SSE.
 * Only {conversationId, seq} travels on the channel; subscribers re-read the persisted event row.
 */
export function createPgEventBus(
  sql: Sql,
  db: Db,
  channel = "voxi_events",
): EventBus & { ready: () => Promise<void>; close: () => Promise<void> } {
  const local = createEventBus();
  const subscribers = new Map<string, number>();
  let listener: { unlisten: () => Promise<void> } | null = null;
  let listening: Promise<void> | null = null;
  const ensureListening = async () => {
    if (listener) return;
    if (listening) return listening;
    listening = sql
      .listen(channel, async (payload) => {
        try {
          const { conversationId, seq } = JSON.parse(payload) as { conversationId: string; seq: number };
          if (!subscribers.get(conversationId)) return;
          const row = (
            await db
              .select()
              .from(S.conversationEvents)
              .where(
                and(
                  eq(S.conversationEvents.conversationId, conversationId),
                  eq(S.conversationEvents.seq, seq),
                ),
              )
          )[0];
          if (!row) return;
          const ev = toWidgetEvent(row.type, row.seq, row.payload, row.id);
          if (ev) local.publish(conversationId, ev);
        } catch {
          /* ignore malformed notifications */
        }
      })
      .then((registered) => {
        listener = registered;
      })
      .catch((error) => {
        listening = null;
        throw error;
      });
    return listening;
  };
  return {
    ready: ensureListening,
    publish: (conversationId, ev) => {
      void sql.notify(channel, JSON.stringify({ conversationId, seq: ev.seq })).catch(() => undefined);
    },
    subscribe: (conversationId, fn) => {
      subscribers.set(conversationId, (subscribers.get(conversationId) ?? 0) + 1);
      void ensureListening().catch(() => undefined);
      const off = local.subscribe(conversationId, fn);
      return () => {
        off();
        const n = (subscribers.get(conversationId) ?? 1) - 1;
        if (n <= 0) subscribers.delete(conversationId);
        else subscribers.set(conversationId, n);
      };
    },
    close: async () => {
      await listening?.catch(() => undefined);
      await listener?.unlisten();
      listener = null;
      listening = null;
    },
  };
}

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
  expectedAuthGeneration?: number,
): Promise<{ id: string; seq: number }> {
  // seq allocated atomically per conversation
  const row = await db.transaction(async (tx) => {
    const current = await resolveLinkedConversation(tx, conversationId, true);
    const liveId = current?.id ?? conversationId;
    const stale =
      expectedAuthGeneration != null &&
      expectedAuthGeneration !== Number(current?.metadata?.widgetAuthGeneration ?? 0);
    const eventType = stale ? "audit.stale_ui" : type;
    const eventPayload = stale
      ? { ...payload, originalType: type, widgetAuthGeneration: expectedAuthGeneration }
      : payload;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`events:${liveId}`}))`);
    const next = (
      await tx
        .select({ next: sql<number>`coalesce(max(${S.conversationEvents.seq}), 0) + 1` })
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, liveId))
    )[0]!.next;
    const id = prefixedId("ev", 10);
    await tx.insert(S.conversationEvents).values({
      id,
      seq: Number(next),
      conversationId: liveId,
      type: eventType,
      actor,
      payload: eventPayload,
    });
    return { id, seq: Number(next), conversationId: liveId, type: eventType };
  });
  if (bus) {
    const ev = toWidgetEvent(row.type, row.seq, payload, row.id);
    if (ev) bus.publish(row.conversationId, ev);
  }
  return row;
}

export function toWidgetEvent(
  type: string,
  seq: number,
  payload: Record<string, unknown>,
  rowId?: string,
): WidgetEvent | null {
  // A copied event keeps its original identity across any number of reconnects.
  // seq remains local to the current conversation for transport replay cursors.
  const eventId = typeof payload.linkedFromEventId === "string" ? payload.linkedFromEventId : rowId;
  switch (type) {
    case "ui.render":
      return {
        type: "ui.render",
        seq,
        eventId,
        ui: payload.ui as WidgetEvent extends { ui: infer U } ? U : never,
      } as WidgetEvent;
    case "action.queued":
      return { type: "action.queued", seq, eventId, action: payload.action } as WidgetEvent;
    case "action.completed":
      return {
        type: "action.completed",
        seq,
        eventId,
        action: payload.action,
        ui: payload.ui,
      } as WidgetEvent;
    case "order.updated":
      return {
        type: "order.updated",
        seq,
        eventId,
        userSessionId: payload.userSessionId,
        summary: payload.summary,
      } as WidgetEvent;
    case "transfer.status":
      return {
        type: "transfer.status",
        seq,
        eventId,
        transferId: payload.transferId,
        status: payload.status,
        agentName: payload.agentName,
      } as WidgetEvent;
    case "human.message":
      return {
        type: "human.message",
        seq,
        eventId,
        transferId: payload.transferId,
        text: payload.text,
        agentName: payload.agentName,
      } as WidgetEvent;
    case "language.changed":
      return { type: "language.changed", seq, eventId, language: payload.language } as WidgetEvent;
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
