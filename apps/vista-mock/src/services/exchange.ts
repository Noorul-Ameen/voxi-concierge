/** Demo-only atomic exchange capability. Transfer paid value; settle the genuine difference once. */
import { type Db, schema as S, bookingReference, flattenLayout, nowLocalDate, shortId } from "@voxi/db";
import { centsToPoints } from "@voxi/domain";
import { and, eq, sql } from "drizzle-orm";
import { getBooking } from "./bookings.js";
import { type OrderCfg, RC, VistaError, loadSeatState, saveSeatState } from "./orders.js";
import { consumeWalletCredits, expireWalletCredits, refundCreditExpiry } from "./wallet.js";

export type ExchangeRequest = {
  BookingId: string;
  TargetCinemaId: string;
  TargetSessionId: string;
  ExpectedVersion: number;
  ExpectedTotalCents: number;
  ExpectedDifferenceCents: number;
  Seats: { Row: string; Number: string; TicketTypeCode: string }[];
  PaymentMethod: string;
  RefundMethod: string;
  Reference: string;
  ConversationId: string;
};
export async function exchangeBooking(db: Db, req: ExchangeRequest, cfg: OrderCfg) {
  const source = await getBooking(db, req.BookingId);
  return db.transaction(async (tx) => {
    // The same lock order in every exchange avoids opposite-direction seat deadlocks.
    for (const key of [
      ...new Set([`${source.cinemaId}-${source.sessionId}`, `${req.TargetCinemaId}-${req.TargetSessionId}`]),
    ].sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [original] = await tx
      .select()
      .from(S.bookings)
      .where(eq(S.bookings.vistaBookingId, req.BookingId))
      .for("update");
    if (!original) throw new VistaError(RC.GENERAL, RC.BOOKING_NOT_FOUND, "Booking not found");
    if (original.swappedToBookingId) {
      const [repeated] = await tx
        .select()
        .from(S.bookings)
        .where(eq(S.bookings.vistaBookingId, original.swappedToBookingId));
      if (
        repeated?.payments.some(
          (p) => p.Reference === req.Reference || p.Reference === `${req.Reference}:carry`,
        )
      ) {
        const difference = repeated.totalValueCents - original.totalValueCents;
        if (
          repeated.totalValueCents !== req.ExpectedTotalCents ||
          difference !== req.ExpectedDifferenceCents ||
          repeated.cinemaId !== req.TargetCinemaId ||
          repeated.sessionId !== req.TargetSessionId
        )
          throw new VistaError(
            RC.GENERAL,
            RC.INVALID_STATE,
            "The exchange reference belongs to a different confirmed request",
          );
        return {
          booking: repeated,
          differenceCents: difference,
          settlement: {
            method: difference < 0 ? req.RefundMethod : req.PaymentMethod,
            amountCents: Math.abs(difference),
            direction: difference < 0 ? "refund" : difference > 0 ? "charge" : "none",
            originalPaidValueTransferredCents: Math.min(original.totalValueCents, repeated.totalValueCents),
          },
          idempotent: true,
        };
      }
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "This booking was already exchanged by another request",
      );
    }
    if (
      original.version !== req.ExpectedVersion ||
      original.status !== "confirmed" ||
      original.refundedValueCents ||
      original.ticketsCollected ||
      original.tickets.some((t) => t.Status !== "valid") ||
      original.appliedOffers.some((o) => o.type === "bank" || o.type === "partner") ||
      original.isThirdParty
    )
      throw new VistaError(
        RC.GENERAL,
        RC.BOOKING_NOT_REFUNDABLE,
        "The original booking changed or is not exchangeable",
      );
    if (original.cinemaId !== req.TargetCinemaId || original.sessionId === req.TargetSessionId)
      throw new VistaError(
        RC.GENERAL,
        RC.BOOKING_NOT_REFUNDABLE,
        "Choose another session at the same cinema",
      );
    const now = nowLocalDate().getTime();
    if (original.showtime.getTime() - now < 30 * 60_000)
      throw new VistaError(
        RC.GENERAL,
        RC.BOOKING_NOT_REFUNDABLE,
        "The original show is inside the exchange cutoff",
      );
    const target = await loadSeatState(tx, req.TargetCinemaId, req.TargetSessionId);
    if (
      target.sess.hoCode !== original.hoCode ||
      !target.sess.allowTicketSales ||
      target.sess.showtime.getTime() - now < 30 * 60_000
    )
      throw new VistaError(
        RC.GENERAL,
        RC.SESSION_NOT_FOUND,
        "The target must be the same film and still on sale after the cutoff",
      );
    if (
      req.Seats.length !== original.tickets.length ||
      new Set(req.Seats.map((s) => `${s.Row}:${s.Number}`)).size !== req.Seats.length
    )
      throw new VistaError(RC.GENERAL, RC.TICKET_TYPE_INVALID, "The same ticket count is required");
    const layout = flattenLayout(target.tpl.layout);
    const types = await tx
      .select()
      .from(S.ticketTypes)
      .where(
        and(
          eq(S.ticketTypes.cinemaId, req.TargetCinemaId),
          eq(S.ticketTypes.experience, target.sess.experience),
        ),
      );
    const bookingId = bookingReference();
    const tickets = req.Seats.map((seat, i) => {
      const physical = layout.find((s) => s.row === seat.Row && s.number === seat.Number);
      const state = target.state.seats[`${seat.Row}:${seat.Number}`];
      const type = types.find((t) => t.ticketTypeCode === seat.TicketTypeCode);
      const prior = original.tickets[i]!;
      if (!physical || !state || state.status !== 0)
        throw new VistaError(
          RC.GENERAL,
          RC.SEATS_UNAVAILABLE,
          "A proposed seat is no longer available; original booking retained",
        );
      if (
        !type ||
        type.ticketTypeCode.slice(-4) !== prior.TicketTypeCode.slice(-4) ||
        type.areaCategoryCode !== physical.areaCategoryCode ||
        (type.isChildOnlyTicket && !/child/i.test(prior.Description)) ||
        (!type.isChildOnlyTicket && /child/i.test(prior.Description)) ||
        type.areaCategoryCode !== prior.AreaCategoryCode
      )
        throw new VistaError(
          RC.GENERAL,
          RC.TICKET_TYPE_INVALID,
          "The target ticket type or seat tier differs from the agreed booking",
        );
      return {
        ...prior,
        TicketTypeCode: type.ticketTypeCode,
        Description: type.description,
        DescriptionAlt: type.descriptionAlt ?? "",
        PriceCents: type.priceInCents,
        FinalPriceCents: type.priceInCents,
        DiscountPriceCents: 0,
        TaxCents: Math.round(type.priceInCents - type.priceInCents / (1 + cfg.taxRate)),
        AreaCategoryCode: physical.areaCategoryCode,
        SeatRowId: physical.row,
        SeatNumber: physical.number,
        SeatRowIndex: physical.rowIndex,
        SeatColumnIndex: physical.columnIndex,
        SeatAreaNumber: physical.areaNumber,
        DealDefinitionId: null,
        DealDescription: null,
        Barcode: `${bookingId}${String(i + 1).padStart(2, "0")}`,
        Status: "valid" as const,
      };
    });
    // Food is transferred exactly at its paid value; unavailable food never silently disappears.
    for (const food of original.concessions) {
      const [item] = await tx.select().from(S.concessionItems).where(eq(S.concessionItems.id, food.ItemId));
      if (
        !item?.active ||
        (item.cinemaId && item.cinemaId !== req.TargetCinemaId) ||
        (item.experiences?.length && !item.experiences.includes(target.sess.experience))
      )
        throw new VistaError(
          RC.GENERAL,
          RC.CONCESSION_INVALID,
          "Food cannot transfer to this experience; original booking retained",
        );
    }
    const fee = tickets.length * cfg.bookingFeeCentsPerTicket;
    const total =
      tickets.reduce((n, t) => n + t.FinalPriceCents, 0) +
      original.concessions.reduce((n, c) => n + c.FinalPriceCents, 0) +
      fee;
    const difference = total - original.totalValueCents;
    if (total !== req.ExpectedTotalCents || difference !== req.ExpectedDifferenceCents)
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "Exchange price changed; original booking retained until a fresh review",
      );
    const originalCard = original.payments.find((p) => p.PaymentTenderCategory === "CREDIT");
    const method = difference < 0 ? req.RefundMethod : req.PaymentMethod;
    if (
      difference < 0 &&
      method === "ORIGINAL_PAYMENT" &&
      -difference >
        original.payments
          .filter((p) => p.PaymentTenderCategory === "CREDIT")
          .reduce((n, p) => n + p.PaymentValueCents, 0)
    )
      throw new VistaError(
        RC.GENERAL,
        RC.PAYMENT_DECLINED,
        "The refund exceeds the original card payment; choose a supported destination",
      );
    const balance =
      method === "VOX_CREDIT" ? "VOX_REWARDS" : method === "SHARE_POINTS" ? "SHARE_POINTS" : null;
    if (
      difference &&
      !balance &&
      (!originalCard || !["CARD", "SAVED_CARD", "ORIGINAL_PAYMENT"].includes(method))
    )
      throw new VistaError(
        RC.GENERAL,
        RC.PAYMENT_DECLINED,
        "No supported original card exists for this difference",
      );
    if (difference && balance) {
      const memberId = original.customer.MemberId;
      if (memberId && balance === "VOX_REWARDS") await expireWalletCredits(tx, memberId);
      const [account] = memberId
        ? await tx
            .select()
            .from(S.loyaltyAccounts)
            .where(eq(S.loyaltyAccounts.memberId, memberId))
            .for("update")
        : [];
      if (!account)
        throw new VistaError(RC.GENERAL, RC.INSUFFICIENT_FUNDS, "A verified member balance is required");
      const delta = balance === "SHARE_POINTS" ? -centsToPoints(difference) : -difference;
      if (
        (balance === "SHARE_POINTS" ? account.sharePointsBalance : account.voxRewardsBalanceCents) + delta <
        0
      )
        throw new VistaError(
          RC.GENERAL,
          RC.INSUFFICIENT_FUNDS,
          "Insufficient balance for the price difference; original booking retained",
        );
      if (balance === "VOX_REWARDS" && difference > 0) await consumeWalletCredits(tx, memberId!, difference);
      await tx
        .update(S.loyaltyAccounts)
        .set({
          ...(balance === "SHARE_POINTS"
            ? { sharePointsBalance: account.sharePointsBalance + delta }
            : { voxRewardsBalanceCents: account.voxRewardsBalanceCents + delta }),
          version: account.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(S.loyaltyAccounts.memberId, memberId!));
      await tx.insert(S.loyaltyLedger).values({
        id: shortId(12),
        memberId: memberId!,
        balanceType: balance,
        delta,
        ...(balance === "VOX_REWARDS" && difference < 0
          ? { expiresAt: refundCreditExpiry(), remainingValueCents: -difference }
          : {}),
        reason: `Exchange difference ${original.vistaBookingId}`,
        reference: req.Reference,
      });
    }
    if (difference < 0)
      await tx.insert(S.refunds).values({
        id: `rf_${shortId(10)}`,
        bookingId: original.vistaBookingId,
        amountCents: -difference,
        method,
        tenderCategory:
          balance === "VOX_REWARDS" ? "EWALLET" : balance === "SHARE_POINTS" ? "LOYALTY" : "CREDIT",
        ticketIds: [],
        reason: `Exchange difference to ${bookingId}`,
        reference: req.Reference,
        status: balance ? "completed" : "pending",
        conversationId: req.ConversationId,
      });
    const sourceSeats = await loadSeatState(tx, original.cinemaId, original.sessionId);
    for (const seat of original.tickets) {
      const key = `${seat.SeatRowId}:${seat.SeatNumber}`;
      if (sourceSeats.state.seats[key]?.bookingId !== original.vistaBookingId)
        throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Original seat ownership changed");
      sourceSeats.state.seats[key] = { status: 0 };
    }
    for (const seat of tickets)
      target.state.seats[`${seat.SeatRowId}:${seat.SeatNumber}`] = { status: 1, bookingId };
    await saveSeatState(
      tx,
      original.cinemaId,
      original.sessionId,
      sourceSeats.state.seats,
      sourceSeats.state.version,
    );
    await saveSeatState(
      tx,
      req.TargetCinemaId,
      req.TargetSessionId,
      target.state.seats,
      target.state.version,
    );
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('booking-reference-sequence'))`);
    const [numbers] = await tx
      .select({
        number: sql<number>`coalesce(max(${S.bookings.vistaBookingNumber}),100000)+1`,
        transaction: sql<number>`coalesce(max(${S.bookings.vistaTransNumber}),500000)+1`,
      })
      .from(S.bookings);
    const carry = Math.min(original.totalValueCents, total);
    const basePayment = originalCard ?? original.payments[0]!;
    let toCarry = carry;
    const payments: (typeof original.payments)[number][] = original.payments.flatMap((payment) => {
      const amount = Math.min(toCarry, payment.PaymentValueCents);
      toCarry -= amount;
      return amount > 0
        ? [
            {
              ...payment,
              PaymentValueCents: amount,
              ...(payment.PaymentTenderCategory === "LOYALTY"
                ? { PointsRedeemed: centsToPoints(amount) }
                : {}),
              Reference: `${req.Reference}:carry`,
            },
          ]
        : [];
    });
    if (toCarry !== 0)
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "Original payment records do not reconcile; original booking retained",
      );
    if (difference > 0)
      payments.push({
        ...basePayment,
        PaymentTenderCategory:
          balance === "VOX_REWARDS" ? "EWALLET" : balance === "SHARE_POINTS" ? "LOYALTY" : "CREDIT",
        PaymentValueCents: difference,
        ...(balance
          ? {
              PointsRedeemed: balance === "SHARE_POINTS" ? centsToPoints(difference) : undefined,
              CardNumberMasked: undefined,
              CardType: undefined,
            }
          : {}),
        Reference: req.Reference,
      });
    const [booking] = await tx
      .insert(S.bookings)
      .values({
        ...original,
        vistaBookingId: bookingId,
        vistaBookingNumber: Number(numbers!.number),
        vistaTransNumber: Number(numbers!.transaction),
        sessionId: req.TargetSessionId,
        showtime: target.sess.showtime,
        experience: target.sess.experience,
        screenName: target.sess.screenName,
        tickets,
        payments,
        totalValueCents: total,
        bookingFeeValueCents: fee,
        taxValueCents: Math.round(total - fee - (total - fee) / (1 + cfg.taxRate)),
        appliedOffers: [],
        refundedValueCents: 0,
        source: "concierge-swap",
        qrPayload: `VOX|${bookingId}|${req.TargetCinemaId}|${req.TargetSessionId}`,
        swappedFromBookingId: original.vistaBookingId,
        swappedToBookingId: null,
        version: 1,
        bookedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    await tx
      .update(S.bookings)
      .set({
        status: "swapped",
        swappedToBookingId: bookingId,
        refundedValueCents: Math.max(0, -difference),
        version: original.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(S.bookings.vistaBookingId, original.vistaBookingId));
    return {
      booking: booking!,
      differenceCents: difference,
      settlement: {
        direction: difference > 0 ? "charge" : difference < 0 ? "refund" : "none",
        amountCents: Math.abs(difference),
        method,
        originalPaidValueTransferredCents: carry,
      },
      idempotent: false,
    };
  });
}
