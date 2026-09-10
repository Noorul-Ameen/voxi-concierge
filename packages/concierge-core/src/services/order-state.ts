/** Safe booking state for rendering and agent context; excludes payment tokens and customer details. */
import { fmtDateTime, money, seatLabels } from "./format.js";
export type VistaOrder = Record<string, any>;

export function orderSummary(o: VistaOrder, lang: "en" | "ar", nowLocal: string, cinemaName?: string) {
  const sess = o.Sessions?.[0];
  const tickets = (sess?.Tickets ?? []) as any[];
  const concessions = (o.Concessions ?? []) as any[];
  return {
    userSessionId: o.UserSessionId,
    state: o.State,
    cinemaId: o.CinemaId,
    cinemaName,
    sessionId: sess?.SessionId != null ? String(sess.SessionId) : undefined,
    filmTitle: sess ? (lang === "ar" && sess.AltFilmTitle ? sess.AltFilmTitle : sess.FilmTitle) : undefined,
    showtime: sess?.ShowingRealDateTimeOffset?.slice(0, 19),
    showtimeLabel: sess?.ShowingRealDateTimeOffset
      ? fmtDateTime(sess.ShowingRealDateTimeOffset.slice(0, 19), lang, nowLocal)
      : undefined,
    experience: sess?.Experience,
    screenName: sess?.ScreenName,
    tickets: tickets.map((t) => ({
      id: t.Id,
      description: t.Description,
      seat: t.SeatData,
      priceCents: t.PriceCents,
      discountCents: t.DiscountPriceCents,
      finalCents: t.FinalPriceCents,
      deal: t.DealDescription,
    })),
    seats: seatLabels(tickets),
    seatsAllocated: !!sess?.SeatsAllocated,
    concessions: concessions.map((c) => ({
      id: c.Id,
      itemId: c.ItemId,
      description: c.Description,
      quantity: c.Quantity,
      unitCents: c.UnitPriceCents ?? c.PriceCents,
      finalCents: c.FinalPriceCents,
      modifiers: (c.Modifiers ?? []).map((m: any) => m.Description),
    })),
    offers: (o.AppliedOffers ?? []).map((a: any) => ({
      id: a.offerId,
      title: a.title,
      discountCents: a.discountCents,
      type: a.type,
    })),
    subtotalCents:
      tickets.reduce((a, t) => a + t.PriceCents, 0) +
      concessions.reduce((a, c) => a + (c.UnitPriceCents ?? c.PriceCents) * c.Quantity, 0),
    discountCents: o.DiscountValueCents ?? 0,
    loyaltyRedeemedCents: o.LoyaltyPointsPayableValueInCents ?? 0,
    bookingFeeCents: o.BookingFeeValueCents ?? 0,
    taxCents: o.TaxValueCents ?? 0,
    totalCents: o.TotalValueCents ?? 0,
    total: money(o.TotalValueCents ?? 0, lang),
    expiresAtUtc: o.ExpiryDateUtc ?? o.ExpiresAtUtc,
  };
}

export function buildBookingState(summary: ReturnType<typeof orderSummary>, now = Date.now()) {
  const requiresFreshHold =
    summary.state === "expired" || (!!summary.expiresAtUtc && Date.parse(summary.expiresAtUtc) <= now);
  return {
    userSessionId: summary.userSessionId,
    selectedMovie: summary.filmTitle,
    selectedCinema: summary.cinemaId,
    cinemaName: summary.cinemaName,
    selectedShowtime: summary.showtime,
    ticketQuantity: summary.tickets.length,
    selectedSeats: summary.seats,
    foodCart: summary.concessions,
    offers: summary.offers,
    totalCents: summary.totalCents,
    seatHoldExpiry: summary.expiresAtUtc,
    requiresFreshHold,
    currentJourneyStage: requiresFreshHold
      ? "expired"
      : summary.state === "awaiting_payment"
        ? "payment"
        : "seats",
  };
}
