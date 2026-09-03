import type { ConversationContext, Language } from "@voxi/contracts";
import type { Db } from "@voxi/db";
import { schema as S } from "@voxi/db";
/** Conversation state: identity (guest vs logged-in), language, location, mode, active order. */
import { eq, sql } from "drizzle-orm";

export type ConversationState = typeof S.conversations.$inferSelect;

export async function ensureConversation(db: Db, ctx: ConversationContext): Promise<ConversationState> {
  const existing = (
    await db.select().from(S.conversations).where(eq(S.conversations.id, ctx.conversationId))
  )[0];
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

export async function updateConversation(db: Db, id: string, patch: Partial<Omit<ConversationState, "id">>) {
  const [u] = await db.update(S.conversations).set(patch).where(eq(S.conversations.id, id)).returning();
  return u!;
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
  await db
    .update(S.conversations)
    .set({
      journeys: sql`coalesce(${S.conversations.journeys}, '[]'::jsonb) || ${JSON.stringify([{ name, status, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(S.conversations.id, id));
}

export async function addTopic(db: Db, id: string, topic: string) {
  await db
    .update(S.conversations)
    .set({
      topics: sql`(select jsonb_agg(distinct x) from jsonb_array_elements(coalesce(${S.conversations.topics}, '[]'::jsonb) || ${JSON.stringify([topic])}::jsonb) x)`,
    })
    .where(eq(S.conversations.id, id));
}
