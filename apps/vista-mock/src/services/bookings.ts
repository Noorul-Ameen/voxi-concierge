import type { Db } from "@voxi/db";
import { schema as S, nowLocalDate, seatKey, shortId } from "@voxi/db";
/** Booking search / refund / cancel (Vista RESTBooking.svc-style). Refunds are transactional and idempotent by reference. */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { RC, VistaError, loadSeatState, withSessionLock } from "./orders.js";

export type BookingSearch = {
  BookingId?: string;
  BookingNumber?: number;
  Email?: string;
  Phone?: string;
  MemberId?: string;
  CustomerId?: string;
  CinemaId?: string;
  UpcomingOnly?: boolean;
  Limit?: number;
};

const digits = (s: string) => s.replace(/\D/g, "");

export async function searchBookings(db: Db, q: BookingSearch) {
  const conds = [];
  if (q.BookingId) conds.push(sql`upper(${S.bookings.vistaBookingId}) = ${q.BookingId.trim().toUpperCase()}`);
  if (q.BookingNumber) conds.push(eq(S.bookings.vistaBookingNumber, q.BookingNumber));
  if (q.Email) conds.push(sql`lower(${S.bookings.customer}->>'Email') = ${q.Email.trim().toLowerCase()}`);
  if (q.Phone) {
    const d = digits(q.Phone);
    const tail = d.slice(-9);
    conds.push(sql`regexp_replace(${S.bookings.customer}->>'Phone', '\\D', '', 'g') like ${`%${tail}`}`);
  }
  if (q.MemberId) conds.push(sql`${S.bookings.customer}->>'MemberId' = ${q.MemberId}`);
  if (q.CustomerId) conds.push(eq(S.bookings.customerId, q.CustomerId));
  if (q.CinemaId) conds.push(eq(S.bookings.cinemaId, q.CinemaId));
  if (!conds.length)
    throw new VistaError(RC.GENERAL, RC.BOOKING_NOT_FOUND, "Provide a booking id, email, phone or member id");
  const where = q.BookingId || q.BookingNumber ? or(...conds) : and(...conds);
  const rows = await db
    .select()
    .from(S.bookings)
    .where(where)
    .orderBy(desc(S.bookings.showtime))
    .limit(q.Limit ?? 20);
  return q.UpcomingOnly
    ? rows.filter((r) => r.showtime.getTime() > nowLocalDate().getTime() - 30 * 60000)
    : rows;
}

export async function getBooking(db: Db, bookingId: string) {
  const row = (
    await db
      .select()
      .from(S.bookings)
      .where(sql`upper(${S.bookings.vistaBookingId}) = ${bookingId.trim().toUpperCase()}`)
  )[0];
  if (!row) throw new VistaError(RC.GENERAL, RC.BOOKING_NOT_FOUND, `Booking ${bookingId} was not found`);
  return row;
}

export type RefundReq = {
  BookingId: string;
  CinemaId?: string;
  TicketIds?: string[]; // partial
  RefundConcessions?: boolean;
  RefundBookingFee?: boolean;
  RefundTenderCategory: "EWALLET" | "LOYALTY" | "CREDIT"; // VOX credit | Share Points | original card
  Reason?: string;
  Reference?: string; // idempotency key
  InitiatedBy?: string;
  ConversationId?: string;
  ExpectedVersion?: number;
  AlsoCancel?: boolean; // cancel the booking (default true for full refunds)
};

/**
 * Refund a booking. Policy checks are the concierge's job (packages/domain); the mock only enforces
 * structural invariants (exists, not already refunded, tickets valid) exactly as Vista would.
 */
