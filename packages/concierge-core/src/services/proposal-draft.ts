import { randomUUID } from "node:crypto";
import { DomainError, ErrorCodes, type ProposeBookingInput } from "@voxi/contracts";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { ToolCtx } from "../tools/types.js";
import { assertNoPendingBasketEdits } from "./checkout.js";
import type { ConversationState } from "./conversation.js";
import { resolveLinkedConversation } from "./relink.js";

export type ProposalInput = z.infer<typeof ProposeBookingInput>;
export type ProposalDraft = {
  ref: string;
  customerId: string | null;
  generation: number;
  choices: ProposalInput;
  quotedAt: string;
  quoteExpiresAt: string;
  acceptedActionId?: string;
  activeOrderId: string | null;
};
export const proposalChanged = () =>
  new DomainError(
    ErrorCodes.CONFIRMATION_EXPIRED,
    "That proposal changed. Please check the current proposal before editing or holding seats.",
    false,
    { needs: "proposal_refresh" },
  );

export function currentProposal(conversation: ConversationState): ProposalDraft | undefined {
  const draft = conversation.metadata?.bookingProposalDraft as ProposalDraft | undefined;
  return draft &&
    typeof draft.ref === "string" &&
    draft.choices &&
    draft.customerId === (conversation.customerId ?? null) &&
    draft.generation === Number(conversation.metadata?.widgetAuthGeneration ?? 0)
    ? draft
    : undefined;
}
export function proposalSummary(draft: ProposalDraft | undefined) {
  return draft
    ? {
        proposalRef: draft.ref,
        choices: draft.choices,
        quotedAt: draft.quotedAt,
        quoteExpiresAt: draft.quoteExpiresAt,
        status: draft.acceptedActionId ? "accepted" : "unheld",
      }
    : null;
}
function assertIdentity(ctx: ToolCtx, current: ConversationState | undefined | null) {
  if (
    !current ||
    current.customerId !== ctx.conversation.customerId ||
    Number(current.metadata?.widgetAuthGeneration ?? 0) !==
      Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0)
  )
    throw proposalChanged();
  return current;
}

/** Only an explicit edit can inherit the current server-owned choices. No event/card-history inference. */
export function mergeProposalEdit(base: ProposalInput, change: ProposalInput): ProposalInput {
  const provided = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  const merged = { ...base, ...provided } as ProposalInput;
  const scope = [
    "title",
    "hoCode",
    "cinemaId",
    "cinemaName",
    "date",
    "time",
    "timeFrom",
    "timeTo",
    "experience",
    "filmLanguage",
    "language",
  ];
  if (!change.sessionKey && scope.some((key) => key in provided)) merged.sessionKey = undefined;
  if (change.title !== undefined && change.hoCode === undefined) merged.hoCode = undefined;
  if (change.hoCode !== undefined && change.title === undefined) merged.title = undefined;
  if (change.cinemaName !== undefined && change.cinemaId === undefined) merged.cinemaId = undefined;
  if (change.cinemaId !== undefined && change.cinemaName === undefined) merged.cinemaName = undefined;
  if (change.time !== undefined) {
    merged.timeFrom = undefined;
    merged.timeTo = undefined;
  }
  if (change.timeFrom !== undefined || change.timeTo !== undefined) merged.time = undefined;
  if (change.language !== undefined && change.filmLanguage === undefined) merged.filmLanguage = undefined;
  // A changed party requires fresh supplied ages; matching cardinality alone is not evidence.
  if (
    change.childTickets !== undefined &&
    change.childTickets !== base.childTickets &&
    change.childAges === undefined
  )
    merged.childAges = undefined;
  if ((merged.childTickets ?? 0) === 0 && change.childAges === undefined) merged.childAges = undefined;
  // Exact seats belong to one show. A new show always receives a fresh preview.
  if (merged.sessionKey !== base.sessionKey && change.seats === undefined) merged.seats = undefined;
  return merged;
}

