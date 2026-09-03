import { DomainError, ErrorCodes } from "@voxi/contracts";
import type { Db } from "@voxi/db";
import { schema as S, prefixedId } from "@voxi/db";
/**
 * Confirmation gate for destructive actions. `prepare_*` tools create a pending confirmation whose spoken
 * summary the agent must read back; the matching `cancel_booking` / `swap_booking` / `pay_order` call must
 * cite its id within the TTL. A confirmation can be consumed once.
 */
import { and, eq, gt, isNull } from "drizzle-orm";

export async function createConfirmation(
  db: Db,
  input: {
    conversationId: string;
    actionType: string;
    resourceKey: string;
    summary: Record<string, unknown>;
    spokenSummary: string;
    ttlSeconds: number;
  },
) {
  const id = prefixedId("cnf", 10);
  const [row] = await db
    .insert(S.pendingConfirmations)
    .values({
      id,
      conversationId: input.conversationId,
      actionType: input.actionType,
      resourceKey: input.resourceKey,
      summary: input.summary,
      spokenSummary: input.spokenSummary,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    })
    .returning();
  return row!;
}

/** Validate + consume atomically (single UPDATE with predicates so two concurrent consumers cannot both succeed). */
export async function consumeConfirmation(
  db: Db,
  input: { id: string; conversationId: string; actionType: string; resourceKey?: string },
) {
  const [row] = await db
    .update(S.pendingConfirmations)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(S.pendingConfirmations.id, input.id),
        eq(S.pendingConfirmations.conversationId, input.conversationId),
        eq(S.pendingConfirmations.actionType, input.actionType),
        isNull(S.pendingConfirmations.consumedAt),
        gt(S.pendingConfirmations.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) {
    const any = (
      await db.select().from(S.pendingConfirmations).where(eq(S.pendingConfirmations.id, input.id))
    )[0];
    if (!any)
      throw new DomainError(
        ErrorCodes.CONFIRMATION_REQUIRED,
        "No confirmation found. Call the prepare step first and read the summary to the customer.",
      );
    if (any.consumedAt)
      throw new DomainError(ErrorCodes.CONFIRMATION_REQUIRED, "This confirmation was already used.");
    if (any.expiresAt <= new Date())
      throw new DomainError(
        ErrorCodes.CONFIRMATION_EXPIRED,
        "The confirmation expired. Please prepare the summary again and re-confirm with the customer.",
      );
    throw new DomainError(
      ErrorCodes.CONFIRMATION_REQUIRED,
      "Confirmation does not match this conversation or action.",
    );
  }
  if (input.resourceKey && row.resourceKey !== input.resourceKey)
    throw new DomainError(
      ErrorCodes.CONFIRMATION_REQUIRED,
      "Confirmation was prepared for a different booking/order.",
    );
  return row;
}

/** Peek without consuming (executor re-reads the summary to execute exactly what was confirmed). */
export async function getConfirmation(db: Db, id: string) {
  return (await db.select().from(S.pendingConfirmations).where(eq(S.pendingConfirmations.id, id)))[0] ?? null;
}
