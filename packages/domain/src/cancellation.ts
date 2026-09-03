/**
 * Cancellation & refund policy (VOX UAE, uae.voxcinemas.com/refunds), reproducing the ValidateBooking
 * rules previously implemented in SAP ByD:
 *  - not possible when the movie starts in less than the cut-off (30 minutes)
 *  - not possible when tickets have been collected at the kiosk or scanned
 *  - not possible for discounted tickets from bank or telco offers
 *  - not possible when F&B has been activated (Prepare Now / QR)
 *  - refunds are issued as VOX credit (1 credit = AED 1) or Share Points; card refunds only when policy allows
 *  - registered accounts only for VOX credit; guests may swap (same ticket type) or contact the call centre
 * Pure, timezone-explicit (all timestamps are cinema-local ISO strings without offset).
 */
export type PolicyConfig = {
  cutoffMinutes: number; // 30
  refundMethods: ("VOX_CREDIT" | "SHARE_POINTS" | "ORIGINAL_PAYMENT")[];
  refundBookingFee: boolean; // VOX policy: "full amount plus any associated booking fee"
  refundConcessions: boolean; // F&B refundable unless activated
  sharePointsPerFils: number; // 1 point = 1 fils → 100 points per AED
  allowPartial: boolean;
  guestRefundMethods: ("ORIGINAL_PAYMENT" | "VOX_CREDIT")[]; // guests have no wallet → original payment (call-centre) only
};

export const DEFAULT_POLICY: PolicyConfig = {
  cutoffMinutes: 30,
  refundMethods: ["VOX_CREDIT", "SHARE_POINTS"],
  refundBookingFee: true,
  refundConcessions: true,
  sharePointsPerFils: 1,
  allowPartial: true,
  guestRefundMethods: ["ORIGINAL_PAYMENT"],
};

export type BookingSnapshot = {
  bookingId: string;
  status: string; // confirmed | cancelled | refunded | partially_refunded | swapped | collected
  showtime: string; // local ISO
  ticketsCollected: boolean;
  isThirdParty: boolean;
  hasMember: boolean;
  tickets: { Id: string; FinalPriceCents: number; DiscountPriceCents: number; DealDefinitionId: string | null; Status: string }[];
  concessions: { Id: string; FinalPriceCents: number; activated?: boolean }[];
  appliedOffers: { offerId: string; type: string }[];
  bookingFeeValueCents: number;
  totalValueCents: number;
  refundedValueCents: number;
};

export type EligibilityResult = {
  eligible: boolean;
  code: "OK" | "CUTOFF_PASSED" | "TICKETS_USED" | "BOOKING_ALREADY_CANCELLED" | "BOOKING_NOT_ELIGIBLE" | "SHOW_STARTED";
  reasons: string[];
  minutesToShowtime: number;
  refundableTicketIds: string[];
  amounts: { ticketsCents: number; concessionsCents: number; bookingFeeCents: number; totalCents: number };
  refundMethods: { method: "VOX_CREDIT" | "SHARE_POINTS" | "ORIGINAL_PAYMENT"; amountCents: number; points?: number; eta: string }[];
  swapAllowed: boolean;
  notes: string[];
};

