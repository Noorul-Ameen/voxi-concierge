import { type Offer, type PricedConcession, type PricedTicket, applyBenefit } from "@voxi/domain";
import type { VistaOrder } from "./order-state.js";

export type OfferPreview = {
  previewUnavailableReason?: string;
  currentTotalCents?: number;
  discountCents?: number;
  totalAfterOfferCents?: number;
  promotionDiscountCents?: number;
  bookingFeeCents?: number;
  redeemedCents?: number;
  freeItemId?: string;
  pointsMultiplier?: number;
  priceBasis?: "current_basket";
  applied?: false;
};

/** Read-only pricing with the same benefit engine as offer application. Prices already include VAT. */
export function previewOffer(
  offer: Pick<Offer, "id" | "type" | "rules" | "benefit">,
  order: VistaOrder | null | undefined,
  eligibility?: { eligible: boolean; reasons: string[]; requires: string[] },
): OfferPreview {
  if (!order) return { previewUnavailableReason: "Select tickets or food before pricing this offer." };
  if (
    ["paid", "cancelled", "expired"].includes(order.State) ||
    (order.ExpiryDateUtc && Date.parse(order.ExpiryDateUtc) <= Date.now())
  )
    return { previewUnavailableReason: "A live unpaid order is required to price this offer." };
  if (eligibility && !eligibility.eligible)
    return {
      previewUnavailableReason:
        [...eligibility.reasons, ...eligibility.requires.map((field) => `Requires ${field}`)].join("; ") ||
        "Offer eligibility has not been confirmed.",
    };
  const previous = (order.AppliedOffers ?? []) as { offerId: string; type: string }[];
  if (previous.some((applied) => applied.offerId === offer.id))
    return { previewUnavailableReason: "This offer is already applied to the current total." };
  if (
    ["bank", "promo"].includes(offer.type) &&
    previous.some((applied) => ["bank", "promo"].includes(applied.type))
  )
    return {
      previewUnavailableReason:
        "Bank and promo offers cannot be combined. Remove the existing offer before comparing a replacement.",
    };
  const tickets = (order.Sessions ?? []).flatMap(
    (session: { Tickets?: PricedTicket[] }) => session.Tickets ?? [],
  ) as PricedTicket[];
  const concessions = (order.Concessions ?? []).map(
    (line: PricedConcession & { UnitPriceCents?: number }) => ({
      ...line,
      PriceCents: line.UnitPriceCents ?? line.PriceCents,
    }),
  ) as PricedConcession[];
  if (!tickets.length && !concessions.length) return { previewUnavailableReason: "The order is empty." };
  const applied = applyBenefit(offer.benefit, tickets, concessions, offer.rules.maxTicketsPerRedemption);
  const currentTotalCents = Number(order.TotalValueCents);
  const feeCents = Number(order.BookingFeeValueCents ?? 0);
  const redeemedCents = Number(order.LoyaltyPointsPayableValueInCents ?? 0);
  const totalAfterOfferCents = Math.max(
    0,
    applied.tickets.reduce((total, ticket) => total + ticket.FinalPriceCents, 0) +
      applied.concessions.reduce((total, line) => total + line.FinalPriceCents, 0) +
      feeCents -
      redeemedCents,
  );
  if (![currentTotalCents, totalAfterOfferCents].every(Number.isFinite))
    return { previewUnavailableReason: "The order does not contain a complete price snapshot." };
  return {
    currentTotalCents,
    discountCents: currentTotalCents - totalAfterOfferCents,
    totalAfterOfferCents,
    promotionDiscountCents: applied.discountCents,
    bookingFeeCents: feeCents,
    redeemedCents,
    ...(applied.freeItemId ? { freeItemId: applied.freeItemId } : {}),
    ...(applied.pointsMultiplier ? { pointsMultiplier: applied.pointsMultiplier } : {}),
    priceBasis: "current_basket",
    applied: false,
  };
}
