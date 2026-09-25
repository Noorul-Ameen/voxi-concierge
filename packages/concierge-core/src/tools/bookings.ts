import { DomainError, ErrorCodes } from "@voxi/contracts";
import { type BookingSnapshot, evaluateCancellation, evaluateSwap } from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { enqueue, findByKey, idem, toRef } from "../actions/ledger.js";
import { consumeConfirmation, createConfirmation, getConfirmation } from "../services/confirmations.js";
import { updateConversation } from "../services/conversation.js";
import { fmtDateTime, joinList, money, onDateTime, seatLabels, t } from "../services/format.js";
import { signRefundChoice, verifyRefundChoice } from "../services/refund-choice-proof.js";
import { assertSwapRefundSelection } from "../services/swap-refund.js";
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
  // Bookings paid in this conversation, or already verified in it, need no second identity check.
  const meta = (ctx.conversation.metadata ?? {}) as Record<string, unknown>;
  const verified = Array.isArray(meta.verifiedBookings) ? (meta.verifiedBookings as string[]) : [];
  if (
    b.VistaBookingId &&
    (verified.includes(b.VistaBookingId) ||
      meta.lastBookingId === b.VistaBookingId ||
      meta.lastFnbBookingId === b.VistaBookingId)
  )
    return { ok: true };
  const phone = String(b.Customer?.Phone ?? "").replace(/\D/g, "");
  const last4 = String(verification?.phoneLast4 ?? "").replace(/\D/g, "");
  if (last4.length >= 4 && phone.endsWith(last4.slice(-4))) return { ok: true };
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

/** Ownership check that remembers a successful guest verification for the rest of this conversation. */
export async function checkOwner(
  ctx: ToolCtx,
  b: VistaBooking,
  verification?: { phoneLast4?: string; email?: string },
) {
  const result = verifyOwnership(ctx, b, verification);
  if (result.ok && (verification?.email || verification?.phoneLast4))
    await rememberVerified(ctx, b.VistaBookingId);
  return result;
}

async function rememberVerified(ctx: ToolCtx, bookingId: string) {
  const meta = (ctx.conversation.metadata ?? {}) as Record<string, unknown>;
  const list = Array.isArray(meta.verifiedBookings) ? (meta.verifiedBookings as string[]) : [];
  if (list.includes(bookingId)) return;
  const next = { ...meta, verifiedBookings: [...list.slice(-19), bookingId] };
  ctx.conversation.metadata = next as typeof ctx.conversation.metadata;
  // Best effort: a failed save only means the guest is asked to verify again later.
  if (ctx.db)
    await updateConversation(ctx.db, ctx.conversation.id, { metadata: next }).catch(() => undefined);
}

async function loadBooking(ctx: ToolCtx, bookingId: string): Promise<VistaBooking | null> {
  try {
    return (await ctx.vista.getBooking(bookingId)).Booking;
  } catch (e) {
    if (e instanceof VistaClientError && e.kind === "result") return null;
    throw e;
  }
}

