import { DomainError, ErrorCodes } from "@voxi/contracts";
import { type Db, schema as S, prefixedId } from "@voxi/db";
import { centsToPoints } from "@voxi/domain";
import { and, eq } from "drizzle-orm";
import { type ActionRow, toRef } from "../actions/ledger.js";
import { appendEvent } from "../events.js";
import type { ToolCtx } from "../tools/types.js";
import {
  assertCheckoutSnapshot,
  assertNoPendingBasketEdits,
  checkoutSnapshot,
  invalidatePaymentConfirmations,
} from "./checkout.js";
import { createConfirmation } from "./confirmations.js";
import { money, t } from "./format.js";
import { orderSummary } from "./order-state.js";
import { resolveLinkedConversation } from "./relink.js";

type BalanceMethod = "VOX_CREDIT" | "SHARE_POINTS";
type Intent = {
  purpose: "reserve_and_open_card_review";
  userSessionId: string;
  customerId: string;
  memberId: string;
  authGeneration: number;
  balanceType: BalanceMethod;
  reserveCents: number;
  remainingCents: number;
  amountCents: number;
  checkoutSnapshot: ReturnType<typeof checkoutSnapshot>;
  cartFingerprint: string;
  expiresAtUtc: string;
};

const refusal = (message: string) => new DomainError(ErrorCodes.CONFIRMATION_REQUIRED, message);
const generation = (c: { metadata: Record<string, unknown> | null }) =>
  Number(c.metadata?.widgetAuthGeneration ?? 0);

function assertOwner(current: Awaited<ReturnType<typeof resolveLinkedConversation>>, intent: Intent) {
  const preference = current?.metadata?.paymentPreference as
    | { userSessionId?: string; method?: string }
    | undefined;
  if (
    !current?.isLoggedIn ||
    current.customerId !== intent.customerId ||
    current.memberId !== intent.memberId ||
    generation(current) !== intent.authGeneration ||
    current.metadata?.activeOrder !== intent.userSessionId ||
    preference?.userSessionId !== intent.userSessionId ||
    preference.method !== intent.balanceType
  )
    throw refusal("This balance review no longer belongs to the active signed-in booking.");
}

function assertActive(order: Record<string, any>, intent: Intent) {
  if (
    order.UserSessionId !== intent.userSessionId ||
    (order.CustomerId && order.CustomerId !== intent.customerId) ||
    ["paid", "cancelled", "expired"].includes(order.State) ||
    !Number.isFinite(Date.parse(order.ExpiryDateUtc)) ||
    Date.parse(order.ExpiryDateUtc) <= Date.now() ||
    order.ExpiryDateUtc !== intent.expiresAtUtc
  )
    throw refusal("The original unpaid hold is no longer available. Review it before continuing.");
}

/** Price-independent cart identity; only the explicitly accepted loyalty reservation may change. */
function cartFingerprint(order: Record<string, any>) {
  return checkoutSnapshot({
    UserSessionId: order.UserSessionId,
    CinemaId: order.CinemaId,
    Sessions: order.Sessions,
    Concessions: order.Concessions,
    BookingFees: order.BookingFees,
    TaxValueCents: order.TaxValueCents,
    BookingFeeValueCents: order.BookingFeeValueCents,
    AppliedOffers: (order.AppliedOffers ?? []).filter((x: any) => x.type !== "loyalty_redeem"),
    ExpiryDateUtc: order.ExpiryDateUtc,
  }).fingerprint;
}

function assertReserved(order: Record<string, any>, intent: Intent) {
  assertActive(order, intent);
  const balances = (order.AppliedOffers ?? []).filter((x: any) => x.type === "loyalty_redeem");
  if (
    cartFingerprint(order) !== intent.cartFingerprint ||
    balances.length !== 1 ||
    balances[0].offerId !== (intent.balanceType === "VOX_CREDIT" ? "VOX_REWARDS" : "SHARE_POINTS") ||
    Number(order.LoyaltyPointsPayableValueInCents) !== intent.reserveCents ||
    Number(order.TotalValueCents) !== intent.remainingCents
  )
    throw refusal("The balance or basket changed. A fresh review decision is required.");
}