export async function beginProposal(ctx: ToolCtx, input: ProposalInput) {
  if (!input.intent) {
    if (input.baseProposalRef || input.childAges !== undefined)
      throw new DomainError(ErrorCodes.VALIDATION, "Specify initial or edit proposal intent.", false, {
        needs: "proposal_intent",
      });
    return {
      input,
      explicit: false as const,
      expectedRef: undefined,
      expectedAcceptedActionId: undefined,
      expectedActiveOrderId: null,
    };
  }
  if (
    (input.intent === "initial" && input.baseProposalRef) ||
    (input.intent === "edit" && !input.baseProposalRef)
  )
    throw proposalChanged();
  return ctx.db.transaction(async (tx) => {
    const current = assertIdentity(ctx, await resolveLinkedConversation(tx, ctx.conversation.id, true));
    const draft = currentProposal(current);
    await assertNoPendingBasketEdits(
      tx,
      typeof current.metadata?.activeOrder === "string"
        ? `order:${current.metadata.activeOrder}`
        : `conversation:${current.id}`,
      undefined,
      current.id,
    );
    if (input.intent === "edit" && (!draft || draft.ref !== input.baseProposalRef || draft.acceptedActionId))
      throw proposalChanged();
    Object.assign(ctx.conversation, current);
    return {
      input: input.intent === "edit" ? mergeProposalEdit(draft!.choices, input) : input,
      explicit: true as const,
      expectedRef: draft?.ref,
      expectedAcceptedActionId: draft?.acceptedActionId,
      expectedActiveOrderId:
        typeof current.metadata?.activeOrder === "string" ? current.metadata.activeOrder : null,
    };
  });
}

export async function saveProposal(
  ctx: ToolCtx,
  expectedRef: string | undefined,
  choices: ProposalInput,
  expectedAcceptedActionId?: string,
  expectedActiveOrderId: string | null = null,
) {
  return ctx.db.transaction(async (tx) => {
    const current = assertIdentity(ctx, await resolveLinkedConversation(tx, ctx.conversation.id, true));
    if (
      currentProposal(current)?.ref !== expectedRef ||
      currentProposal(current)?.acceptedActionId !== expectedAcceptedActionId
    )
      throw proposalChanged();
    if ((current.metadata?.activeOrder ?? null) !== expectedActiveOrderId) throw proposalChanged();
    await assertNoPendingBasketEdits(
      tx,
      typeof current.metadata?.activeOrder === "string"
        ? `order:${current.metadata.activeOrder}`
        : `conversation:${current.id}`,
      undefined,
      current.id,
    );
    const { intent: _intent, baseProposalRef: _base, ...normalized } = choices;
    const draft: ProposalDraft = {
      ref: `proposal_${randomUUID()}`,
      customerId: current.customerId ?? null,
      generation: Number(current.metadata?.widgetAuthGeneration ?? 0),
      choices: normalized,
      activeOrderId: expectedActiveOrderId,
      quotedAt: new Date().toISOString(),
      quoteExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    };
    const [updated] = await tx
      .update(S.conversations)
      .set({ metadata: { ...current.metadata, bookingProposalDraft: draft } })
      .where(eq(S.conversations.id, current.id))
      .returning();
    Object.assign(ctx.conversation, updated);
    return draft;
  });
}

/** Must run under the conversation row lock, before confirmation invalidation or provider mutation. */
export function assertProposalAcceptance(conversation: ConversationState, ref: string | undefined) {
  const draft = currentProposal(conversation);
  if (
    ref
      ? !draft ||
        draft.ref !== ref ||
        draft.acceptedActionId ||
        draft.activeOrderId !== (conversation.metadata?.activeOrder ?? null) ||
        Date.parse(draft.quoteExpiresAt) <= Date.now()
      : !!draft
  )
    throw proposalChanged();
}
