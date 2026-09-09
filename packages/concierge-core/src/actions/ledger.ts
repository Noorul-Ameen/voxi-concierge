import type { ActionRef } from "@voxi/contracts";
import type { Db } from "@voxi/db";
import { schema as S, prefixedId } from "@voxi/db";
/**
 * ACTION LEDGER — asynchronous, idempotent, per-conversation-serialised execution of state-changing work.
 * See docs/01-solution-architecture.md §7.
 *
 *  enqueue()   — inserts (or returns the existing row for the same idempotency key). Never executes.
 *  claimNext() — worker: picks the oldest queued action whose conversation has no running action,
 *                using FOR UPDATE SKIP LOCKED + the partial unique index actions_one_running_per_conversation.
 *  complete()/fail() — persist the outcome, emit action.completed.
 *  waitFor()   — read side: poll the ledger row until finished or timeout (used by get_action_result).
 */
import { and, eq, sql } from "drizzle-orm";
import { type EventBus, appendEvent } from "../events.js";
import { resolveLinkedConversation } from "../services/relink.js";

export type ActionRow = typeof S.actions.$inferSelect;

export function toRef(a: ActionRow): ActionRef {
  return {
    actionId: a.id,
    type: a.type,
    status: a.status,
    result: a.result ?? undefined,
    error: a.error
      ? { code: a.error.code, message: a.error.message, retryable: a.error.retryable }
      : undefined,
  };
}

export async function enqueue(
  db: Db,
  bus: EventBus | null,
  input: {
    conversationId: string;
    type: string;
    resourceKey: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    requestedBy?: "agent" | "widget" | "system";
    toolCallId?: string;
    correlationId?: string;
    maxAttempts?: number;
  },
): Promise<{ action: ActionRow; created: boolean }> {
  const existing = (
    await db.select().from(S.actions).where(eq(S.actions.idempotencyKey, input.idempotencyKey))
  )[0];
  if (existing) return { action: existing, created: false };
  const id = prefixedId("act", 12);
  try {
    const row = await db.transaction(async (tx) => {
      const current = await resolveLinkedConversation(tx, input.conversationId, true);
      const [inserted] = await tx
        .insert(S.actions)
        .values({
          id,
          conversationId: current?.id ?? input.conversationId,
          idempotencyKey: input.idempotencyKey,
          type: input.type,
          resourceKey: input.resourceKey,
          input: {
            ...input.payload,
            _widgetAuthGeneration: Number(current?.metadata?.widgetAuthGeneration ?? 0),
          },
          status: "queued",
          requestedBy: input.requestedBy ?? "agent",
          toolCallId: input.toolCallId ?? null,
          correlationId: input.correlationId ?? null,
          maxAttempts: input.maxAttempts ?? 3,
        })
        .returning();
      return inserted!;
    });
    await appendEvent(
      db,
      bus,
      input.conversationId,
      "action.queued",
      { action: toRef(row!) },
      input.requestedBy === "widget" ? "user" : (input.requestedBy ?? "agent"),
      Number(row.input._widgetAuthGeneration ?? 0),
    );
    return { action: row!, created: true };
  } catch (e) {
    // unique violation race: another request inserted the same key concurrently
    if ((e as { code?: string }).code === "23505") {
      const again = (
        await db.select().from(S.actions).where(eq(S.actions.idempotencyKey, input.idempotencyKey))
      )[0];
      if (again) return { action: again, created: false };
    }
    throw e;
  }
}

export async function findByKey(db: Db, idempotencyKey: string): Promise<ActionRow | null> {
  return (await db.select().from(S.actions).where(eq(S.actions.idempotencyKey, idempotencyKey)))[0] ?? null;
}

export async function get(db: Db, actionId: string): Promise<ActionRow | null> {
  return (await db.select().from(S.actions).where(eq(S.actions.id, actionId)))[0] ?? null;
}