export async function prepareBalanceReview(
  ctx: ToolCtx,
  order: Record<string, any>,
  balanceType: BalanceMethod,
  reserveCents: number,
) {
  const intent: Intent = {
    purpose: "reserve_and_open_card_review",
    userSessionId: order.UserSessionId,
    customerId: ctx.conversation.customerId!,
    memberId: ctx.conversation.memberId!,
    authGeneration: generation(ctx.conversation),
    balanceType,
    reserveCents,
    remainingCents: order.TotalValueCents - reserveCents,
    amountCents: order.TotalValueCents,
    checkoutSnapshot: checkoutSnapshot(order),
    cartFingerprint: cartFingerprint(order),
    expiresAtUtc: order.ExpiryDateUtc,
  };
  assertActive(order, intent);
  if (reserveCents <= 0 || intent.remainingCents <= 0)
    throw refusal("A positive balance and card remainder are required.");
  return createConfirmation(ctx.db, {
    conversationId: ctx.conversation.id,
    actionType: "redeem_points",
    resourceKey: `order:${intent.userSessionId}`,
    summary: intent,
    spokenSummary: `Reserve ${reserveCents} fils from ${balanceType} and open the ${intent.remainingCents}-fils card review; no charge.`,
    ttlSeconds: Math.min(
      ctx.cfg.confirmationTtlSeconds,
      (Date.parse(intent.expiresAtUtc) - Date.now()) / 1000,
    ),
    validateBeforeCreate: async (current) => {
      assertOwner(current, intent);
      assertCheckoutSnapshot((await ctx.vista.getOrder(intent.userSessionId)).Order ?? {}, intent);
    },
  });
}

export async function enqueueBalanceReview(
  ctx: ToolCtx,
  input: {
    userSessionId: string;
    confirmationId?: string;
    confirmed?: boolean;
    balanceType?: BalanceMethod;
    amountCents?: number;
    points?: number;
  },
) {
  if (!input.confirmationId || input.confirmed !== true)
    throw refusal("Accept the prepared balance split and card review first.");
  const value = await ctx.db.transaction(async (tx) => {
    const current = await resolveLinkedConversation(tx, ctx.conversation.id, true);
    const [conf] = await tx
      .select()
      .from(S.pendingConfirmations)
      .where(eq(S.pendingConfirmations.id, input.confirmationId!))
      .for("update");
    const intent = conf?.summary as Intent | undefined;
    const confirmationOwner = conf ? await resolveLinkedConversation(tx, conf.conversationId) : null;
    if (
      !conf ||
      !intent ||
      conf.actionType !== "redeem_points" ||
      intent.purpose !== "reserve_and_open_card_review" ||
      confirmationOwner?.id !== current?.id ||
      conf.resourceKey !== `order:${input.userSessionId}` ||
      input.balanceType !== intent.balanceType ||
      (intent.balanceType === "VOX_CREDIT"
        ? input.amountCents !== intent.reserveCents || input.points != null
        : input.points !== centsToPoints(intent.reserveCents) || input.amountCents != null)
    )
      throw refusal("The accepted split does not match this order, balance or amount.");
    assertOwner(current, intent);
    const key = `balance-review:${conf.id}`;
    const [existing] = await tx.select().from(S.actions).where(eq(S.actions.idempotencyKey, key));
    if (existing) {
      const actionOwner = await resolveLinkedConversation(tx, existing.conversationId);
      if (
        actionOwner?.id !== current!.id ||
        Number(existing.input._widgetAuthGeneration) !== intent.authGeneration
      )
        throw refusal("The balance action belongs to a different session.");
      if (conf.expiresAt <= new Date())
        throw refusal("The split confirmation expired. Review the current booking again.");
      // A completed action can be returned to the UI only while its exact reserved basket is still current.
      if (existing.status === "succeeded") {
        const checkpoint = existing.steps.find((x) => x.name === "balance_reserved")?.detail as
          | { snapshot?: ReturnType<typeof checkoutSnapshot> }
          | undefined;
        const order = (await ctx.vista.getOrder(intent.userSessionId)).Order ?? {};
        assertReserved(order, intent);
        assertCheckoutSnapshot(order, {
          amountCents: intent.remainingCents,
          checkoutSnapshot: checkpoint?.snapshot,
        });
        await assertNoPendingBasketEdits(tx, conf.resourceKey, existing.id, current!.id);
      }
      // A failed review can retry its already-reserved stage, without repeating the provider mutation.
      if (existing.status === "succeeded" && existing.result?.paymentReviewOpened === false) {
        const [requeued] = await tx
          .update(S.actions)
          .set({
            status: "queued",
            result: null,
            error: null,
            finishedAt: null,
            maxAttempts: existing.attempts + 3,
          })
          .where(eq(S.actions.id, existing.id))
          .returning();
        return { action: requeued!, created: true };
      }
      return { action: existing, created: false };
    }
    if (conf.consumedAt || conf.expiresAt <= new Date())
      throw refusal("The split confirmation expired or was already used.");
    const order = (await ctx.vista.getOrder(intent.userSessionId)).Order ?? {};
    assertActive(order, intent);
    assertCheckoutSnapshot(order, intent);
    await assertNoPendingBasketEdits(tx, conf.resourceKey, undefined, current!.id);
    await invalidatePaymentConfirmations(tx, conf.resourceKey, conf.id);
    await tx
      .update(S.pendingConfirmations)
      .set({ consumedAt: new Date() })
      .where(eq(S.pendingConfirmations.id, conf.id));
    const [action] = await tx
      .insert(S.actions)
      .values({
        id: prefixedId("act", 12),
        conversationId: current!.id,
        type: "redeem_points",
        resourceKey: conf.resourceKey,
        idempotencyKey: key,
        input: {
          userSessionId: intent.userSessionId,
          balanceType: intent.balanceType,
          memberId: intent.memberId,
          confirmationId: conf.id,
          balanceReview: true,
          _widgetAuthGeneration: intent.authGeneration,
          ...(intent.balanceType === "VOX_CREDIT"
            ? { amountCents: intent.reserveCents }
            : { points: centsToPoints(intent.reserveCents) }),
        },
        requestedBy: "agent",
        toolCallId: ctx.toolCallId,
        correlationId: ctx.correlationId,
      })
      .returning();
    return { action: action!, created: true };
  });
  if (value.created)
    await appendEvent(
      ctx.db,
      ctx.events,
      value.action.conversationId,
      "action.queued",
      { action: toRef(value.action) },
      "agent",
      Number(value.action.input._widgetAuthGeneration),
    );
  return value;
}

