export type PaymentOffer = { offerId?: string; type?: string; bankBins?: string[]; title?: string };
export const isCardOffer = (offer: PaymentOffer) => offer.type === "bank" || !!offer.bankBins?.length;
export const balanceMethod = (method: string) =>
  method === "VOX_CREDIT" || method === "SHARE_POINTS" || method === "EWALLET" || method === "LOYALTY";
export function cardOfferConflict(offers: PaymentOffer[], method: string, redeemedCents = 0) {
  return offers.some(isCardOffer) && (balanceMethod(method) || redeemedCents > 0);
}

/** Remove only the specified offer's price effects; keep other offers, fees and bought food intact. */
export function removeOfferEffects<
  T extends {
    tickets: any[];
    concessions: any[];
    appliedOffers: any[];
    loyaltyPointsPayableValueInCents: number;
  },
>(order: T, removedIds: string[], freeItemIds: string[] = []) {
  const removed = new Set(removedIds);
  return {
    tickets: order.tickets.map((ticket) =>
      removed.has(ticket.DealDefinitionId)
        ? {
            ...ticket,
            DiscountPriceCents: 0,
            FinalPriceCents: ticket.PriceCents,
            DealDefinitionId: null,
            DealDescription: null,
          }
        : ticket,
    ),
    concessions: order.concessions
      .filter(
        (line) =>
          !(
            removed.has(line.DealDefinitionId) &&
            freeItemIds.includes(line.ItemId) &&
            line.FinalPriceCents === 0
          ),
      )
      .map((line) =>
        removed.has(line.DealDefinitionId)
          ? {
              ...line,
              FinalPriceCents: line.PriceCents * line.Quantity,
              DealDefinitionId: null,
              DealDescription: null,
            }
          : line,
      ),
    appliedOffers: order.appliedOffers.filter((offer) => !removed.has(offer.offerId)),
    loyaltyPointsPayableValueInCents: order.appliedOffers.some(
      (offer) => offer.type === "loyalty_redeem" && removed.has(offer.offerId),
    )
      ? 0
      : order.loyaltyPointsPayableValueInCents,
  };
}
