import { DomainError, ErrorCodes, type ToolInput } from "@voxi/contracts";
import { evaluateCancellation, resolveSpokenDate } from "@voxi/domain";
import { createConfirmation } from "../services/confirmations.js";
import { fmtDateTime, money, t } from "../services/format.js";
import { signRefundChoice, verifyRefundChoice } from "../services/refund-choice-proof.js";
import { previewSeats } from "../services/seat-preview.js";
import { bookingCard, checkOwner, refundHeader, toSnapshot } from "./bookings.js";
import { loadCustomer } from "./customer.js";
import { sessionCard } from "./movies.js";
import { type ToolCtx, err, ok } from "./types.js";

export async function prepareSwap(ctx: ToolCtx, input: ToolInput<"prepare_swap">) {
  const keepSeatsIfPossible = input.keepSeatsIfPossible ?? true;
  const b = (await ctx.vista.getBooking(input.bookingId).catch(() => null))?.Booking;
  if (!b) return err(ErrorCodes.BOOKING_NOT_FOUND, "I couldn't find that booking.");
  if (ctx.refundChoiceProof) {
    try {
      await verifyRefundChoice(ctx, ctx.refundChoiceProof, {
        bookingId: b.VistaBookingId,
        bookingVersion: b.Version,
        swapTargetSessionKey: input.targetSessionKey,
        keepSeatsIfPossible,
      });
    } catch (error) {
      if (error instanceof DomainError) return err(error.code, error.message);
      throw error;
    }
  }
  const ownership = ctx.refundChoiceProof
    ? { ok: true as const }
    : await checkOwner(ctx, b, input.verification);
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
  const preferredExperience = input.experience ?? b.Experience;
  if (
    !input.targetSessionKey &&
    input.keepSeatsIfPossible !== false &&
    date === b.Showtime.slice(0, 10) &&
    (!input.time || input.time === b.Showtime.slice(11, 16)) &&
    preferredExperience === b.Experience
  )
    return ok(
      {
        needs: "swap_change",
        bookingId: b.VistaBookingId,
        originalBookingUnchanged: true,
        current: {
          cinemaId: b.CinemaId,
          cinemaName,
          filmTitle: b.FilmTitle,
          date: b.Showtime.slice(0, 10),
          time: b.Showtime.slice(11, 16),
          experience: b.Experience,
        },
      },
      t(
        ctx.lang,
        "That matches your current booking. What would you like to change: the date, time, experience or seats? Your booking is unchanged.",
        "هذا يطابق حجزك الحالي. ماذا تريد تغييره: اليوم أو الوقت أو التجربة أو المقاعد؟ حجزك لم يتغير.",
      ),
    );
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
      (a, other) =>
        Number(a.showtime.slice(0, 10) !== date) - Number(other.showtime.slice(0, 10) !== date) ||
        (preferredExperience
          ? Number(a.experience !== preferredExperience) - Number(other.experience !== preferredExperience)
          : 0) ||
        Math.abs(Date.parse(`${a.showtime}Z`) - Date.parse(`${wanted}Z`)) -
          Math.abs(Date.parse(`${other.showtime}Z`) - Date.parse(`${wanted}Z`)) ||
        a.showtime.localeCompare(other.showtime),
    );
  const alternatives = sessions.slice(0, 3).map((s) => sessionCard(s, ctx.lang, ctx.nowLocal, cinemaName));
  const emptyScope = !alternatives.length
    ? {
        nextStep: "ask_before_widening" as const,
        requestedScope: {
          hoCode: b.ScheduledFilmId,
          filmTitle: b.FilmTitle,
          cinemaId: b.CinemaId,
          cinemaName,
          date,
          dateMatch: input.date ? "requested_day" : "original_day_preferred",
          time: input.time ?? b.Showtime.slice(11, 16),
          timeMatch: "closest_to",
          experience: preferredExperience,
          experienceMatch: input.experience ? "required" : "original_preferred",
        },
        availabilityScope: "closest_matches_only" as const,
        canConcludeNoShowsAllDay: false,
        originalBookingUnchanged: true,
      }
    : undefined;
  // Finding the best candidate is read-only. A separate priced preview still
  // supplies its own confirmation before any exchange or payment is possible.
  const recommendedPreviewInput =
    !input.targetSessionKey && sessions[0]
      ? {
          ...input,
          bookingId: b.VistaBookingId,
          date: sessions[0].showtime.slice(0, 10),
          targetSessionKey: sessions[0].key,
        }
      : undefined;
  const target = input.targetSessionKey ? await ctx.catalog.sessionByKey(input.targetSessionKey) : undefined;
  if (!target || !sessions.some((s) => s.key === target.key))
    return ok(
      {
        needs: "swap_session",
        bookingId: b.VistaBookingId,
        sameCinemaRequired: true,
        alternatives,
        ...emptyScope,
        ...(recommendedPreviewInput ? { nextStep: "preview_recommended", recommendedPreviewInput } : {}),
      },
      t(
        ctx.lang,
        !alternatives.length
          ? "No suitable replacement matched these preferences. Your original booking is unchanged. Would you like to change the date, time, experience or cinema?"
          : target?.cinemaId && target.cinemaId !== b.CinemaId
            ? `The swap must stay at ${cinemaName}. Here are the closest available showtimes for the same film.`
            : "The closest matching showtimes are available at the same cinema. Your original booking remains confirmed.",
        alternatives.length
          ? "هذه أقرب المواعيد المتاحة للفيلم نفسه في السينما نفسها. يظل حجزك الأصلي مؤكداً."
          : "لم أجد بديلاً مناسباً يطابق هذه التفضيلات. حجزك الأصلي لم يتغير. هل ترغب في تغيير اليوم أو الوقت أو التجربة أو السينما؟",
      ),
      {
        type: "showtimes",
        items: alternatives,
        meta: { bookingId: b.VistaBookingId, journey: "swap", sameCinemaRequired: true, ...emptyScope },
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
  const customer = await loadCustomer(ctx);
  const savedPreference = customer?.profile?.seatPreference ?? customer?.preferences?.seatPreference;
  const preference = ["front", "middle", "back", "aisle", "any"].includes(savedPreference ?? "")
    ? savedPreference
    : undefined;
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
    // Brief §8: seats the guest picked on the map (or spoke) win over the original / profile preference.
    const requested = input.seats?.length
      ? input.seats.map((seat) => ({ row: String(seat.row).toUpperCase(), number: String(seat.number) }))
      : null;
    if (requested) {
      if (requested.length !== originalTickets.length)
        return err(
          ErrorCodes.VALIDATION,
          `Please choose ${originalTickets.length} seat${originalTickets.length === 1 ? "" : "s"} for this booking.`,
          false,
          { needs: "swap_seats", ticketCount: originalTickets.length },
        );
      const chosen = previewSeats(layout, group.length, "middle", requested.slice(0, group.length));
      if (!chosen)
        return err(
          ErrorCodes.SEATS_UNAVAILABLE,
          `Seats ${requested.map((seat) => seat.row + seat.number).join(", ")} aren't available for that show. Pick others on the map, or I can choose the closest free ones.`,
          false,
          { needs: "swap_seats", targetSessionKey: target.key, requested },
        );
      seatOptions.set(
        area,
        chosen.map(({ row, number }) => ({ row, number })),
      );
      continue;
    }
    const same = keepSeatsIfPossible ? previewSeats(layout, group.length, "middle", previous) : null;
    // Exact original seats remain first. If unavailable, honour verified profile
    // preference; passing "near" here would override its target row.
    const selected =
      same ??
      previewSeats(
        layout,
        group.length,
        preference ?? "middle",
        undefined,
        preference ? undefined : previous,
      );
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
    differenceCents < 0
      ? input.refundMethodForDifference
      : (input.refundMethodForDifference ??
        (defaultPayment === "CARD" ? "ORIGINAL_PAYMENT" : defaultPayment));
  const cardPayments = (b.PaymentInfoCollection ?? []).filter(
    (p: any) => p.PaymentTenderCategory === "CREDIT",
  );
  const cardLast4 =
    String(cardPayments[0]?.CardNumber ?? "")
      .replace(/\D/g, "")
      .slice(-4) || undefined;
  const sameCard =
    cardPayments.length > 0 &&
    !!cardLast4 &&
    new Set(cardPayments.map((p: any) => String(p.CardNumber).replace(/\s/g, ""))).size === 1;
  const permitted = b.Customer?.MemberId ? ctx.cfg.policy.refundMethods : ctx.cfg.policy.guestRefundMethods;
  const refundMethods =
    differenceCents < 0
      ? permitted.flatMap<ReturnType<typeof evaluateCancellation>["refundMethods"][number]>((method) => {
          if (method === "ORIGINAL_PAYMENT")
            return sameCard &&
              -differenceCents <= cardPayments.reduce((n: number, p: any) => n + p.PaymentValueCents, 0)
              ? [
                  {
                    method,
                    amountCents: -differenceCents,
                    eta: "5–10 days to the same original card",
                    cardLast4,
                    badges: b.Customer?.MemberId ? ["same_card"] : ["default"],
                  },
                ]
              : [];
          if (!b.Customer?.MemberId) return [];
          return [
            {
              method,
              amountCents: -differenceCents,
              eta:
                method === "VOX_CREDIT"
                  ? "VOX credit valid for 90 days"
                  : "SHARE Points returned immediately",
              ...(method === "VOX_CREDIT"
                ? { validityDays: 90, badges: ["recommended", "faster"] as ("recommended" | "faster")[] }
                : {}),
            },
          ];
        })
      : [];
  const selectedRefund = refundMethods.find((m) => m.method === refundMethod);
  if (
    differenceCents > 0 &&
    (paymentMethod === "VOX_CREDIT" || paymentMethod === "SHARE_POINTS") &&
    !b.Customer?.MemberId
  )
    return err(ErrorCodes.LOGIN_REQUIRED, "A member balance cannot be used for this guest booking.");
  if (differenceCents > 0 && !["CARD", "SAVED_CARD", "VOX_CREDIT", "SHARE_POINTS"].includes(paymentMethod))
    return err(ErrorCodes.VALIDATION, "Choose a supported method for the exchange difference.");
  if (
    differenceCents > 0 &&
    ["CARD", "SAVED_CARD"].includes(paymentMethod) &&
    !b.PaymentInfoCollection?.some((p: any) => p.PaymentTenderCategory === "CREDIT")
  )
    return err(
      ErrorCodes.VALIDATION,
      "This booking has no original card available for the price difference.",
    );
  const financial = {
    settlementType: "difference_only",
    originalTotalCents: b.TotalValueCents,
    newTotalCents,
    differenceCents,
    chargeCents: Math.max(0, differenceCents),
    refundCents: Math.max(0, -differenceCents),
    paymentMethod,
    refundMethod: differenceCents < 0 ? selectedRefund?.method : refundMethod,
    ...(differenceCents < 0
      ? { refundMethodSelected: !!selectedRefund, permittedRefundMethods: refundMethods.map((m) => m.method) }
      : {}),
    cardLast4,
    refundEta:
      differenceCents < 0 && !selectedRefund
        ? undefined
        : refundMethod === "ORIGINAL_PAYMENT"
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
    targetShowtimeLabel: fmtDateTime(target.showtime, ctx.lang, ctx.nowLocal),
    targetCinemaName: cinemaName,
    targetExperience: target.experience,
    ticketCount: originalTickets.length,
    tickets,
    selectedSeats: seats,
    originalSeats: originalTickets.map((t) => `${t.SeatRowId}${t.SeatNumber}`),
    concessions: food.map((f) => ({ itemId: f.ItemId, description: f.Description, quantity: f.Quantity })),
    expectedVersion: b.Version,
    ...financial,
  };
  if (differenceCents < 0 && !selectedRefund) {
    if (!refundMethods.length)
      return err(
        ErrorCodes.BOOKING_NOT_ELIGIBLE,
        "No permitted refund destination is available for this exchange. Your original booking is unchanged; Customer Care can help.",
      );
    return ok(
      {
        needs: "swap_refund_method",
        bookingId: b.VistaBookingId,
        targetSessionKey: target.key,
        summary,
        refundMethods,
        requestedMethodAllowed: !input.refundMethodForDifference,
      },
      t(
        ctx.lang,
        `${input.refundMethodForDifference ? "That destination is unavailable. " : ""}This exchange returns ${money(-differenceCents, ctx.lang)}. Choose ${refundMethods.map((m) => (m.method === "ORIGINAL_PAYMENT" ? `the same original card${cardLast4 ? ` ending ${cardLast4}` : ""} in 5–10 days` : m.method === "VOX_CREDIT" ? "VOX credit, valid for 90 days" : "SHARE Points")).join(" or ")}. Your booking is unchanged; you will review the exchange before confirming.`,
        `فرق السعر المسترد ${money(-differenceCents, "ar")}. اختر ${refundMethods.map((m) => (m.method === "ORIGINAL_PAYMENT" ? `البطاقة الأصلية نفسها${cardLast4 ? ` المنتهية بـ ${cardLast4}` : ""} خلال 5–10 أيام` : m.method === "VOX_CREDIT" ? "رصيد VOX الصالح لمدة 90 يوماً" : "نقاط SHARE")).join(" أو ")}. حجزك لم يتغير؛ ستراجع التبديل قبل تأكيده.`,
      ),
      {
        type: "refund_options",
        title: t(ctx.lang, "Choose exchange refund", "اختر طريقة استرداد فرق السعر"),
        items: refundMethods,
        meta: {
          journey: "swap",
          bookingId: b.VistaBookingId,
          recommendedMethod: refundMethods.some((m) => m.method === "VOX_CREDIT")
            ? "VOX_CREDIT"
            : refundMethods[0]?.method,
          canLinkForCredit: !b.Customer?.MemberId,
          signedIn: !!ctx.conversation.customerId,
          film: await refundHeader(ctx, b),
          targetSessionKey: target.key,
          keepSeatsIfPossible,
          summary,
          refundChoiceProof: signRefundChoice(ctx, {
            bookingId: b.VistaBookingId,
            bookingVersion: b.Version,
            swapTargetSessionKey: target.key,
            keepSeatsIfPossible,
          }),
        },
        actions: [],
      },
    );
  }
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
    `Move ${originalTickets.length === 1 ? "1 ticket" : `${originalTickets.length} tickets`} for ${b.FilmTitle} to ${fmtDateTime(target.showtime, ctx.lang, ctx.nowLocal)}, ${target.experience} at ${cinemaName}, seats ${seats.map((s) => s.Row + s.Number).join(", ")}. ${food.length ? "Your existing food transfers unchanged. " : ""}${financialText} Shall I confirm this exchange?`,
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