/** Compact header for refund/swap cards: film art, show, seats and whether it is a guest booking. */
export async function refundHeader(ctx: ToolCtx, b: VistaBooking) {
  // Artwork is decoration: a missing film or catalogue must never block the refund step.
  const film = b.ScheduledFilmId
    ? await Promise.resolve()
        .then(() => ctx.catalog.film(b.ScheduledFilmId))
        .catch(() => null)
    : null;
  return {
    bookingId: b.VistaBookingId,
    filmTitle: ctx.lang === "ar" && b.AltFilmTitle ? b.AltFilmTitle : b.FilmTitle,
    showtimeLabel: fmtDateTime(b.Showtime, ctx.lang, ctx.nowLocal),
    experience: b.Experience,
    seats: seatLabels(b.Tickets ?? []),
    posterUrl: film?.posterUrl || undefined,
    guest: !b.Customer?.MemberId,
  };
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
  | "resend_ticket"
  | "link_booking"
> = {
  /**
   * Guest booking → signed-in account, so the refund can go to VOX Credit. Ownership is proven by the sign-in plus
   * the booking's email or phone matching the account; the same 30-minute cut-off as refunds applies.
   * On a mismatch nothing changes and the refund stays on the original payment method.
   */
  async link_booking(ctx, input) {
    const bookingRef = input.bookingId.toUpperCase();
    if (!ctx.conversation.isLoggedIn || !ctx.conversation.customerId)
      return err(
        ErrorCodes.LOGIN_REQUIRED,
        t(
          ctx.lang,
          `Please sign in first, then I can link booking ${bookingRef} to your account.`,
          `يرجى تسجيل الدخول أولاً، ثم أربط الحجز ${bookingRef} بحسابك.`,
        ),
        false,
        { needs: "login", bookingId: input.bookingId },
      );
    const b = await loadBooking(ctx, input.bookingId);
    if (!b)
      return err(
        ErrorCodes.BOOKING_NOT_FOUND,
        t(ctx.lang, `I couldn't find booking ${bookingRef}.`, `لم أجد الحجز ${bookingRef}.`),
      );
    let account: Record<string, any>;
    try {
      account = await ctx.vista.customer(ctx.conversation.customerId);
    } catch (e) {
      if (e instanceof VistaClientError && e.status === 404)
        return err(
          ErrorCodes.LOGIN_REQUIRED,
          t(ctx.lang, "Please sign in again.", "يرجى تسجيل الدخول مجدداً."),
          false,
          {
            needs: "login",
          },
        );
      throw e;
    }
    const memberId = String(account.memberId ?? "");
    const resumeRefund = async (proofCtx: ToolCtx) => {
      const r = input.resume;
      if (!r) return null;
      return r.kind === "swap"
        ? bookingTools.prepare_swap(proofCtx, {
            bookingId: b.VistaBookingId,
            targetSessionKey: r.targetSessionKey,
            keepSeatsIfPossible: r.keepSeatsIfPossible ?? true,
            ...(r.seats?.length ? { seats: r.seats } : {}),
          })
        : bookingTools.prepare_cancellation(proofCtx, {
            bookingId: b.VistaBookingId,
            ticketIds: r.ticketIds,
          });
    };
    const refuse = async (reason: string, speech: string) => {
      // Nothing changed: reopen the guest refund (original payment) when the widget proved ownership of this review.
      const next = ctx.refundChoiceProof ? await resumeRefund(ctx) : null;
      return ok(
        { linked: false, reason, bookingId: b.VistaBookingId, next: next?.data ?? null },
        next?.speech ? `${speech} ${next.speech}` : speech,
        next?.ui,
        { name: "link_booking", status: "failed" },
      );
    };
    if (b.Customer?.MemberId && memberId && b.Customer.MemberId === memberId) {
      const next = await resumeRefund({ ...ctx, refundChoiceProof: undefined });
      const already = t(
        ctx.lang,
        `Booking ${bookingRef} is already on your account.`,
        `الحجز ${bookingRef} مرتبط بحسابك بالفعل.`,
      );
      return ok(
        { linked: true, alreadyLinked: true, bookingId: b.VistaBookingId, next: next?.data ?? null },
        next?.speech ? `${already} ${next.speech}` : already,
        next?.ui,
        { name: "link_booking", status: "completed" },
      );
    }
    if (b.Customer?.MemberId)
      return refuse(
        "linked_elsewhere",
        t(
          ctx.lang,
          `Booking ${bookingRef} is already on another VOX account, so I can't move it.`,
          `الحجز ${bookingRef} مرتبط بحساب VOX آخر، فلا يمكنني نقله.`,
        ),
      );
    if (!memberId)
      return refuse(
        "no_wallet",
        t(
          ctx.lang,
          "Your account doesn't have a VOX Wallet yet, so the refund stays on the original payment method.",
          "حسابك لا يملك محفظة VOX بعد، لذا يبقى الاسترداد على وسيلة الدفع الأصلية.",
        ),
      );
    const digits = (v: unknown) =>
      String(v ?? "")
        .replace(/\D/g, "")
        .slice(-9);
    const emailMatch =
      !!account.email &&
      String(account.email).toLowerCase() === String(b.Customer?.Email ?? "").toLowerCase();
    const phoneMatch =
      digits(account.phone).length >= 7 && digits(account.phone) === digits(b.Customer?.Phone);
    if (!emailMatch && !phoneMatch)
      return refuse(
        "contact_mismatch",
        t(
          ctx.lang,
          `The email and phone on booking ${bookingRef} don't match your account, so I can't link it. The refund goes back to the original payment method.`,
          `البريد الإلكتروني والهاتف على الحجز ${bookingRef} لا يطابقان حسابك، فلا يمكنني ربطه. يعود الاسترداد إلى وسيلة الدفع الأصلية.`,
        ),
      );
    // Judge the booking as it would be once linked, so the cut-off / bank-offer / third-party rules decide, not the payment mix.
    const e = evaluateCancellation(
      { ...toSnapshot(b), hasMember: true },
      ctx.nowLocal,
      undefined,
      ctx.cfg.policy,
    );
    if (!e.eligible)
      return refuse(
        e.code === "CUTOFF_PASSED" ? "cutoff" : "not_eligible",
        t(ctx.lang, `I can't link it now: ${e.reasons[0]}`, `لا يمكنني ربطه الآن: ${e.reasons[0]}`),
      );
    try {
      await ctx.vista.linkBookingToMember({
        BookingId: b.VistaBookingId,
        CustomerId: ctx.conversation.customerId,
        ExpectedVersion: b.Version,
      });
    } catch (error) {
      if (error instanceof VistaClientError && error.kind === "result")
        return err(
          ErrorCodes.CONFLICT,
          t(
            ctx.lang,
            "That booking changed while I was linking it. Nothing was moved; please try again.",
            "تغيّر الحجز أثناء الربط. لم يتغير شيء؛ يرجى المحاولة مجدداً.",
          ),
          true,
        );
      throw error;
    }
    // The account now owns the booking, so the refund review reopens without the (now stale) widget proof.
    const next = await resumeRefund({ ...ctx, refundChoiceProof: undefined });
    const done = t(
      ctx.lang,
      `Done — booking ${bookingRef} is now on your account, so VOX Credit is available.`,
      `تم — الحجز ${bookingRef} أصبح على حسابك، فأصبح رصيد VOX متاحاً.`,
    );
    return ok(
      { linked: true, bookingId: b.VistaBookingId, next: next?.data ?? null },
      next?.speech ? `${done} ${next.speech}` : done,
      next?.ui ?? {
        type: "booking",
        items: [
          bookingCard(
            (await loadBooking(ctx, b.VistaBookingId)) ?? b,
            ctx.lang,
            ctx.nowLocal,
            await cinemaName(ctx, b.CinemaId),
          ),
        ],
      },
      { name: "link_booking", status: "completed" },
    );
  },
  /** Brief gap: "was my ticket emailed?" — resend the e-ticket and report the delivery record. */
  async resend_ticket(ctx, input) {
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
    const owner = await checkOwner(ctx, b, input.verification);
    if (!owner.ok) return err("VERIFICATION_REQUIRED", owner.message, false, { needs: "verification" });
    if (!["confirmed", "collected", "partially_refunded", "swapped"].includes(String(b.Status)))
      return err(
        ErrorCodes.BOOKING_NOT_ELIGIBLE,
        t(
          ctx.lang,
          "That booking isn't active, so there's no ticket to resend.",
          "هذا الحجز غير نشط، فلا توجد تذكرة لإعادة إرسالها.",
        ),
      );
    const channel = input.channel ?? "email";
    const email = String(b.Customer?.Email ?? "");
    const phone = String(b.Customer?.Phone ?? "").replace(/\D/g, "");
    const to = channel === "email" ? maskEmail(email) : mask(phone, 4);
    if (!(channel === "email" ? email : phone))
      return err(
        ErrorCodes.VALIDATION,
        t(
          ctx.lang,
          `There's no ${channel === "email" ? "email address" : "mobile number"} on this booking to send to.`,
          "لا توجد وسيلة اتصال مسجلة على هذا الحجز.",
        ),
      );
    const meta = (ctx.conversation.metadata ?? {}) as Record<string, any>;
    const log: { bookingId: string; channel: string; to: string; at: string }[] = Array.isArray(
      meta.ticketDeliveries,
    )
      ? meta.ticketDeliveries
      : [];
    const previous = [...log].reverse().find((d) => d.bookingId === b.VistaBookingId);
    const entry = { bookingId: b.VistaBookingId, channel, to, at: new Date().toISOString() };
    await updateConversation(ctx.db, ctx.conversation.id, {
      metadata: { ...meta, ticketDeliveries: [...log.slice(-19), entry] },
    });
    const when = fmtDateTime(ctx.nowLocal, ctx.lang, ctx.nowLocal);
    return ok(
      {
        bookingId: b.VistaBookingId,
        channel,
        to,
        sentAt: entry.at,
        previousDelivery: previous ?? null,
        bookedAt: b.BookingTime ?? null,
      },
      t(
        ctx.lang,
        `Done — I've resent your ${b.FilmTitle} ticket ${channel === "email" ? "to" : "by SMS to"} ${to} just now (${when}). It usually lands within a minute; worth checking spam or promotions if you don't see it. Your QR is on screen too.`,
        `تم — أعدت إرسال تذكرة ${b.FilmTitle} إلى ${to} الآن. تصل عادةً خلال دقيقة؛ تحقق من مجلد الرسائل غير المرغوبة إن لم تجدها. رمز QR على الشاشة أيضاً.`,
      ),
      { type: "qr", items: [bookingCard(b, ctx.lang, ctx.nowLocal, await cinemaName(ctx, b.CinemaId))] },
      { name: "booking_info", status: "completed" },
    );
  },
  async find_booking(ctx, input) {
    const ownLookup = !input.bookingId && !input.email && !input.phone && !input.memberId;
    const customerId = ownLookup ? (input.customerId ?? ctx.conversation.customerId ?? undefined) : undefined;
    const digits = (v?: string) => String(v ?? "").replace(/\D/g, "");
    const proof = {
      email: input.email?.trim() || undefined,
      phoneLast4: digits(input.phone).length >= 4 ? digits(input.phone).slice(-4) : undefined,
    };
    const hasProof = !!(proof.email || proof.phoneLast4);
    // Contact details alone are not enough to list someone's bookings: ask for the reference too.
    if (!input.bookingId && !ownLookup && !input.memberId && !(proof.email && proof.phoneLast4)) {
      return ok(
        { bookings: [], needs: "booking_reference" },
        t(
          ctx.lang,
          "To keep bookings private, could you give me the booking reference from your confirmation email too? Or sign in to see all your bookings.",
          "للحفاظ على خصوصية الحجوزات، هل يمكنك إعطائي الرقم المرجعي من بريد التأكيد أيضاً؟ أو سجّل الدخول لرؤية جميع حجوزاتك.",
        ),
        undefined,
        { name: "booking_lookup", status: "started" },
      );
    }
    let bookings: VistaBooking[];
    try {
      bookings = (
        await ctx.vista.searchBookings(
          input.bookingId
            ? { BookingId: input.bookingId, Limit: 10 }
            : {
                Email: proof.email,
                Phone: proof.email ? undefined : input.phone,
                MemberId: input.memberId,
                CustomerId: customerId,
                UpcomingOnly: input.upcomingOnly,
                Limit: 10,
              },
        )
      ).Bookings;
    } catch (e) {
      if (e instanceof VistaClientError && e.kind === "result") bookings = [];
      else throw e;
    }
    // Only bookings this person can prove are theirs are described.
    const mine: VistaBooking[] = [];
    let unverified: VistaBooking | undefined;
    for (const b of bookings) {
      const owner = input.bookingId
        ? await checkOwner(ctx, b, hasProof ? proof : undefined)
        : input.email && input.phone
          ? verifyOwnership(ctx, b, { phoneLast4: proof.phoneLast4 }).ok &&
            verifyOwnership(ctx, b, { email: proof.email }).ok
            ? { ok: true as const }
            : verifyOwnership(ctx, b)
          : verifyOwnership(ctx, b);
      if (owner.ok) mine.push(b);
      else unverified ??= b;
    }
    if (!mine.length && unverified && input.bookingId) {
      return ok(
        { bookings: [{ bookingId: unverified.VistaBookingId, verified: false }], needs: "verification" },
        hasProof
          ? t(
              ctx.lang,
              `Those details don't match booking ${unverified.VistaBookingId}. Could you check the email address, or the last four digits of the phone number, used for the booking?`,
              `هذه البيانات لا تطابق الحجز ${unverified.VistaBookingId}. هل يمكنك التحقق من البريد الإلكتروني أو آخر أربعة أرقام من رقم الهاتف المستخدم للحجز؟`,
            )
          : t(
              ctx.lang,
              `I have reference ${unverified.VistaBookingId}. To keep it private, what's the email address, or the last four digits of the phone number, used for the booking?`,
              `لدي الرقم المرجعي ${unverified.VistaBookingId}. للحفاظ على الخصوصية، ما البريد الإلكتروني أو آخر أربعة أرقام من رقم الهاتف المستخدم للحجز؟`,
            ),
        undefined,
        { name: "booking_lookup", status: "started" },
      );
    }
    bookings = mine;
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
      verified: true,
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
    const owner = await checkOwner(ctx, b, input.verification);
    if (!owner.ok) return err("VERIFICATION_REQUIRED", owner.message, false, { needs: "verification" });
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
    const v = ctx.refundChoiceProof ? { ok: true as const } : await checkOwner(ctx, b, input.verification);
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
          e.canLinkForCredit
            ? `${input.refundMethod ? "That refund destination is not available for this payment. " : ""}Your refund is ${money(e.amounts.totalCents, ctx.lang)}. As a guest booking it goes back to the original card${e.refundMethods[0]?.cardLast4 ? ` ending ${e.refundMethods[0].cardLast4}` : ""} in 5–10 days. If you sign in and link the booking to your VOX account, you can take VOX Credit instead, in your wallet within 30 minutes.`
            : e.recommendedMethod !== "VOX_CREDIT"
              ? `${input.refundMethod ? "That refund destination is not available for this payment. " : ""}Your refund is ${money(e.amounts.totalCents, ctx.lang)}. Choose ${e.refundMethods.map((m) => (m.method === "ORIGINAL_PAYMENT" ? `the same original card${m.cardLast4 ? ` ending ${m.cardLast4}` : ""}, in 5–10 days` : "SHARE Points")).join(" or ")}.`
              : e.refundMethods.every((m) => m.method === "VOX_CREDIT")
                ? `${input.refundMethod ? "That refund destination is not available for this payment. " : ""}Your refund is ${money(e.amounts.totalCents, ctx.lang)}, back to your VOX Credit, in your wallet within 30 minutes and valid for 90 days. Shall I go ahead?`
                : `${input.refundMethod ? "That refund destination is not available for this payment. " : ""}Your refund is ${money(e.amounts.totalCents, ctx.lang)}. I'd suggest VOX Credit: it's faster, in your wallet within 30 minutes and valid for 90 days. Or ${e.refundMethods
                    .filter((m) => m.method !== "VOX_CREDIT")
                    .map((m) =>
                      m.method === "ORIGINAL_PAYMENT"
                        ? `the same original card${m.cardLast4 ? ` ending ${m.cardLast4}` : ""}, in 5–10 days`
                        : "SHARE Points",
                    )
                    .join(" or ")}. Which would you like?`,
          e.canLinkForCredit
            ? `مبلغ الاسترداد ${money(e.amounts.totalCents, "ar")}. لأنه حجز ضيف يعود إلى البطاقة الأصلية خلال 5–10 أيام. إذا سجلت الدخول وربطت الحجز بحسابك يمكنك اختيار رصيد VOX خلال 30 دقيقة.`
            : e.refundMethods.every((m) => m.method === "VOX_CREDIT")
              ? `مبلغ الاسترداد ${money(e.amounts.totalCents, "ar")}، يعود إلى رصيد VOX في محفظتك خلال 30 دقيقة وصالح 90 يوماً. هل أتابع؟`
              : `مبلغ الاسترداد ${money(e.amounts.totalCents, "ar")}. أقترح رصيد VOX: أسرع، يصل إلى محفظتك خلال 30 دقيقة وصالح 90 يوماً، أو البطاقة الأصلية خلال 5–10 أيام. ماذا تفضّل؟`,
        ),
        {
          type: "refund_options",
          items: e.refundMethods,
          meta: {
            bookingId: b.VistaBookingId,
            ticketIds: input.ticketIds,
            recommendedMethod: e.recommendedMethod,
            canLinkForCredit: !!e.canLinkForCredit,
            signedIn: !!ctx.conversation.customerId,
            film: await refundHeader(ctx, b),
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
      const pending = await getConfirmation(ctx.db, input.confirmationId);
      if (
        pending?.conversationId === ctx.conversation.id &&
        pending.actionType === "swap_booking" &&
        pending.resourceKey === `booking:${input.bookingId.toUpperCase()}`
      )
        assertSwapRefundSelection(pending.summary);
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
