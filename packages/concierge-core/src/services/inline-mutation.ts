/** Durable visibility for inline quick tools while their provider calls are in progress. */
import { DomainError, ErrorCodes } from "@voxi/contracts";
import { type Db, schema as S, prefixedId } from "@voxi/db";
import { and, eq, sql } from "drizzle-orm";
import type { ActionRow } from "../actions/ledger.js";
import type { ToolResult } from "../tools/types.js";
import { assertNoPendingBasketEdits, invalidatePaymentConfirmations } from "./checkout.js";
import { resolveLinkedConversation } from "./relink.js";

export async function beginInlineBasketMutation(
  db: Db,
  input: {
    conversationId: string;
    type: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    toolCallId: string;
    authGeneration: number;
  },
) {
  try {
    return await db.transaction(async (tx) => {
      const conversation = await resolveLinkedConversation(tx, input.conversationId, true);
      if (!conversation || Number(conversation.metadata?.widgetAuthGeneration ?? 0) !== input.authGeneration)
        throw new DomainError(
          ErrorCodes.ORDER_INVALID_STATE,
          "Your session changed. Please check the current booking before continuing.",
        );
      const active = conversation.metadata?.activeOrder;
      const resource =
        typeof active === "string" && active ? `order:${active}` : `conversation:${conversation.id}`;
      await assertNoPendingBasketEdits(tx, resource, undefined, conversation.id);
      await invalidatePaymentConfirmations(tx, resource);
      const [action] = await tx
        .insert(S.actions)
        .values({
          id: prefixedId("act", 12),
          conversationId: conversation.id,
          type: input.type,
          // Remains valid when the tool creates/replaces an order partway through its provider calls.
          resourceKey: `conversation:${conversation.id}`,
          idempotencyKey: input.idempotencyKey,
          input: { ...input.payload, _widgetAuthGeneration: input.authGeneration },
          status: "running",
          attempts: 1,
          maxAttempts: 1,
          lockedBy: `inline:${prefixedId("run", 8)}`,
          leaseUntil: new Date(Date.now() + 120_000),
          startedAt: new Date(),
          toolCallId: input.toolCallId,
        })
        .returning();
      return { action: action!, conversation };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new DomainError(
        ErrorCodes.ORDER_INVALID_STATE,
        "An order update or payment is still running. Check its result before making another change.",
        true,
      );
    throw error;
  }
}

export async function finishInlineBasketMutation(db: Db, action: ActionRow, result: ToolResult) {
  const rows = await db
    .update(S.actions)
    .set({
      status: result.ok ? "succeeded" : "failed",
      result: { toolResult: result },
      error: result.error ? { ...result.error, retryable: result.error.retryable ?? false } : null,
      finishedAt: new Date(),
      leaseUntil: null,
      lockedBy: null,
    })
    .where(
      and(
        eq(S.actions.id, action.id),
        eq(S.actions.status, "running"),
        eq(S.actions.lockedBy, action.lockedBy!),
        eq(S.actions.attempts, action.attempts),
        sql`${S.actions.leaseUntil} > now()`,
      ),
    )
    .returning({ id: S.actions.id });
  return rows.length > 0;
}