/** One durable action reserves the accepted balance and prepares (never pays) the card remainder. */
export async function executeBalanceReview(ctx: ToolCtx, action: ActionRow, steps: ActionRow["steps"]) {
  return ctx.db.transaction(async (tx) => {
    const current = await resolveLinkedConversation(tx, action.conversationId, true);
    const [liveAction] = await tx.select().from(S.actions).where(eq(S.actions.id, action.id)).for("update");
    if (
      !liveAction ||
      liveAction.status !== "running" ||
      liveAction.attempts !== action.attempts ||
      liveAction.lockedBy !== action.lockedBy
    )
      throw refusal("This action attempt is no longer current.");
    const [conf] = await tx
      .select()
      .from(S.pendingConfirmations)
      .where(eq(S.pendingConfirmations.id, String(action.input.confirmationId)))
      .for("update");
    const intent = conf?.summary as Intent | undefined;
    const confirmationOwner = conf ? await resolveLinkedConversation(tx, conf.conversationId) : null;
    if (
      !conf?.consumedAt ||
      conf.expiresAt <= new Date() ||
      conf.actionType !== "redeem_points" ||
      !intent ||
      intent.purpose !== "reserve_and_open_card_review" ||
      confirmationOwner?.id !== current?.id ||
      conf.resourceKey !== action.resourceKey ||
      intent.authGeneration !== Number(action.input._widgetAuthGeneration)
    )
      throw refusal("The accepted balance review is no longer current.");
    assertOwner(current, intent);
    await assertNoPendingBasketEdits(tx, action.resourceKey, action.id, current!.id);
    let order = (await ctx.vista.getOrder(intent.userSessionId)).Order ?? {};
    assertActive(order, intent);
    const reservedStep = liveAction.steps.find((x) => x.name === "balance_reserved")?.detail as
      | { snapshot: ReturnType<typeof checkoutSnapshot>; redeemed: Record<string, unknown> }
      | undefined;
    let redeemed = reservedStep?.redeemed;
    if (reservedStep) {
      assertReserved(order, intent);
      assertCheckoutSnapshot(order, {
        amountCents: intent.remainingCents,
        checkoutSnapshot: reservedStep.snapshot,
      });
    } else {
      // Recover the narrow provider-success/DB-checkpoint crash window only for a retried, accepted action.
      const alreadyReserved = action.attempts > 1 && Number(order.TotalValueCents) === intent.remainingCents;
      if (alreadyReserved) {
        assertReserved(order, intent);
        redeemed = { Amount: intent.reserveCents };
      } else {
        assertCheckoutSnapshot(order, intent);
        const response = await ctx.vista.redeemLoyalty({
          UserSessionId: intent.userSessionId,
          MemberId: intent.memberId,
          Points:
            intent.balanceType === "VOX_CREDIT" ? intent.reserveCents : centsToPoints(intent.reserveCents),
          BalanceType: intent.balanceType === "VOX_CREDIT" ? "VOX_REWARDS" : "SHARE_POINTS",
        });
        order = response.Order;
        redeemed = response.Redeemed;
      }
      assertReserved(order, intent);
      steps.push({
        name: "balance_reserved",
        status: "done",
        at: new Date().toISOString(),
        detail: { snapshot: checkoutSnapshot(order), redeemed },
      });
    }
    const existingReview = liveAction.steps.find((x) => x.name === "balance_review")?.detail as
      | { result: Record<string, unknown>; ui: Record<string, unknown> }
      | undefined;
    if (existingReview) return existingReview;
    const scoped = {
      ...ctx,
      db: tx as unknown as Db,
      conversation: current!,
      checkoutMutationActionId: action.id,
    };
    const cinema = await ctx.catalog.cinema(order.CinemaId);
    const summary = orderSummary(order, ctx.lang, ctx.nowLocal, cinema?.name);
    let review: Awaited<ReturnType<typeof import("../tools/ordering.js")["reviewAndPay"]>>;
    try {
      const { reviewAndPay } = await import("../tools/ordering.js");
      review = await reviewAndPay(scoped, { userSessionId: intent.userSessionId, method: "CARD" }, {});
    } catch (error) {
      review = {
        ok: false,
        error: {
          code: (error as DomainError).code ?? "REVIEW_UNAVAILABLE",
          message: "The balance was reserved, but the card review could not be opened.",
          retryable: true,
        },
      };
    }
    const opened =
      review.ok &&
      review.ui?.type === "payment" &&
      review.ui.meta?.requiresSheet === true &&
      review.ui.meta?.amountCents === intent.remainingCents;
    const result = {
      speech: opened
        ? review.speech
        : t(
            ctx.lang,
            `${money(intent.reserveCents, ctx.lang)} is reserved; the card review could not be opened. No payment was made.`,
            `تم حجز ${money(intent.reserveCents, ctx.lang)} للمراجعة، لكن تعذر فتح مراجعة البطاقة. لم يتم الدفع.`,
          ),
      order: summary,
      redeemed,
      balanceType: intent.balanceType,
      cleared: false,
      nextPaymentMethod: "CARD",
      balancePayment: {
        method: intent.balanceType,
        amountCents: intent.reserveCents,
        remainingCents: intent.remainingCents,
        totalCents: intent.amountCents,
      },
      paymentReviewOpened: !!opened,
      review: opened ? { ok: true, ...review.data } : { ok: false, error: review.error, ...review.data },
    };
    const outcome = { result, ui: opened ? review.ui! : { type: "order", items: [summary] } };
    if (opened)
      steps.push({ name: "balance_review", status: "done", at: new Date().toISOString(), detail: outcome });
    await tx
      .update(S.actions)
      .set({ steps })
      .where(and(eq(S.actions.id, action.id), eq(S.actions.attempts, action.attempts)));
    return outcome;
  });
}
