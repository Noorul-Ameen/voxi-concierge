import { DomainError, ErrorCodes } from "@voxi/contracts";
import { type BookingSnapshot, evaluateCancellation, evaluateSwap } from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { enqueue, findByKey, idem, toRef } from "../actions/ledger.js";
import { consumeConfirmation, createConfirmation } from "../services/confirmations.js";
import { fmtDateTime, joinList, money, onDateTime, seatLabels, t } from "../services/format.js";
import { signRefundChoice, verifyRefundChoice } from "../services/refund-choice-proof.js";
import { prepareSwap } from "./swap.js";
import { type ToolCtx, type ToolHandlers, type ToolResult, err, ok } from "./types.js";

export type VistaBooking = Record<string, any>;

export function toSnapshot(b: VistaBooking): BookingSnapshot {
  return {
    bookingId: b.VistaBookingId,
    status: b.Status,
    showtime: b.Showtime,
    ticketsCollected: !!b.TicketsCollected,
    isThirdParty: !!b.IsThirdParty,
    hasMember: !!b.Customer?.MemberId,
    tickets: (b.Tickets ?? []).map((t: any) => ({
      Id: t.Id,
      FinalPriceCents: t.FinalPriceCents,
      DiscountPriceCents: t.DiscountPriceCents ?? 0,
      DealDefinitionId: t.DealDefinitionId ?? null,
      Status: t.Status ?? "valid",
    })),
    concessions: (b.Concessions ?? []).map((c: any) => ({
      Id: c.Id,
      FinalPriceCents: c.FinalPriceCents,
      activated: !!c.Activated,
    })),
    appliedOffers: b.AppliedOffers ?? [],
    bookingFeeValueCents: b.BookingFeeValueCents ?? 0,
    totalValueCents: b.TotalValueCents ?? 0,
    refundedValueCents: b.RefundedValueCents ?? 0,
    payments: b.PaymentInfoCollection ?? [],
  };
}

const mask = (s: string, keep = 4) =>
  s ? `${"•".repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}` : "";
const maskEmail = (e: string) => (e ? e.replace(/^(.).*?(@.*)$/, "$1•••$2") : "");

export function bookingCard(b: VistaBooking, lang: "en" | "ar", nowLocal: string, cinemaName?: string) {
  const seats = seatLabels(b.Tickets ?? []);
  return {
    bookingId: b.VistaBookingId,
    status: b.Status,
    filmTitle: lang === "ar" && b.AltFilmTitle ? b.AltFilmTitle : b.FilmTitle,
    rating: b.FilmClassification,
    cinemaId: b.CinemaId,
    cinemaName,
    experience: b.Experience,
    screenName: b.ScreenName,
    showtime: b.Showtime,
    showtimeLabel: fmtDateTime(b.Showtime, lang, nowLocal),
    ticketCount: (b.Tickets ?? []).filter((t: any) => t.Status !== "refunded").length,
    tickets: (b.Tickets ?? []).map((t: any) => ({
      id: t.Id,
      description: t.Description,
      seat: t.SeatRowId ? `${t.SeatRowId}${t.SeatNumber}` : "",
      priceCents: t.FinalPriceCents,
      status: t.Status,
    })),
    seats,
    concessions: (b.Concessions ?? []).map((c: any) => ({
      id: c.Id,
      description: c.Description,
      quantity: c.Quantity,
      priceCents: c.FinalPriceCents,
    })),
    totalCents: b.TotalValueCents,
    total: money(b.TotalValueCents, lang),
    refundedCents: b.RefundedValueCents ?? 0,
    payment: (b.PaymentInfoCollection ?? [])
      .map((p: any) => (p.CardNumber ? `${p.CardType} ${p.CardNumber}` : p.PaymentTenderCategory))
      .join(", "),
    customer: {
      name: `${b.Customer?.FirstName ?? ""} ${b.Customer?.LastName ?? ""}`.trim(),
      emailMasked: maskEmail(b.Customer?.Email ?? ""),
      phoneMasked: mask(b.Customer?.Phone ?? ""),
      isMember: !!b.Customer?.MemberId,
    },
    qrPayload: b.QrPayload,
    bookedAt: b.BookedAtUtc,
    offers: b.AppliedOffers ?? [],
    collected: !!b.TicketsCollected,
    refunds: b.Refunds ?? [],
  };
}

