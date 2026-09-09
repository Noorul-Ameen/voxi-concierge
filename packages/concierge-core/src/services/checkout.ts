/** Bind payment consent to a settled basket, not merely to an order identifier. */
import { createHash } from "node:crypto";
import { DomainError, ErrorCodes } from "@voxi/contracts";
import { type Db, schema as S } from "@voxi/db";
import { and, eq, inArray, like, ne, or } from "drizzle-orm";
import type { ConversationTx } from "./relink.js";

export const BASKET_ACTION_TYPES = [
  "add_tickets",
  "select_seats",
  "add_concessions",
  "apply_offer",
  "redeem_points",
  "cancel_order",
  "quick_book",
  "recover_order",
  "order_fnb",
];

export async function pendingBasketActions(
  db: Db | ConversationTx,
  resourceKey: string,
  excludeActionId?: string,
  conversationId?: string,
) {
  return db
    .select()
    .from(S.actions)
    .where(
      and(
        or(
          eq(S.actions.resourceKey, resourceKey),
          conversationId
            ? and(eq(S.actions.conversationId, conversationId), like(S.actions.resourceKey, "conversation:%"))
            : undefined,
        ),
        inArray(S.actions.type, BASKET_ACTION_TYPES),
        inArray(S.actions.status, ["queued", "running"]),
        excludeActionId ? ne(S.actions.id, excludeActionId) : undefined,
      ),
    );
}

export async function assertNoPendingBasketEdits(
  db: Db | ConversationTx,
  resourceKey: string,
  excludeActionId?: string,
  conversationId?: string,
) {
  const pending = await pendingBasketActions(db, resourceKey, excludeActionId, conversationId);
  if (pending.length)
    throw new DomainError(
      ErrorCodes.ORDER_INVALID_STATE,
      "Your booking changes are still being applied. Check the pending action result, then review the completed basket before payment.",
      false,
      { pendingActions: pending.map(({ id, type, status }) => ({ actionId: id, type, status })) },
    );
}

/** Also revoke consumed consent: its payment may still be queued or awaiting a retry. */
export async function invalidatePaymentConfirmations(db: Db | ConversationTx, resourceKey: string) {
  const conversationId = resourceKey.startsWith("conversation:")
    ? resourceKey.slice("conversation:".length)
    : undefined;
  await db
    .update(S.pendingConfirmations)
    .set({ expiresAt: new Date(0) })
    .where(
      and(
        eq(S.pendingConfirmations.actionType, "pay_order"),
        conversationId
          ? eq(S.pendingConfirmations.conversationId, conversationId)
          : eq(S.pendingConfirmations.resourceKey, resourceKey),
      ),
    );
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;

export function checkoutSnapshot(order: Record<string, unknown>) {
  // Exclude response timestamps/customer contact. Include all purchasable line details,
  // so equal-price seat, modifier, ticket and snack substitutions still require consent.
  const fields = [
    "UserSessionId",
    "CinemaId",
    "TotalValueCents",
    "TaxValueCents",
    "BookingFeeValueCents",
    "DiscountValueCents",
    "Sessions",
    "Concessions",
    "BookingFees",
    "AppliedOffers",
    "AppliedLoyaltyPointsPayments",
    "LoyaltyPointsPayableValueInCents",
    "ExpiryDateUtc",
  ];
  const basket = Object.fromEntries(fields.map((field) => [field, order[field] ?? null]));
  return {
    version: order.Version == null ? null : String(order.Version),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(canonical(basket)))
      .digest("hex"),
  };
}

export function assertCheckoutSnapshot(order: Record<string, unknown>, summary: Record<string, unknown>) {
  const expected = summary.checkoutSnapshot as ReturnType<typeof checkoutSnapshot> | undefined;
  const actual = checkoutSnapshot(order);
  if (
    !expected ||
    expected.version !== actual.version ||
    expected.fingerprint !== actual.fingerprint ||
    !Number.isSafeInteger(summary.amountCents) ||
    Number(summary.amountCents) < 0 ||
    summary.amountCents !== order.TotalValueCents
  )
    throw new DomainError(
      ErrorCodes.CONFIRMATION_REQUIRED,
      "The booking changed after your review. Please review the updated seats, snacks and total and confirm payment again.",
    );
}

export async function assertPaymentConsent(
  db: Db | ConversationTx,
  resourceKey: string,
  input: Record<string, unknown>,
  order: Record<string, unknown>,
  conversationId?: string,
) {
  await assertNoPendingBasketEdits(db, resourceKey, undefined, conversationId);
  const [confirmation] = await db
    .select()
    .from(S.pendingConfirmations)
    .where(
      and(
        eq(S.pendingConfirmations.id, String(input.confirmationId ?? "")),
        eq(S.pendingConfirmations.resourceKey, resourceKey),
        eq(S.pendingConfirmations.actionType, "pay_order"),
      ),
    );
  if (!confirmation?.consumedAt || confirmation.expiresAt <= new Date())
    throw new DomainError(
      ErrorCodes.CONFIRMATION_REQUIRED,
      "Payment consent is no longer current. Please review the completed basket and confirm payment again.",
    );
  assertCheckoutSnapshot(order, confirmation.summary);
  assertCheckoutSnapshot(order, input);
}
