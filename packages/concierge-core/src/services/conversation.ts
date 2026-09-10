import type { ConversationContext, Language } from "@voxi/contracts";
import type { Db } from "@voxi/db";
import { schema as S } from "@voxi/db";
/** Conversation state: identity (guest vs logged-in), language, location, mode, active order. */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { resolveLinkedConversation } from "./relink.js";

export type ConversationState = typeof S.conversations.$inferSelect;

export async function ensureConversation(
  db: Db,
  ctx: Pick<ConversationContext, "conversationId"> & Partial<Omit<ConversationContext, "conversationId">>,
): Promise<ConversationState> {
  const existing = await resolveLinkedConversation(db, ctx.conversationId);
  if (existing) {
    // refresh cheap context fields the widget may have updated
    const patch: Partial<ConversationState> = {};
    if (ctx.lat != null && ctx.lng != null && (!existing.geo || existing.geo.lat !== ctx.lat))
      patch.geo = { lat: ctx.lat, lng: ctx.lng };
    if (ctx.language && ctx.language !== existing.language) patch.language = ctx.language;
    if (ctx.modality && ctx.modality !== existing.modality && existing.modality !== "mixed")
      patch.modality = ctx.modality === existing.modality ? existing.modality : "mixed";
    if (Object.keys(patch).length) {
      const [u] = await db
        .update(S.conversations)
        .set(patch)
        .where(eq(S.conversations.id, existing.id))
        .returning();
      return u!;
    }
    return existing;
  }
  const [row] = await db
    .insert(S.conversations)
    .values({
      id: ctx.conversationId,
      channel: ctx.channel ?? "web",
      modality: ctx.modality ?? "text",
      language: ctx.language ?? "en",
      customerId: ctx.customerId ?? null,
      memberId: ctx.memberId ?? null,
      isLoggedIn: !!ctx.customerId,
      geo: ctx.lat != null && ctx.lng != null ? { lat: ctx.lat, lng: ctx.lng } : null,
    })
    .onConflictDoNothing()
    .returning();
  return (
    row ?? (await db.select().from(S.conversations).where(eq(S.conversations.id, ctx.conversationId)))[0]!
  );
}

export async function updateConversation(
  db: Db,
  id: string,
  patch: Partial<Omit<ConversationState, "id">>,
  expectedAuthGeneration?: number,
) {
  return db.transaction(async (tx) => {
    const current = await resolveLinkedConversation(tx, id, true);
    if (!current) throw new Error("Conversation not found");
    if (
      expectedAuthGeneration != null &&
      expectedAuthGeneration !== Number(current.metadata?.widgetAuthGeneration ?? 0)
    )
      return current;
    const next = { ...patch };
    const suppliedGeneration = Number(patch.metadata?.widgetAuthGeneration ?? 0);
    if (patch.metadata && suppliedGeneration !== Number(current.metadata?.widgetAuthGeneration ?? 0)) {
      // A logout/account switch happened during the worker call. Never restore the previous basket.
      next.metadata = undefined;
    }
    if (next.metadata) {
      const {
        widgetSessionKey: _key,
        widgetConversationId: _widget,
        widgetEventAfterSeq: _floor,
        widgetAuthGeneration: _generation,
        linkedConversationId: _link,
        ...business
      } = next.metadata;
      next.metadata = { ...(current.metadata ?? {}), ...business };
    }
    if (Object.values(next).every((value) => value === undefined)) return current;
    const [updated] = await tx
      .update(S.conversations)
      .set(next)
      .where(eq(S.conversations.id, current.id))
      .returning();
    return updated!;
  });
}

export async function setLanguage(db: Db, id: string, language: Language) {
  return updateConversation(db, id, { language });
}

export async function markJourney(
  db: Db,
  id: string,
  name: string,
  status: "completed" | "abandoned" | "failed",
) {
  const current = await resolveLinkedConversation(db, id);
  await db
    .update(S.conversations)
    .set({
      journeys: sql`coalesce(${S.conversations.journeys}, '[]'::jsonb) || ${JSON.stringify([{ name, status, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(S.conversations.id, current?.id ?? id));
}

const bookingCompletionNames = new Set([
  "booking",
  "guided_booking",
  "quick_booking",
  "quick_book",
  "ticket_booking",
  "book_tickets",
  "booking_v2",
  "booking_resume",
  "booking_recovery",
  "resume_order",
  "recover_order",
  "checkout",
  "payment",
]);

/** Model-reported checkout success needs a completed server payment, never merely a seat hold. */
export async function markAgentJourney(
  db: Db,
  id: string,
  name: string,
  status: "completed" | "abandoned" | "failed",
  expectedAuthGeneration: number,
) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (status !== "completed" || !bookingCompletionNames.has(normalized)) {
    await markJourney(db, id, name, status);
    return { logged: true };
  }
  return db.transaction(async (tx) => {
    const current = await resolveLinkedConversation(tx, id, true);
    const metadata = current?.metadata ?? {};
    if (!current || Number(metadata.widgetAuthGeneration ?? 0) !== expectedAuthGeneration)
      return { logged: false, reason: "session_changed" };
    const paymentJourney = normalized === "payment" || normalized === "checkout";
    const active = paymentJourney ? (metadata.fnbOrder ?? metadata.activeOrder) : metadata.activeOrder;
    const orderId = typeof active === "string" && active ? active : undefined;
    const lastBooking = paymentJourney
      ? (metadata.lastFnbBookingId ?? metadata.lastBookingId)
      : metadata.lastBookingId;
    const actions = await tx
      .select()
      .from(S.actions)
      .where(
        and(
          eq(S.actions.type, "pay_order"),
          eq(S.actions.status, "succeeded"),
          or(
            eq(S.actions.conversationId, current.id),
            typeof lastBooking === "string"
              ? sql`${S.actions.result}->>'bookingId' = ${lastBooking}`
              : undefined,
          ),
          orderId ? eq(S.actions.resourceKey, `order:${orderId}`) : undefined,
        ),
      )
      .orderBy(desc(S.actions.createdAt));
    const paid = actions.find((action) => {
      const booking = action.result?.booking as { ticketCount?: number } | undefined;
      return (
        typeof action.result?.bookingId === "string" &&
        !!action.result.bookingId &&
        Number(action.input._widgetAuthGeneration ?? 0) === expectedAuthGeneration &&
        (paymentJourney || Number(booking?.ticketCount ?? 0) > 0)
      );
    });
    if (!paid) return { logged: false, reason: "payment_not_confirmed" };
    if (current.journeys?.some((journey) => journey.name === normalized && journey.status === "completed"))
      return { logged: false, reason: "already_recorded" };
    await tx
      .update(S.conversations)
      .set({
        journeys: [
          ...(current.journeys ?? []),
          { name: normalized, status: "completed", at: new Date().toISOString() },
        ],
      })
      .where(eq(S.conversations.id, current.id));
    return { logged: true };
  });
}

export async function addTopic(db: Db, id: string, topic: string) {
  await db
    .update(S.conversations)
    .set({
      topics: sql`(select jsonb_agg(distinct x) from jsonb_array_elements(coalesce(${S.conversations.topics}, '[]'::jsonb) || ${JSON.stringify([topic])}::jsonb) x)`,
    })
    .where(eq(S.conversations.id, id));
}