/** Guest identity verification: logged-in owner, or last-4 phone / email match. */
export function verifyOwnership(
  ctx: ToolCtx,
  b: VistaBooking,
  verification?: { phoneLast4?: string; email?: string },
): { ok: true } | { ok: false; message: string } {
  if (ctx.conversation.customerId && b.Customer?.ID === ctx.conversation.customerId) return { ok: true };
  if (ctx.conversation.memberId && b.Customer?.MemberId === ctx.conversation.memberId) return { ok: true };
  const phone = String(b.Customer?.Phone ?? "").replace(/\D/g, "");
  if (verification?.phoneLast4 && phone.endsWith(verification.phoneLast4)) return { ok: true };
  if (
    verification?.email &&
    String(b.Customer?.Email ?? "").toLowerCase() === verification.email.toLowerCase()
  )
    return { ok: true };
  return {
    ok: false,
    message: t(
      ctx.lang,
      `To protect this booking, please confirm the last four digits of the phone number on it (ending ${mask(phone, 2)}) or the email address used.`,
      "لحماية هذا الحجز، يرجى تأكيد آخر أربعة أرقام من رقم الهاتف المسجل أو البريد الإلكتروني المستخدم.",
    ),
  };
}

async function loadBooking(ctx: ToolCtx, bookingId: string): Promise<VistaBooking | null> {
  try {
    return (await ctx.vista.getBooking(bookingId)).Booking;
  } catch (e) {
    if (e instanceof VistaClientError && e.kind === "result") return null;
    throw e;
  }
}

async function cinemaName(ctx: ToolCtx, id: string) {
  const c = await ctx.catalog.cinema(id);
  return c ? (ctx.lang === "ar" ? c.nameAlt || c.name : c.name) : id;
}

function eligibilitySpeech(ctx: ToolCtx, b: VistaBooking, e: ReturnType<typeof evaluateCancellation>) {
  if (!e.eligible) return e.reasons[0]!;
  const methods = e.refundMethods.map((m) =>
    m.method === "VOX_CREDIT"
      ? t(
          ctx.lang,
          `${money(m.amountCents, ctx.lang)} as VOX credit`,
          `${money(m.amountCents, "ar")} كرصيد فوكس`,
        )
      : m.method === "SHARE_POINTS"
        ? t(ctx.lang, `${m.points} Share Points`, `${m.points} نقطة شير`)
        : t(
            ctx.lang,
            `${money(m.amountCents, ctx.lang)} back to the original card`,
            `${money(m.amountCents, "ar")} إلى البطاقة الأصلية`,
          ),
  );
  return t(
    ctx.lang,
    `Good news — ${b.FilmTitle} ${onDateTime(b.Showtime, "en", ctx.nowLocal)} can be cancelled. You'd get ${methods.join(" or ")}. ${e.notes.join(" ")}`,
    `خبر جيد — يمكن إلغاء حجز ${b.FilmTitle} في ${fmtDateTime(b.Showtime, "ar", ctx.nowLocal)}. ستسترد ${methods.join(" أو ")}. ${e.notes.join(" ")}`,
  );
}

export const bookingTools: Pick<
  ToolHandlers,
  | "find_booking"
  | "check_cancellation_eligibility"
  | "prepare_cancellation"
  | "cancel_booking"
  | "prepare_swap"
  | "swap_booking"
  | "list_my_bookings"
