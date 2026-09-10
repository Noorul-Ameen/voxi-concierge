import { type Db, schema as S } from "@voxi/db";
import { removeOfferEffects } from "@voxi/domain";
import { and, eq, inArray } from "drizzle-orm";
import { type OrderCfg, RC, VistaError, getOrder, recalc, withSessionLock } from "./orders.js";

export async function previewOfferRemoval(db: Db, userSessionId: string, offerIds: string[], cfg: OrderCfg) {
  const order = await getOrder(db, userSessionId, cfg);
  if (!order || ["paid", "cancelled", "expired"].includes(order.state))
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "The order is closed or expired");
  const offers = offerIds.length
    ? await db.select().from(S.offers).where(inArray(S.offers.id, offerIds))
    : [];
  const freeItems = offers.flatMap((o) => (o.benefit.type === "free_item" ? [o.benefit.itemId] : []));
  const reset = removeOfferEffects(order, offerIds, freeItems);
  const totals = recalc({ ...order, ...reset }, cfg);
  return {
    order,
    reset,
    totals,
    preview: {
      currentTotalCents: order.totalValueCents,
      totalAfterCents: totals.totalValueCents,
      removedOfferIds: order.appliedOffers.filter((o) => offerIds.includes(o.offerId)).map((o) => o.offerId),
      expectedVersion: order.version,
      bookingFeeCents: totals.bookingFeeValueCents,
      expiresAtUtc: order.expiryAt.toISOString(),
    },
  };
}

export async function removeOffers(
  db: Db,
  req: { UserSessionId: string; OfferIds: string[]; ExpectedVersion?: number; ExpectedTotalCents?: number },
  cfg: OrderCfg,
) {
  const original = await getOrder(db, req.UserSessionId, cfg);
  if (!original) throw new VistaError(RC.GENERAL, RC.ORDER_NOT_FOUND, "Order not found");
  return withSessionLock(db, original.cinemaId, original.sessionId!, async (tx) => {
    await tx.select().from(S.orders).where(eq(S.orders.userSessionId, req.UserSessionId)).for("update");
    const { order, reset, totals, preview } = await previewOfferRemoval(
      tx as unknown as Db,
      req.UserSessionId,
      req.OfferIds,
      cfg,
    );
    if (
      !preview.removedOfferIds.length &&
      (req.ExpectedTotalCents == null || order.totalValueCents === req.ExpectedTotalCents)
    )
      return;
    if (
      (req.ExpectedVersion != null && order.version !== req.ExpectedVersion) ||
      (req.ExpectedTotalCents != null && totals.totalValueCents !== req.ExpectedTotalCents)
    )
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "The basket changed; confirm a fresh payment-method switch preview",
      );
    await tx
      .update(S.orders)
      .set({ ...reset, ...totals, version: order.version + 1, lastUpdatedAt: new Date() })
      .where(eq(S.orders.userSessionId, req.UserSessionId));
    await tx
      .update(S.offerRedemptions)
      .set({ status: "released" })
      .where(
        and(
          eq(S.offerRedemptions.orderUserSessionId, req.UserSessionId),
          inArray(S.offerRedemptions.offerId, req.OfferIds),
        ),
      );
  });
}
