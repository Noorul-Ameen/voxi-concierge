import { ErrorCodes, type ToolInput } from "@voxi/contracts";
import { evaluateCancellation, resolveSpokenDate } from "@voxi/domain";
import { createConfirmation } from "../services/confirmations.js";
import { fmtDateTime, money, t } from "../services/format.js";
import { previewSeats } from "../services/seat-preview.js";
import { bookingCard, toSnapshot, verifyOwnership } from "./bookings.js";
import { sessionCard } from "./movies.js";
import { type ToolCtx, err, ok } from "./types.js";

export async function prepareSwap(ctx: ToolCtx, input: ToolInput<"prepare_swap">) {
  const b = (await ctx.vista.getBooking(input.bookingId).catch(() => null))?.Booking;
  if (!b) return err(ErrorCodes.BOOKING_NOT_FOUND, "I couldn't find that booking.");
  const ownership = verifyOwnership(ctx, b, input.verification);
  if (!ownership.ok) return err("VERIFICATION_REQUIRED", ownership.message);
  const eligibility = evaluateCancellation(toSnapshot(b), ctx.nowLocal, undefined, ctx.cfg.policy);
  if (!eligibility.eligible || b.Status !== "confirmed")
    return err(
      ErrorCodes.BOOKING_NOT_ELIGIBLE,
      eligibility.reasons[0] ?? "Only an unchanged confirmed booking can be exchanged.",
      false,
      { eligibility },
    );
  const cinema = await ctx.catalog.cinema(b.CinemaId);
  const cinemaName = ctx.lang === "ar" ? cinema?.nameAlt || cinema?.name : cinema?.name;
  const date = resolveSpokenDate(input.date ?? b.Showtime.slice(0, 10), ctx.nowLocal);
  const wanted = `${date}T${input.time ?? b.Showtime.slice(11, 16)}:00`;
  const sessions = (await ctx.catalog.sessions(b.CinemaId))
    .filter(
      (s) =>
        s.hoCode === b.ScheduledFilmId &&
        s.sessionId !== String(b.SessionId) &&
        s.allowTicketSales &&
        !s.soldOut &&
        (Date.parse(`${s.showtime}Z`) - Date.parse(`${ctx.nowLocal}Z`)) / 60000 >=
          ctx.cfg.policy.cutoffMinutes &&
        (!input.date || s.showtime.slice(0, 10) === date) &&
        (!input.experience || s.experience === input.experience),
    )
    .sort(
      (a, b) =>
        Math.abs(Date.parse(`${a.showtime}Z`) - Date.parse(`${wanted}Z`)) -
          Math.abs(Date.parse(`${b.showtime}Z`) - Date.parse(`${wanted}Z`)) ||
        a.showtime.localeCompare(b.showtime),
    );
  const alternatives = sessions.slice(0, 3).map((s) => sessionCard(s, ctx.lang, ctx.nowLocal, cinemaName));
  const target = input.targetSessionKey ? await ctx.catalog.sessionByKey(input.targetSessionKey) : undefined;
  if (!target || !sessions.some((s) => s.key === target.key))
    return ok(
      { needs: "swap_session", bookingId: b.VistaBookingId, sameCinemaRequired: true, alternatives },
      t(
        ctx.lang,
        target?.cinemaId && target.cinemaId !== b.CinemaId
          ? `The swap must stay at ${cinemaName}. Here are the closest available showtimes for the same film.`
          : "Choose one of these closest available showtimes at the same cinema. Your original booking remains confirmed.",
        "اختر أحد أقرب المواعيد المتاحة للفيلم نفسه في السينما نفسها. يظل حجزك الأصلي مؤكداً.",
      ),
      {
        type: "showtimes",
        items: alternatives,
        meta: { bookingId: b.VistaBookingId, journey: "swap", sameCinemaRequired: true },
        actions: alternatives.map((s) => ({
          label: `${s.dateLabel} ${s.time} · ${s.experience}`,
          value: `swap-choice:${b.VistaBookingId}:${s.sessionKey}`,
        })),
      },
    );
  const [seatPlan, types] = await Promise.all([
    ctx.vista.seatPlan(target.cinemaId, target.sessionId),
    ctx.vista.ticketTypes(target.cinemaId, target.sessionId),
  ]);
  if (types.BookingFeeCentsPerTicket == null)
    return err(
      ErrorCodes.VISTA_UNAVAILABLE,
      "This provider cannot quote the complete exchange price. Customer Care can help without changing your booking.",
    );
  const originalTickets = b.Tickets as Record<string, any>[];
  const seats: { Row: string; Number: string; TicketTypeCode: string }[] = [];
  const tickets: { TicketTypeCode: string; Qty: number }[] = [];
  let ticketsCents = 0;
  const seatOptions = new Map<string, { row: string; number: string }[]>();
  for (const area of new Set(originalTickets.map((t) => String(t.SeatAreaCatCode ?? t.AreaCategoryCode)))) {
    const group = originalTickets.filter((t) => String(t.SeatAreaCatCode ?? t.AreaCategoryCode) === area);
    const layout = {
      ...seatPlan.SeatLayoutData,
      Areas: (seatPlan.SeatLayoutData?.Areas ?? []).filter((a: any) => String(a.AreaCategoryCode) === area),
    };
    const previous = group.map((t) => ({ row: String(t.SeatRowId), number: String(t.SeatNumber) }));
    const same = input.keepSeatsIfPossible ? previewSeats(layout, group.length, "middle", previous) : null;
    const selected = same ?? previewSeats(layout, group.length, "middle", undefined, previous);
    if (!selected)
      return err(
        ErrorCodes.SEATS_UNAVAILABLE,
        "Matching seats are unavailable at this showtime. Your original booking remains confirmed.",
        false,
        { needs: "swap_session", alternatives },
      );
    seatOptions.set(
      area,
      selected.map(({ row, number }) => ({ row, number })),
    );
  }
  for (const original of originalTickets) {
    const area = String(original.SeatAreaCatCode ?? original.AreaCategoryCode);
    const child = /child/i.test(original.Description);
    const same = types.Tickets.find(
      (type) =>
        String(type.TicketTypeCode).slice(-4) === String(original.TicketTypeCode).slice(-4) &&
        String(type.AreaCategoryCode) === area &&
        !!type.IsChildOnlyTicket === child &&
        (!type.IsAvailableForLoyaltyMembersOnly || ctx.conversation.memberId),
    );
    if (!same)
      return err(
        ErrorCodes.BOOKING_NOT_ELIGIBLE,
        "The new show does not offer the same ticket type and seat tier. Your original booking remains confirmed.",
      );
    const seat = seatOptions.get(area)!.shift()!;
    seats.push({ Row: seat.row, Number: seat.number, TicketTypeCode: same.TicketTypeCode });
    ticketsCents += same.PriceInCents;
    const group = tickets.find((t) => t.TicketTypeCode === same.TicketTypeCode);
    if (group) group.Qty++;
    else tickets.push({ TicketTypeCode: same.TicketTypeCode, Qty: 1 });
  }
  const menu = (await ctx.vista.concessions(target.cinemaId)).ConcessionTabs.flatMap((tab) => tab.Items);
  const food = (b.Concessions ?? []) as Record<string, any>[];
  const unavailableFood = food.filter(
    (line) =>
      !menu.some(
        (item) =>
          item.Id === line.ItemId &&
          (!item.Experiences?.length || item.Experiences.includes(target.experience)),
      ),
  );
  if (unavailableFood.length)
    return err(
      ErrorCodes.BOOKING_NOT_ELIGIBLE,
      "The same food cannot transfer to this show. Your original booking is unchanged; choose another compatible show or ask Customer Care.",
      false,
      {
        needs: "food_resolution",
        unavailableFood: unavailableFood.map((f) => ({
          itemId: f.ItemId,
          description: f.Description,
          quantity: f.Quantity,
        })),
      },
    );
  const newTotalCents =
    ticketsCents +
    food.reduce((n, line) => n + line.FinalPriceCents, 0) +
    originalTickets.length * types.BookingFeeCentsPerTicket;
  const differenceCents = newTotalCents - b.TotalValueCents;
  const originalPayment = b.PaymentInfoCollection?.[0];
  const defaultPayment =
    originalPayment?.PaymentTenderCategory === "LOYALTY"
      ? "SHARE_POINTS"
      : originalPayment?.PaymentTenderCategory === "EWALLET"
        ? "VOX_CREDIT"
        : "CARD";
  const paymentMethod = input.paymentMethodForDifference ?? defaultPayment;
  const refundMethod =
    input.refundMethodForDifference ?? (defaultPayment === "CARD" ? "ORIGINAL_PAYMENT" : defaultPayment);
  if (
    (paymentMethod === "VOX_CREDIT" ||
      paymentMethod === "SHARE_POINTS" ||
      refundMethod === "VOX_CREDIT" ||
      refundMethod === "SHARE_POINTS") &&
    !b.Customer?.MemberId
  )
    return err(ErrorCodes.LOGIN_REQUIRED, "A member balance cannot be used for this guest booking.");
  if (
    (differenceCents > 0 && !["CARD", "SAVED_CARD", "VOX_CREDIT", "SHARE_POINTS"].includes(paymentMethod)) ||
    (differenceCents < 0 && !["ORIGINAL_PAYMENT", "VOX_CREDIT", "SHARE_POINTS"].includes(refundMethod))
  )
    return err(ErrorCodes.VALIDATION, "Choose a supported method for the exchange difference.");
  if (
    ((differenceCents > 0 && ["CARD", "SAVED_CARD"].includes(paymentMethod)) ||
      (differenceCents < 0 && refundMethod === "ORIGINAL_PAYMENT")) &&
    !b.PaymentInfoCollection?.some((p: any) => p.PaymentTenderCategory === "CREDIT")
  )
    return err(
      ErrorCodes.VALIDATION,
      "This booking has no original card available for the price difference.",
    );
  if (
    differenceCents < 0 &&
    refundMethod === "ORIGINAL_PAYMENT" &&
    -differenceCents >
      (b.PaymentInfoCollection ?? [])
        .filter((p: any) => p.PaymentTenderCategory === "CREDIT")
        .reduce((n: number, p: any) => n + p.PaymentValueCents, 0)
  )
    return err(
      ErrorCodes.VALIDATION,
      "The difference exceeds the amount paid on the original card. Choose another permitted refund destination.",
    );
  const cardLast4 =
    String(b.PaymentInfoCollection?.find((p: any) => p.PaymentTenderCategory === "CREDIT")?.CardNumber ?? "")
      .replace(/\D/g, "")
      .slice(-4) || undefined;
  const financial = {
    settlementType: "difference_only",
    originalTotalCents: b.TotalValueCents,
    newTotalCents,
    differenceCents,
    chargeCents: Math.max(0, differenceCents),
    refundCents: Math.max(0, -differenceCents),
    paymentMethod,
    refundMethod,
    cardLast4,
    refundEta:
      refundMethod === "ORIGINAL_PAYMENT"
        ? "5–10 days to the same original card"
        : refundMethod === "SHARE_POINTS"
          ? "SHARE Points returned immediately"
          : "VOX credit valid for 90 days",
    originalPaidValueTransferredCents: Math.min(b.TotalValueCents, newTotalCents),
  };
  const summary = {
    bookingId: b.VistaBookingId,
    filmTitle: b.FilmTitle,
    fromShowtime: b.Showtime,
    targetSessionKey: target.key,
    targetCinemaId: target.cinemaId,
    targetSessionId: target.sessionId,
    targetShowtime: target.showtime,
    targetExperience: target.experience,
    ticketCount: originalTickets.length,
    tickets,
    selectedSeats: seats,
    originalSeats: originalTickets.map((t) => `${t.SeatRowId}${t.SeatNumber}`),
    concessions: food.map((f) => ({ itemId: f.ItemId, description: f.Description, quantity: f.Quantity })),
    expectedVersion: b.Version,
    ...financial,
  };
  const financialText =
    differenceCents > 0
      ? `Only ${money(differenceCents, ctx.lang)} extra will be charged to ${paymentMethod === "VOX_CREDIT" ? "VOX credit" : paymentMethod === "SHARE_POINTS" ? "SHARE Points" : `the original card${cardLast4 ? ` ending ${cardLast4}` : ""}`}.`
      : differenceCents < 0
        ? `${money(-differenceCents, ctx.lang)} will be refunded to ${refundMethod === "ORIGINAL_PAYMENT" ? `the same original card${cardLast4 ? ` ending ${cardLast4}` : ""} in 5–10 days` : refundMethod === "SHARE_POINTS" ? "SHARE Points" : "VOX credit, valid for 90 days"}.`
        : "The total is unchanged; there is no new charge or refund.";
  const arabicMethod =
    differenceCents > 0
      ? paymentMethod === "VOX_CREDIT"
        ? "رصيد VOX"
        : paymentMethod === "SHARE_POINTS"
          ? "نقاط SHARE"
          : `البطاقة الأصلية${cardLast4 ? ` المنتهية بـ ${cardLast4}` : ""}`
      : refundMethod === "ORIGINAL_PAYMENT"
        ? `البطاقة الأصلية نفسها${cardLast4 ? ` المنتهية بـ ${cardLast4}` : ""} خلال 5–10 أيام`
        : refundMethod === "SHARE_POINTS"
          ? "نقاط SHARE فوراً"
          : "رصيد VOX الصالح لمدة 90 يوماً";
  const speech = t(
    ctx.lang,
    `Move ${originalTickets.length} tickets for ${b.FilmTitle} to ${fmtDateTime(target.showtime, ctx.lang, ctx.nowLocal)}, ${target.experience} at ${cinemaName}, seats ${seats.map((s) => s.Row + s.Number).join(", ")}. ${food.length ? "Your existing food transfers unchanged. " : ""}${financialText} Shall I confirm this exchange?`,
    `أنقل ${originalTickets.length} تذكرة لفيلم ${b.FilmTitle} إلى ${fmtDateTime(target.showtime, "ar", ctx.nowLocal)}، ${target.experience} في ${cinemaName}، المقاعد ${seats.map((s) => s.Row + s.Number).join("، ")}. ${food.length ? "تنتقل وجباتك الحالية دون تغيير. " : ""}${differenceCents === 0 ? "لا يوجد خصم أو استرداد جديد." : `${differenceCents > 0 ? "يُخصم فقط" : "يُسترد"} ${money(Math.abs(differenceCents), "ar")} ${differenceCents > 0 ? "من" : "إلى"} ${arabicMethod}.`} هل تؤكد التبديل؟`,
  );
  const confirmation = await createConfirmation(ctx.db, {
    conversationId: ctx.conversation.id,
    actionType: "swap_booking",
    resourceKey: `booking:${b.VistaBookingId}`,
    summary,
    spokenSummary: speech,
    ttlSeconds: ctx.cfg.confirmationTtlSeconds,
  });
  return ok({ confirmationId: confirmation.id, summary }, speech, {
    type: "booking",
    title: t(ctx.lang, "Confirm exchange", "تأكيد التبديل"),
    items: [
      {
        ...bookingCard(b, ctx.lang, ctx.nowLocal, cinemaName),
        swapTo: {
          showtimeLabel: fmtDateTime(target.showtime, ctx.lang, ctx.nowLocal),
          experience: target.experience,
          cinemaName,
          seats: seats.map((s) => s.Row + s.Number),
          concessions: summary.concessions,
          ...financial,
        },
      },
    ],
    meta: { confirmationId: confirmation.id },
    actions: [
      { label: t(ctx.lang, "Confirm exchange", "تأكيد التبديل"), value: `confirm:${confirmation.id}` },
      { label: t(ctx.lang, "Keep original", "الاحتفاظ بالأصلي"), value: "abort" },
    ],
  });
}