export async function refundBooking(db: Db, req: RefundReq) {
  const reference = req.Reference ?? `RF${shortId(8)}`;
  const existing = (await db.select().from(S.refunds).where(eq(S.refunds.reference, reference)))[0];
  if (existing) {
    const b = await getBooking(db, req.BookingId);
    return { refund: existing, booking: b, idempotent: true };
  }
  const booking = await getBooking(db, req.BookingId);
  if (booking.status === "refunded" || booking.status === "cancelled" || booking.status === "swapped")
    throw new VistaError(
      RC.GENERAL,
      RC.BOOKING_ALREADY_CANCELLED,
      `Booking ${booking.vistaBookingId} is already ${booking.status}`,
    );
  if (req.ExpectedVersion != null && req.ExpectedVersion !== booking.version)
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Booking changed since it was read");
  const valid = booking.tickets.filter((t) => t.Status === "valid");
  const targets = req.TicketIds?.length ? valid.filter((t) => req.TicketIds!.includes(t.Id)) : valid;
  if (!targets.length)
    throw new VistaError(RC.GENERAL, RC.BOOKING_NOT_REFUNDABLE, "No refundable tickets on this booking");
  const full = targets.length === valid.length;
  const ticketsCents = targets.reduce((a, t) => a + t.FinalPriceCents, 0);
  const concCents =
    full && (req.RefundConcessions ?? true)
      ? booking.concessions.reduce((a, c) => a + c.FinalPriceCents, 0)
      : 0;
  const feeCents =
    (req.RefundBookingFee ?? true)
      ? Math.round((booking.bookingFeeValueCents * targets.length) / Math.max(1, booking.tickets.length))
      : 0;
  const amount = ticketsCents + concCents + feeCents;
  const memberId = booking.customer.MemberId;
  if ((req.RefundTenderCategory === "EWALLET" || req.RefundTenderCategory === "LOYALTY") && !memberId)
    throw new VistaError(
      RC.GENERAL,
      RC.BOOKING_NOT_REFUNDABLE,
      "Wallet/points refunds require a SHARE member booking",
    );

  return withSessionLock(db, booking.cinemaId, booking.sessionId, async (tx) => {
    // release seats
    const { state } = await loadSeatState(tx, booking.cinemaId, booking.sessionId).catch(() => ({
      state: null as null | { seats: Record<string, { status: number }>; version: number },
    }));
    if (state) {
      for (const t of targets)
        if (t.SeatRowId && t.SeatNumber) state.seats[seatKey(t.SeatRowId, t.SeatNumber)] = { status: 0 };
      const available = Object.values(state.seats).filter((x) => x.status === 0).length;
      await tx
        .update(S.sessionSeatState)
        .set({ seats: state.seats, version: state.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(S.sessionSeatState.cinemaId, booking.cinemaId),
            eq(S.sessionSeatState.sessionId, booking.sessionId),
          ),
        );
      await tx
        .update(S.sessions)
        .set({ seatsAvailable: available, soldoutStatus: available === 0 ? 2 : 0 })
        .where(and(eq(S.sessions.cinemaId, booking.cinemaId), eq(S.sessions.sessionId, booking.sessionId)));
    }
    // credit wallet / points
    if (memberId && (req.RefundTenderCategory === "EWALLET" || req.RefundTenderCategory === "LOYALTY")) {
      const acct = (
        await tx.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId))
      )[0];
      if (!acct) throw new VistaError(RC.GENERAL, RC.BOOKING_NOT_REFUNDABLE, "Loyalty account not found");
      if (req.RefundTenderCategory === "EWALLET") {
        await tx
          .update(S.loyaltyAccounts)
          .set({
            voxRewardsBalanceCents: sql`${S.loyaltyAccounts.voxRewardsBalanceCents} + ${amount}`,
            version: sql`${S.loyaltyAccounts.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(S.loyaltyAccounts.memberId, memberId));
        await tx.insert(S.loyaltyLedger).values({
          id: shortId(12),
          memberId,
          balanceType: "VOX_REWARDS",
          delta: amount,
          reason: `Refund booking ${booking.vistaBookingId}`,
          reference,
        });
      } else {
        await tx
          .update(S.loyaltyAccounts)
          .set({
            sharePointsBalance: sql`${S.loyaltyAccounts.sharePointsBalance} + ${amount}`,
            version: sql`${S.loyaltyAccounts.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(S.loyaltyAccounts.memberId, memberId));
        await tx.insert(S.loyaltyLedger).values({
          id: shortId(12),
          memberId,
          balanceType: "SHARE_POINTS",
          delta: amount,
          reason: `Refund booking ${booking.vistaBookingId}`,
          reference,
        });
      }
    }
    const [refund] = await tx
      .insert(S.refunds)
      .values({
        id: `rf_${shortId(10)}`,
        bookingId: booking.vistaBookingId,
        amountCents: amount,
        method:
          req.RefundTenderCategory === "EWALLET"
            ? "VOX_CREDIT"
            : req.RefundTenderCategory === "LOYALTY"
              ? "SHARE_POINTS"
              : "ORIGINAL_PAYMENT",
        tenderCategory: req.RefundTenderCategory,
        ticketIds: targets.map((t) => t.Id),
        reason: req.Reason ?? "",
        reference,
        status: req.RefundTenderCategory === "CREDIT" ? "pending" : "completed",
        initiatedBy: req.InitiatedBy ?? "concierge",
        conversationId: req.ConversationId ?? null,
      })
      .returning();
    const tickets = booking.tickets.map((t) =>
      targets.some((x) => x.Id === t.Id) ? { ...t, Status: "refunded" as const } : t,
    );
    const status = full ? ((req.AlsoCancel ?? true) ? "refunded" : "refunded") : "partially_refunded";
    const [updated] = await tx
      .update(S.bookings)
      .set({
        tickets,
        status,
        refundedValueCents: booking.refundedValueCents + amount,
        version: booking.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(eq(S.bookings.vistaBookingId, booking.vistaBookingId), eq(S.bookings.version, booking.version)),
      )
      .returning();
    if (!updated) throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Booking changed concurrently");
    return { refund: refund!, booking: updated, idempotent: false };
  });
}

/** Mark tickets collected (kiosk/scan) — used by the demo to flip eligibility. */
export async function markCollected(db: Db, bookingId: string) {
  const b = await getBooking(db, bookingId);
  const [u] = await db
    .update(S.bookings)
    .set({
      ticketsCollected: true,
      status: "collected",
      tickets: b.tickets.map((t) => ({ ...t, Status: t.Status === "valid" ? ("used" as const) : t.Status })),
      version: b.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(S.bookings.vistaBookingId, b.vistaBookingId))
    .returning();
  return u!;
}