export async function waitFor(
  db: Db,
  actionId: string,
  timeoutMs: number,
  intervalMs = 150,
): Promise<ActionRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await get(db, actionId);
    if (!row) return null;
    if (row.status !== "queued" && row.status !== "running") return row;
    if (Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Claim the next runnable action. The partial unique index guarantees a second worker cannot mark a
 * second action `running` for the same conversation; SKIP LOCKED avoids two workers fighting over rows.
 */
export async function claimNext(db: Db, workerId: string, leaseSeconds = 120): Promise<ActionRow | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select a.id from actions a
      where a.status = 'queued'
        and a.attempts < a.max_attempts
        and not exists (select 1 from actions r where r.conversation_id = a.conversation_id and r.status = 'running')
      order by a.created_at asc
      limit 1
      for update skip locked`);
    const id = (rows as unknown as { id: string }[])[0]?.id;
    if (!id) return null;
    try {
      const [row] = await tx
        .update(S.actions)
        .set({
          status: "running",
          attempts: sql`${S.actions.attempts} + 1`,
          startedAt: new Date(),
          lockedBy: workerId,
          leaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        })
        .where(and(eq(S.actions.id, id), eq(S.actions.status, "queued")))
        .returning();
      return row ?? null;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return null; // lost the per-conversation race; try again later
      throw e;
    }
  });
}

/** A claimed attempt is the fencing token; an expired owner must not extend or finish newer work. */
function ownedAttempt(action: ActionRow) {
  return and(
    eq(S.actions.id, action.id),
    eq(S.actions.status, "running"),
    eq(S.actions.attempts, action.attempts),
    action.lockedBy ? eq(S.actions.lockedBy, action.lockedBy) : sql`false`,
    sql`${S.actions.leaseUntil} > now()`,
  );
}

export async function renewLease(db: Db, action: ActionRow, leaseSeconds = 120): Promise<boolean> {
  const rows = await db
    .update(S.actions)
    .set({ leaseUntil: new Date(Date.now() + leaseSeconds * 1000) })
    .where(ownedAttempt(action))
    .returning({ id: S.actions.id });
  return rows.length === 1;
}

export async function complete(
  db: Db,
  bus: EventBus | null,
  action: ActionRow,
  result: Record<string, unknown>,
  ui?: Record<string, unknown>,
  steps?: ActionRow["steps"],
) {
  const [row] = await db
    .update(S.actions)
    .set({
      status: "succeeded",
      result: { ...result, ...(ui ? { ui } : {}) },
      finishedAt: new Date(),
      lockedBy: null,
      leaseUntil: null,
      ...(steps ? { steps } : {}),
    })
    .where(ownedAttempt(action))
    .returning();
  if (!row) return null;
  await appendEvent(
    db,
    bus,
    row.conversationId,
    "action.completed",
    { action: toRef(row!), ui },
    "system",
    Number(action.input._widgetAuthGeneration ?? 0),
  );
  return row!;
}

export async function fail(
  db: Db,
  bus: EventBus | null,
  action: ActionRow,
  error: { code: string; message: string; retryable: boolean; detail?: unknown },
  opts: { conflict?: boolean; steps?: ActionRow["steps"] } = {},
) {
  const willRetry = error.retryable && action.attempts < action.maxAttempts && !opts.conflict;
  const status = willRetry ? "queued" : opts.conflict ? "conflict" : "failed";
  const [row] = await db
    .update(S.actions)
    .set({
      status,
      error,
      finishedAt: willRetry ? null : new Date(),
      lockedBy: null,
      leaseUntil: null,
      ...(opts.steps ? { steps: opts.steps } : {}),
    })
    .where(ownedAttempt(action))
    .returning();
  if (!row) return null;
  if (!willRetry)
    await appendEvent(
      db,
      bus,
      row.conversationId,
      "action.completed",
      { action: toRef(row!) },
      "system",
      Number(action.input._widgetAuthGeneration ?? 0),
    );
  return row!;
}

/** Recover actions whose worker died mid-flight (lease expired) — they go back to queued for retry. */
export async function reclaimExpiredLeases(db: Db): Promise<number> {
  const rows = await db
    .update(S.actions)
    .set({
      status: sql`case when ${S.actions.attempts} >= ${S.actions.maxAttempts} then 'failed' else 'queued' end`,
      lockedBy: null,
      leaseUntil: null,
      finishedAt: sql`case when ${S.actions.attempts} >= ${S.actions.maxAttempts} then now() else null end`,
      error: {
        code: "LEASE_EXPIRED",
        message: "The action did not finish before its worker lease expired.",
        retryable: false,
      },
    })
    .where(and(eq(S.actions.status, "running"), sql`${S.actions.leaseUntil} < now()`))
    .returning({ id: S.actions.id });
  return rows.length;
}

export const idem = (conversationId: string, key: string) => `${conversationId}:${key}`.slice(0, 160);