> = {
  async find_booking(ctx, input) {
    const customerId =
      input.customerId ??
      (input.bookingId || input.email || input.phone || input.memberId
        ? undefined
        : (ctx.conversation.customerId ?? undefined));
    let bookings: VistaBooking[];
    try {
      bookings = (
        await ctx.vista.searchBookings({
          BookingId: input.bookingId,
          Email: input.email,
          Phone: input.phone,
          MemberId: input.memberId,
          CustomerId: customerId,
          UpcomingOnly: input.upcomingOnly,
          Limit: 10,
        })
      ).Bookings;
    } catch (e) {
      if (e instanceof VistaClientError && e.kind === "result") bookings = [];
      else throw e;
    }
    if (!bookings.length) {
      return ok(
        { bookings: [] },
        t(
          ctx.lang,
          input.bookingId
            ? `I couldn't find a booking with reference ${input.bookingId.toUpperCase()}. Could you double-check it, or give me the email or phone number used for the booking?`
            : "I couldn't find any upcoming bookings for those details. You can also give me the booking reference from your confirmation email.",
          input.bookingId
            ? `لم أجد حجزاً بالرقم المرجعي ${input.bookingId.toUpperCase()}. هل يمكنك التحقق منه أو إعطائي البريد الإلكتروني أو رقم الهاتف؟`
            : "لم أجد حجوزات قادمة بهذه البيانات. يمكنك إعطائي الرقم المرجعي من بريد التأكيد.",
        ),
        undefined,
        { name: "booking_lookup", status: "failed" },
      );
    }
    const cards = await Promise.all(
      bookings.map(async (b) => bookingCard(b, ctx.lang, ctx.nowLocal, await cinemaName(ctx, b.CinemaId))),
    );
    const withElig = bookings.map((b, i) => ({
      ...cards[i]!,
      eligibility: evaluateCancellation(toSnapshot(b), ctx.nowLocal, undefined, ctx.cfg.policy),
      verified: verifyOwnership(ctx, b).ok,
    }));
    const first = withElig[0]!;
    const firstRaw = bookings[0] as VistaBooking & { SwappedToBookingId?: string | null };
    const inactive =
      first.status === "swapped"
        ? t(
            ctx.lang,
            `Booking ${first.bookingId} (${first.filmTitle}, ${first.showtimeLabel}) was swapped${firstRaw.SwappedToBookingId ? ` to booking ${firstRaw.SwappedToBookingId}` : ""}, so it is no longer valid on its own. Would you like me to look up the new booking?`,
            `الحجز ${first.bookingId} (${first.filmTitle}، ${first.showtimeLabel}) تم استبداله${firstRaw.SwappedToBookingId ? ` بالحجز ${firstRaw.SwappedToBookingId}` : ""}، فهو لم يعد صالحاً بمفرده. هل تريد أن أبحث عن الحجز الجديد؟`,
          )
        : first.status === "cancelled" || first.status === "refunded"
          ? t(
              ctx.lang,
              `Booking ${first.bookingId} for ${first.filmTitle} has already been ${first.status}. Recorded refund: ${money(first.refundedCents, ctx.lang)}. ${firstRaw.Refunds?.length ? firstRaw.Refunds.map((r: any) => `${r.Method}: ${money(r.AmountCents, ctx.lang)}, ${r.Status}${r.Method === "ORIGINAL_PAYMENT" ? ", 5–10 days to the same original card" : r.Method === "VOX_CREDIT" ? ", wallet credit valid for 90 days" : ""}`).join("; ") : "The refund destination is not present in this record; Customer Care can verify it."}`,
              `تم إلغاء الحجز ${first.bookingId} بالفعل. مبلغ الاسترداد المسجل ${money(first.refundedCents, "ar")}. تفاصيل الاسترداد المتاحة معروضة على الشاشة.`,
            )
          : null;
    const speech =
      bookings.length === 1
        ? (inactive ??
          t(
            ctx.lang,
            `I found it: ${first.ticketCount} ticket${first.ticketCount === 1 ? "" : "s"} for ${first.filmTitle} at ${first.cinemaName}, ${first.showtimeLabel}, ${first.experience}${first.seats ? `, seats ${first.seats}` : ""}. Status: ${first.status}. What would you like to do with it?`,
            `وجدته: ${first.ticketCount} تذكرة لفيلم ${first.filmTitle} في ${first.cinemaName}، ${first.showtimeLabel}، ${first.experience}${first.seats ? `، المقاعد ${first.seats}` : ""}. الحالة: ${first.status}. ماذا تريد أن تفعل؟`,
          ))
        : t(
            ctx.lang,
            `I found ${bookings.length} bookings: ${withElig
              .slice(0, 3)
              .map((b) => `${b.filmTitle} ${b.showtimeLabel} (${b.bookingId})`)
              .join("; ")}. Which one?`,
            `وجدت ${bookings.length} حجوزات: ${withElig
              .slice(0, 3)
              .map((b) => `${b.filmTitle} ${b.showtimeLabel} (${b.bookingId})`)
              .join("؛ ")}. أيها؟`,
          );
    return ok(
      { bookings: withElig },
      speech,
      {
        type: "booking",
        title: t(ctx.lang, "Your bookings", "حجوزاتك"),
        items: withElig,
        actions: withElig
          .slice(0, 3)
          .map((b) => ({ label: `${b.filmTitle} · ${b.showtimeLabel}`, value: `booking:${b.bookingId}` })),
      },
      { name: "booking_lookup", status: "completed" },
    );
  },

  async list_my_bookings(ctx, input) {
    const customerId = input.customerId ?? ctx.conversation.customerId;
    if (!customerId)
      return err(
        ErrorCodes.LOGIN_REQUIRED,
        t(
          ctx.lang,
          "Please log in first, or give me your booking reference, email or phone number.",
          "يرجى تسجيل الدخول أولاً أو إعطائي الرقم المرجعي أو البريد الإلكتروني أو رقم الهاتف.",
        ),
      );
    return bookingTools.find_booking(ctx, { customerId, upcomingOnly: !input.includePast });
  },

  async check_cancellation_eligibility(ctx, input) {
    const b = await loadBooking(ctx, input.bookingId);
    if (!b)
      return err(
        ErrorCodes.BOOKING_NOT_FOUND,
        t(
          ctx.lang,
          `I couldn't find booking ${input.bookingId.toUpperCase()}.`,
          `لم أجد الحجز ${input.bookingId.toUpperCase()}.`,
        ),
      );
    const e = evaluateCancellation(toSnapshot(b), ctx.nowLocal, input.ticketIds, ctx.cfg.policy);
    const card = bookingCard(b, ctx.lang, ctx.nowLocal, await cinemaName(ctx, b.CinemaId));
    return ok(
      { booking: card, eligibility: e },
      eligibilitySpeech(ctx, b, e),
      {
        type: "booking",
        items: [{ ...card, eligibility: e }],
        actions: e.eligible
          ? [
              {
                label: t(ctx.lang, "Cancel & refund", "إلغاء واسترداد"),
                value: `cancel:${b.VistaBookingId}`,
                style: "danger",
              },
              { label: t(ctx.lang, "Swap showtime", "تبديل الموعد"), value: `swap:${b.VistaBookingId}` },
            ]
          : [],
      },
      { name: "cancellation", status: e.eligible ? "started" : "failed" },
    );
  },

  async prepare_cancellation(ctx, input) {
    const b = await loadBooking(ctx, input.bookingId);
    if (!b)
      return err(
        ErrorCodes.BOOKING_NOT_FOUND,
        t(
          ctx.lang,
          `I couldn't find booking ${input.bookingId.toUpperCase()}.`,
          `لم أجد الحجز ${input.bookingId.toUpperCase()}.`,
        ),
      );
    if (ctx.refundChoiceProof) {
      try {
        await verifyRefundChoice(ctx, ctx.refundChoiceProof, {
          bookingId: b.VistaBookingId,
          bookingVersion: b.Version,
          ticketIds: input.ticketIds,
        });
      } catch (error) {
        if (error instanceof DomainError) return err(error.code, error.message);
        throw error;
      }
    }
    const v = ctx.refundChoiceProof ? { ok: true as const } : verifyOwnership(ctx, b, input.verification);
    if (!v.ok) return err("VERIFICATION_REQUIRED", v.message);
    const e = evaluateCancellation(toSnapshot(b), ctx.nowLocal, input.ticketIds, ctx.cfg.policy);
    if (!e.eligible)
      return err(
        ErrorCodes[e.code as keyof typeof ErrorCodes] ?? ErrorCodes.BOOKING_NOT_ELIGIBLE,
        e.reasons[0]!,
        false,
        { eligibility: e },
      );
    const method = e.refundMethods.find((m) => m.method === input.refundMethod);
    if (!method)
      return ok(
        {
          needs: "refund_method",
          bookingId: b.VistaBookingId,
          refundMethods: e.refundMethods,
          requestedMethodAllowed: !input.refundMethod,
          eligibility: e,
        },
        t(
          ctx.lang,
          `${input.refundMethod ? "That refund destination is not available for this payment. " : ""}Your refund is ${money(e.amounts.totalCents, ctx.lang)}. Choose ${e.refundMethods.map((m) => (m.method === "VOX_CREDIT" ? "VOX wallet credit, valid for 90 days" : m.method === "ORIGINAL_PAYMENT" ? `the same original card${m.cardLast4 ? ` ending ${m.cardLast4}` : ""}, in 5–10 days` : "SHARE Points")).join(" or ")}.`,
          `مبلغ الاسترداد ${money(e.amounts.totalCents, "ar")}. اختر طريقة الاسترداد المتاحة على الشاشة؛ رصيد فوكس صالح90يوماً والاسترداد إلى البطاقة الأصلية خلال5–10أيام.`,
        ),
        {
          type: "refund_options",
          items: e.refundMethods,
          meta: {
            bookingId: b.VistaBookingId,
            ticketIds: input.ticketIds,
            refundChoiceProof: signRefundChoice(ctx, {
              bookingId: b.VistaBookingId,
              bookingVersion: b.Version,
              ticketIds: input.ticketIds,
            }),
          },
          actions: e.refundMethods.map((m) => ({
            label:
              m.method === "VOX_CREDIT"
                ? "VOX wallet credit"
                : m.method === "ORIGINAL_PAYMENT"
                  ? "Same original card"
                  : "SHARE Points",
            value: `refund:${b.VistaBookingId}:${m.method}`,
          })),
        },
      );
    const partial =
      e.refundableTicketIds.length < toSnapshot(b).tickets.filter((x) => x.Status === "valid").length;
    const summary = {
      bookingId: b.VistaBookingId,
      filmTitle: b.FilmTitle,
      showtime: b.Showtime,
      cinemaId: b.CinemaId,
      ticketIds: e.refundableTicketIds,
      partial,
      refundMethod: method.method,
      amountCents: method.amountCents,
      points: method.points,
      eta: method.eta,
      reason: input.reason ?? "",
      expectedVersion: b.Version,
      cardLast4: method.cardLast4,
      validityDays: method.validityDays,
    };
    const refundText =
      method.method === "VOX_CREDIT"
        ? t(
            ctx.lang,
            `${money(method.amountCents, ctx.lang)} as VOX credit to your wallet (valid 90 days, usable on tickets and food)`,
            `${money(method.amountCents, "ar")} كرصيد فوكس في محفظتك (صالح 90 يوماً)`,
          )
        : method.method === "SHARE_POINTS"
          ? t(ctx.lang, `${method.points} Share Points`, `${method.points} نقطة شير`)
          : t(
              ctx.lang,
              `${money(method.amountCents, ctx.lang)} to the same original card${method.cardLast4 ? ` ending ${method.cardLast4}` : ""} within 5–10 days`,
              `${money(method.amountCents, "ar")} إلى البطاقة الأصلية نفسها خلال 5–10 أيام`,
            );
    const spoken = t(
      ctx.lang,
      `To confirm: I'll cancel ${partial ? `${e.refundableTicketIds.length} of your tickets` : "your booking"} ${b.VistaBookingId} for ${b.FilmTitle} ${onDateTime(b.Showtime, "en", ctx.nowLocal)} at ${await cinemaName(ctx, b.CinemaId)}, and refund ${refundText}. This can't be undone. Shall I go ahead?`,
      `للتأكيد: سألغي ${partial ? `${e.refundableTicketIds.length} من تذاكرك` : "حجزك"} ${b.VistaBookingId} لفيلم ${b.FilmTitle} في ${fmtDateTime(b.Showtime, "ar", ctx.nowLocal)} في ${await cinemaName(ctx, b.CinemaId)}، وأسترد ${refundText}. لا يمكن التراجع عن ذلك. هل أتابع؟`,
    );
    const conf = await createConfirmation(ctx.db, {
      conversationId: ctx.conversation.id,
      actionType: "cancel_booking",
      resourceKey: `booking:${b.VistaBookingId}`,
      summary,
      spokenSummary: spoken,
      ttlSeconds: ctx.cfg.confirmationTtlSeconds,
    });
    return ok(
      { confirmationId: conf.id, summary, expiresInSeconds: ctx.cfg.confirmationTtlSeconds },
      spoken,
      {
        type: "booking",
        title: t(ctx.lang, "Confirm cancellation", "تأكيد الإلغاء"),
        items: [
          {
            ...bookingCard(b, ctx.lang, ctx.nowLocal),
            refund: {
              method: method.method,
              amountCents: method.amountCents,
              points: method.points,
              eta: method.eta,
              cardLast4: method.cardLast4,
              validityDays: method.validityDays,
            },
          },
        ],
        actions: [
          { label: t(ctx.lang, "Yes, cancel", "نعم، ألغِ"), value: `confirm:${conf.id}`, style: "danger" },
          { label: t(ctx.lang, "Keep booking", "احتفظ بالحجز"), value: "abort", style: "secondary" },
        ],
        meta: { confirmationId: conf.id },
      },
    );
  },

  async cancel_booking(ctx, input) {
    let conf: Awaited<ReturnType<typeof consumeConfirmation>>;
    try {
      conf = await consumeConfirmation(ctx.db, {
        id: input.confirmationId,
        conversationId: ctx.conversation.id,
        actionType: "cancel_booking",
        resourceKey: `booking:${input.bookingId.toUpperCase()}`,
      });
    } catch (e) {
      // the same confirmation submitted twice (barge-in / retry): report the action already in flight instead of failing
      const existing = await findByKey(
        ctx.db,
        idem(ctx.conversation.id, input.idempotencyKey ?? `cancel:${input.confirmationId}`),
      );
      if (existing)
        return ok({ action: toRef(existing), created: false }, actionSpeech(ctx, existing.status));
      if (
        (e as { code?: string }).code === ErrorCodes.CONFIRMATION_REQUIRED &&
        /already used/.test((e as Error).message)
      )
        return ok({ inProgress: true }, actionSpeech(ctx, "running"));
      return err((e as { code?: string }).code ?? ErrorCodes.CONFIRMATION_REQUIRED, (e as Error).message);
    }
    const { action, created } = await enqueue(ctx.db, ctx.events, {
      conversationId: ctx.conversation.id,
      type: "cancel_booking",
      resourceKey: `booking:${input.bookingId.toUpperCase()}`,
      idempotencyKey: idem(ctx.conversation.id, input.idempotencyKey ?? `cancel:${input.confirmationId}`),
      payload: { ...conf.summary, confirmationId: conf.id },
      toolCallId: ctx.toolCallId,
      correlationId: ctx.correlationId,
    });
    return ok(
      { action: toRef(action), created },
      t(
        ctx.lang,
        "Done — I'm cancelling that now. Give me a moment and I'll confirm the refund.",
        "تم — أقوم بالإلغاء الآن. لحظة وسأؤكد الاسترداد.",
      ),
      undefined,
      { name: "cancellation", status: "started" },
    );
  },

  prepare_swap: prepareSwap,

  async swap_booking(ctx, input) {
    let conf: Awaited<ReturnType<typeof consumeConfirmation>>;
    try {
      conf = await consumeConfirmation(ctx.db, {
        id: input.confirmationId,
        conversationId: ctx.conversation.id,
        actionType: "swap_booking",
        resourceKey: `booking:${input.bookingId.toUpperCase()}`,
      });
    } catch (e) {
      const existing = await findByKey(
        ctx.db,
        idem(ctx.conversation.id, input.idempotencyKey ?? `swap:${input.confirmationId}`),
      );
      if (existing)
        return ok({ action: toRef(existing), created: false }, actionSpeech(ctx, existing.status));
      if (
        (e as { code?: string }).code === ErrorCodes.CONFIRMATION_REQUIRED &&
        /already used/.test((e as Error).message)
      )
        return ok({ inProgress: true }, actionSpeech(ctx, "running"));
      return err((e as { code?: string }).code ?? ErrorCodes.CONFIRMATION_REQUIRED, (e as Error).message);
    }
    const { action, created } = await enqueue(ctx.db, ctx.events, {
      conversationId: ctx.conversation.id,
      type: "swap_booking",
      resourceKey: `booking:${input.bookingId.toUpperCase()}`,
      idempotencyKey: idem(ctx.conversation.id, input.idempotencyKey ?? `swap:${input.confirmationId}`),
      payload: { ...conf.summary, confirmationId: conf.id },
      toolCallId: ctx.toolCallId,
      correlationId: ctx.correlationId,
    });
    return ok(
      { action: toRef(action), created },
      t(
        ctx.lang,
        "On it — I'm booking the new showtime and releasing the old one. One moment.",
        "جارٍ التنفيذ — أحجز الموعد الجديد وأحرر القديم. لحظة.",
      ),
      undefined,
      { name: "swap", status: "started" },
    );
  },
};

export function actionSpeech(ctx: ToolCtx, status: string): string {
  switch (status) {
    case "queued":
    case "running":
      return t(ctx.lang, "That's already in progress — one moment.", "هذا قيد التنفيذ بالفعل — لحظة.");
    case "succeeded":
      return t(ctx.lang, "That was already completed.", "تم إنجاز ذلك بالفعل.");
    default:
      return t(
        ctx.lang,
        "That request didn't go through earlier. Let me check and try again.",
        "لم يُنفذ الطلب سابقاً. دعني أتحقق وأحاول مجدداً.",
      );
  }
}

export type { ToolResult };