export function evaluateCancellation(b: BookingSnapshot, nowLocalIso: string, requestedTicketIds?: string[], policy: PolicyConfig = DEFAULT_POLICY): EligibilityResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  const minutes = Math.round((new Date(`${b.showtime}Z`).getTime() - new Date(`${nowLocalIso}Z`).getTime()) / 60000);
  const empty = { ticketsCents: 0, concessionsCents: 0, bookingFeeCents: 0, totalCents: 0 };
  const fail = (code: EligibilityResult["code"], reason: string): EligibilityResult => ({ eligible: false, code, reasons: [reason, ...reasons], minutesToShowtime: minutes, refundableTicketIds: [], amounts: empty, refundMethods: [], swapAllowed: false, notes });

  if (b.status === "cancelled" || b.status === "refunded" || b.status === "swapped") return fail("BOOKING_ALREADY_CANCELLED", `Booking ${b.bookingId} has already been ${b.status}.`);
  if (minutes < 0) return fail("SHOW_STARTED", "The movie has already started, so this booking can no longer be cancelled.");
  if (b.ticketsCollected || b.status === "collected" || b.tickets.some((t) => t.Status === "used")) return fail("TICKETS_USED", "Tickets have already been collected at the kiosk or scanned, so they cannot be refunded.");
  if (minutes < policy.cutoffMinutes) return fail("CUTOFF_PASSED", `Cancellations must be requested at least ${policy.cutoffMinutes} minutes before the movie starts; this one starts in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  if (b.isThirdParty) return fail("BOOKING_NOT_ELIGIBLE", "This booking was made through a third-party partner; please contact the partner to cancel.");
  const bankOffer = b.appliedOffers.some((o) => o.type === "bank" || o.type === "partner") || b.tickets.some((t) => t.DealDefinitionId?.startsWith("BANK"));
  if (bankOffer) return fail("BOOKING_NOT_ELIGIBLE", "Tickets purchased with a bank or telco offer are non-refundable and non-transferable.");
  if (b.concessions.some((c) => c.activated)) return fail("BOOKING_NOT_ELIGIBLE", "Food & drinks on this booking have already been activated (Prepare Now / QR), so the booking cannot be cancelled.");

  const validTickets = b.tickets.filter((t) => t.Status === "valid");
  let selected = validTickets;
  if (requestedTicketIds?.length) {
    if (!policy.allowPartial) reasons.push("Partial cancellation is not allowed; the whole booking will be cancelled.");
    else selected = validTickets.filter((t) => requestedTicketIds.includes(t.Id));
    if (!selected.length) return fail("BOOKING_NOT_ELIGIBLE", "None of the selected tickets are refundable.");
  }
  const full = selected.length === validTickets.length;
  const ticketsCents = selected.reduce((a, t) => a + t.FinalPriceCents, 0);
  const concessionsCents = full && policy.refundConcessions ? b.concessions.reduce((a, c) => a + c.FinalPriceCents, 0) : 0;
  const bookingFeeCents = policy.refundBookingFee ? Math.round((b.bookingFeeValueCents * selected.length) / Math.max(1, b.tickets.length)) : 0;
  const totalCents = ticketsCents + concessionsCents + bookingFeeCents;
  if (!full) notes.push("Partial cancellation: food & drinks stay on the booking and remain valid.");
  if (!policy.refundBookingFee) notes.push("Booking fees are non-refundable.");

  const methods: EligibilityResult["refundMethods"] = [];
  const allowed = b.hasMember ? policy.refundMethods : policy.guestRefundMethods;
  for (const m of allowed) {
    if (m === "VOX_CREDIT") methods.push({ method: m, amountCents: totalCents, eta: "within 30 minutes to your VOX Wallet (valid 90 days)" });
    if (m === "SHARE_POINTS") methods.push({ method: m, amountCents: totalCents, points: totalCents * policy.sharePointsPerFils, eta: "instantly to your SHARE account" });
    if (m === "ORIGINAL_PAYMENT") methods.push({ method: m, amountCents: totalCents, eta: "5–10 working days to the original payment method" });
  }
  if (!b.hasMember) notes.push("This booking is not linked to a registered account, so VOX credit is not available; the refund goes back to the original payment method via Customer Care, or you can swap to another session of the same ticket type.");
  return { eligible: true, code: "OK", reasons, minutesToShowtime: minutes, refundableTicketIds: selected.map((t) => t.Id), amounts: { ticketsCents, concessionsCents, bookingFeeCents, totalCents }, refundMethods: methods, swapAllowed: true, notes };
}

/** Swap policy: same ticket type count; price difference charged/refunded; same cut-off as cancellation. */
export function evaluateSwap(b: BookingSnapshot, nowLocalIso: string, target: { showtime: string; experience: string; seatsAvailable: number; ticketPriceCentsByCode: Record<string, number> }, policy: PolicyConfig = DEFAULT_POLICY) {
  const base = evaluateCancellation(b, nowLocalIso, undefined, policy);
  if (!base.eligible) return { allowed: false, reasons: base.reasons, differenceCents: 0, code: base.code };
  const targetMinutes = Math.round((new Date(`${target.showtime}Z`).getTime() - new Date(`${nowLocalIso}Z`).getTime()) / 60000);
  if (targetMinutes < policy.cutoffMinutes) return { allowed: false, reasons: ["The new session starts too soon to complete a swap."], differenceCents: 0, code: "CUTOFF_PASSED" as const };
  const count = b.tickets.filter((t) => t.Status === "valid").length;
  if (target.seatsAvailable < count) return { allowed: false, reasons: [`The new session only has ${target.seatsAvailable} seats left; you need ${count}.`], differenceCents: 0, code: "BOOKING_NOT_ELIGIBLE" as const };
  const newTotal = Object.values(target.ticketPriceCentsByCode).reduce((a, v) => a + v, 0);
  const differenceCents = newTotal - base.amounts.ticketsCents;
  return { allowed: true, reasons: [], differenceCents, code: "OK" as const, refundCents: base.amounts.ticketsCents, newTicketsCents: newTotal };
}
