import type { Language } from "@voxi/contracts";
import { schema as S, nowLocalIso, prefixedId } from "@voxi/db";
import { centsToPoints } from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
/**
 * Executes ledger actions against the ports (Vista, handover, DB). Runs in the worker.
 * Every handler is idempotent at the external boundary (Vista references = action id) and records saga steps.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { appendEvent } from "../events.js";
import type { Catalog } from "../services/catalog.js";
import { markJourney, updateConversation } from "../services/conversation.js";
import { fmtDateTime, joinList, money, onDateTime, seatLabels, t } from "../services/format.js";
import { bookingCard, orderSummary, seatRange } from "../tools/index.js";
import { type ActionRow, complete, fail } from "./ledger.js";

/** "RF-7K2M9Q" style refund number derived from the Vista refund id (letters/digits that are easy to say). */
export function spokenRefundRef(id: string): string {
  const clean = id
    .replace(/^(rf_|act_)/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .replace(/[0O1IL]/g, "");
  return `RF-${(clean.slice(-6) || "000000").padStart(6, "7")}`;
}

type ExecCtx = AppContext & {
  catalog: Catalog;
  lang: Language;
  nowLocal: string;
  conversation: typeof S.conversations.$inferSelect;
};
type Outcome = {
  result: Record<string, unknown>;
  ui?: Record<string, unknown>;
  journey?: { name: string; status: "completed" | "abandoned" | "failed" };
};

class ActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public conflict = false,
    public detail?: unknown,
  ) {
    super(message);
  }
}

function fromVista(e: unknown): ActionError {
  if (e instanceof VistaClientError) {
    if (e.kind === "result") {
      const x = e.extendedResultCode ?? 0;
      const conflict = x === 54 || x === 101 || x === 52;
      const code =
        x === 52
          ? "SEATS_UNAVAILABLE"
          : x === 53
            ? "ORDER_EXPIRED"
            : x === 60
              ? "PAYMENT_DECLINED"
              : x === 80
                ? "OFFER_NOT_ELIGIBLE"
                : x === 81
                  ? "INSUFFICIENT_POINTS"
                  : x === 100
                    ? "BOOKING_NOT_FOUND"
                    : x === 101
                      ? "BOOKING_ALREADY_CANCELLED"
                      : x === 102
                        ? "BOOKING_NOT_ELIGIBLE"
                        : "VISTA_ERROR";
      return new ActionError(code, e.message, false, conflict, e.body);
    }
    return new ActionError(e.kind === "auth" ? "VISTA_ERROR" : "VISTA_UNAVAILABLE", e.message, e.retryable);
  }
  if (e instanceof ActionError) return e;
  return new ActionError("INTERNAL", (e as Error).message ?? String(e), false);
}

async function cname(ctx: ExecCtx, id: string) {
  const c = await ctx.catalog.cinema(id);
  return c ? (ctx.lang === "ar" ? c.nameAlt || c.name : c.name) : id;
}

const tenderFor = (method: string): "EWALLET" | "LOYALTY" | "CREDIT" =>
  method === "SHARE_POINTS" ? "LOYALTY" : method === "ORIGINAL_PAYMENT" ? "CREDIT" : "EWALLET";

const handlers: Record<string, (ctx: ExecCtx, a: ActionRow, steps: ActionRow["steps"]) => Promise<Outcome>> =
  {
    async cancel_booking(ctx, a) {
      const inp = a.input as {
        bookingId: string;
        ticketIds: string[];
        partial: boolean;
        refundMethod: string;
        amountCents: number;
        points?: number;
        eta: string;
        reason: string;
        expectedVersion?: number;
        filmTitle: string;
        showtime: string;
        cinemaId: string;
      };
      const r = await ctx.vista
        .refundBooking({
          BookingId: inp.bookingId,
          RefundTenderCategory: tenderFor(inp.refundMethod),
          TicketIds: inp.partial ? inp.ticketIds : undefined,
          Reason: inp.reason || "Customer cancellation via Voxi",
          Reference: a.id,
          InitiatedBy: "voxi",
          ConversationId: a.conversationId,
          ExpectedVersion: inp.expectedVersion,
        })
        .catch((e) => {
          throw fromVista(e);
        });
      const amount = r.Refund.AmountCents as number;
      // Customer-facing refund number: never read an internal id/idempotency key to the guest.
      const refundRef = spokenRefundRef(String(r.Refund.Id ?? r.Refund.Reference ?? a.id));
      const methodText =
        inp.refundMethod === "VOX_CREDIT"
          ? t(
              ctx.lang,
              `${money(amount, "en")} of VOX credit is in your wallet — it's valid for 90 days`,
              `${money(amount, "ar")} رصيد فوكس في محفظتك — صالح 90 يوماً`,
            )
          : inp.refundMethod === "SHARE_POINTS"
            ? t(
                ctx.lang,
                `${centsToPoints(amount)} Share Points (${money(amount, "en")}) have been added to your account`,
                `تمت إضافة ${centsToPoints(amount)} نقطة شير (${money(amount, "ar")}) إلى حسابك`,
              )
            : t(
                ctx.lang,
                `${money(amount, "en")} will reach your original payment method in 5–10 working days`,
                `سيصل ${money(amount, "ar")} إلى وسيلة الدفع الأصلية خلال 5–10 أيام عمل`,
              );
      const speech = t(
        ctx.lang,
        `All done. ${inp.partial ? `${inp.ticketIds.length} tickets on booking` : "Booking"} ${inp.bookingId} for ${inp.filmTitle} ${onDateTime(inp.showtime, "en", ctx.nowLocal)} ${inp.partial ? "have been" : "has been"} cancelled, and ${methodText}. Your refund number is ${refundRef}. A confirmation email is on its way.`,
        `تم بنجاح. ${inp.partial ? `${inp.ticketIds.length} تذاكر من الحجز` : "الحجز"} ${inp.bookingId} لفيلم ${inp.filmTitle} في ${fmtDateTime(inp.showtime, "ar", ctx.nowLocal)} تم إلغاؤه، و${methodText}. رقم الاسترداد ${refundRef}. سيصلك بريد تأكيد.`,
      );
      const card = {
        ...bookingCard(r.Booking, ctx.lang, ctx.nowLocal, await cname(ctx, inp.cinemaId)),
        refund: {
          reference: refundRef,
          amountCents: amount,
          method: inp.refundMethod,
          eta: inp.eta,
          idempotent: r.Idempotent,
        },
      };
      return {
        result: {
          speech,
          refund: {
            reference: refundRef,
            vistaReference: r.Refund.Reference,
            amountCents: amount,
            method: inp.refundMethod,
          },
          bookingStatus: r.Booking.Status,
        },
        ui: {
          type: "booking",
          title: t(ctx.lang, "Cancelled & refunded", "تم الإلغاء والاسترداد"),
          items: [card],
        },
        journey: { name: "cancellation", status: "completed" },
      };
    },

    async swap_booking(ctx, a, steps) {
      const inp = a.input as {
        bookingId: string;
        filmTitle: string;
        fromShowtime: string;
        targetCinemaId: string;
        targetSessionId: string;
        targetShowtime: string;
        targetExperience: string;
        tickets: { TicketTypeCode: string; Qty: number }[];
        ticketCount: number;
        differenceCents: number;
        paymentMethodForDifference: string;
        concessions?: { ItemId: string; Quantity: number; Description: string; Modifiers: string[] }[];
        customer: {
          FirstName: string;
          LastName: string;
          Email: string;
          Phone: string;
          MemberId?: string;
          ID?: string;
        };
        expectedVersion?: number;
      };
      const usid = `swap-${a.id}`;
      const step = (name: string, status: "done" | "failed" | "compensated", detail?: unknown) =>
        steps.push({ name, status, at: new Date().toISOString(), detail });
      // 1. hold seats on the new session
      let order: Record<string, any>;
      try {
        const r = await ctx.vista.addTickets({
          UserSessionId: usid,
          CinemaId: inp.targetCinemaId,
          SessionId: inp.targetSessionId,
          TicketTypes: inp.tickets,
          ConversationId: a.conversationId,
        });
        order = r.Order;
        step("hold_new_seats", "done", { seats: seatLabels(order.Sessions[0].Tickets) });
      } catch (e) {
        step("hold_new_seats", "failed");
        throw fromVista(e);
      }
      // 1b. carry the food & drinks over to the new order (best effort — the swap still goes ahead without them)
      let fnbCarried: string[] = [];
      let fnbDropped: string[] = [];
      if (inp.concessions?.length) {
        try {
          const r = await ctx.vista.addConcessions({
            UserSessionId: usid,
            CinemaId: inp.targetCinemaId,
            Concessions: inp.concessions.map((c) => ({
              ItemId: c.ItemId,
              Quantity: c.Quantity,
              Modifiers: c.Modifiers,
            })),
          });
          order = r.Order ?? order;
          fnbCarried = inp.concessions.map((c) => `${c.Quantity}× ${c.Description}`);
          step("carry_fnb", "done", { items: fnbCarried });
        } catch {
          fnbDropped = inp.concessions.map((c) => `${c.Quantity}× ${c.Description}`);
          step("carry_fnb", "failed", { items: fnbDropped });
        }
      }
      // 2. pay the new order (card on file simulated via token / wallet / points)
      const memberId = inp.customer.MemberId;
      const method = inp.paymentMethodForDifference;
      const tender =
        method === "VOX_CREDIT"
          ? { PaymentTenderCategory: "EWALLET", PaymentValueCents: order.TotalValueCents, MemberId: memberId }
          : method === "SHARE_POINTS"
            ? {
                PaymentTenderCategory: "LOYALTY",
                PaymentValueCents: order.TotalValueCents,
                PointsRedeemed: order.TotalValueCents,
                MemberId: memberId,
              }
            : {
                PaymentTenderCategory: "CREDIT",
                PaymentValueCents: order.TotalValueCents,
                PaymentToken: `tok_swap_${a.id}`,
                CardNumber: "4111111111111111",
              };
      let newBooking: Record<string, any>;
      try {
        const pay = await ctx.vista.completeOrder({
          UserSessionId: usid,
          CustomerEmail: inp.customer.Email,
          CustomerName: `${inp.customer.FirstName} ${inp.customer.LastName}`.trim(),
          CustomerPhone: inp.customer.Phone,
          PaymentInfoCollection: [tender],
          MemberId: memberId,
          CustomerId: inp.customer.ID ?? undefined,
          Source: "concierge-swap",
        });
        newBooking = pay.Booking!;
        step("pay_new_order", "done", { bookingId: pay.VistaBookingId });
      } catch (e) {
        step("pay_new_order", "failed");
        await ctx.vista.cancelOrder(usid).catch(() => undefined);
        step("hold_new_seats", "compensated");
        throw fromVista(e);
      }
      // 3. refund the original (to VOX credit for members, original card for guests)
      let refund: Record<string, any>;
      try {
        const r = await ctx.vista.refundBooking({
          BookingId: inp.bookingId,
          RefundTenderCategory: memberId ? "EWALLET" : "CREDIT",
          Reason: `Swapped to ${newBooking.VistaBookingId} via Voxi`,
          Reference: `${a.id}-refund`,
          InitiatedBy: "voxi",
          ConversationId: a.conversationId,
          ExpectedVersion: inp.expectedVersion,
        });
        refund = r.Refund;
        step("refund_original", "done", { reference: r.Refund.Reference, amountCents: r.Refund.AmountCents });
      } catch (e) {
        step("refund_original", "failed");
        // compensate: refund the new booking back to the tender used
        await ctx.vista
          .refundBooking({
            BookingId: newBooking.VistaBookingId,
            RefundTenderCategory:
              method === "VOX_CREDIT" ? "EWALLET" : method === "SHARE_POINTS" ? "LOYALTY" : "CREDIT",
            Reason: "Swap rollback",
            Reference: `${a.id}-rollback`,
          })
          .catch(() => undefined);
        step("pay_new_order", "compensated");
        throw fromVista(e);
      }
      await ctx.vista.linkSwappedBookings(inp.bookingId, newBooking.VistaBookingId).catch(() => undefined);
      step("link_bookings", "done");
      ctx.catalog.invalidateSessions(inp.targetCinemaId);
      const seats = seatLabels(newBooking.Tickets);
      const diffText =
        inp.differenceCents > 0
          ? t(
              ctx.lang,
              `The new tickets (${money(order.TotalValueCents, "en")}) were charged and ${money(refund.AmountCents, "en")} from the original booking went ${memberId ? "to your VOX credit" : "back to your card"}.`,
              `تم خصم ${money(order.TotalValueCents, "ar")} للتذاكر الجديدة وأُعيد ${money(refund.AmountCents, "ar")} من الحجز الأصلي ${memberId ? "إلى رصيد فوكس" : "إلى بطاقتك"}.`,
            )
          : refund.AmountCents === order.TotalValueCents
            ? t(
                ctx.lang,
                `Same total (${money(order.TotalValueCents, "en")}): the original payment was refunded ${memberId ? "to your VOX credit" : "to your card"} and the new booking charged the same amount, so nothing changes for you.`,
                `نفس الإجمالي (${money(order.TotalValueCents, "ar")}): أُعيد المبلغ الأصلي ${memberId ? "إلى رصيد فوكس" : "إلى بطاقتك"} وخُصم المبلغ نفسه للحجز الجديد، فلا يتغير شيء بالنسبة لك.`,
              )
            : t(
                ctx.lang,
                `${money(refund.AmountCents, "en")} from the original booking went ${memberId ? "to your VOX credit" : "back to your card"} and the new tickets were ${money(order.TotalValueCents, "en")}.`,
                `أُعيد ${money(refund.AmountCents, "ar")} من الحجز الأصلي ${memberId ? "إلى رصيد فوكس" : "إلى بطاقتك"} وكلفت التذاكر الجديدة ${money(order.TotalValueCents, "ar")}.`,
              );
      const fnbText = fnbCarried.length
        ? t(
            ctx.lang,
            ` Your ${joinList(fnbCarried, "en")} moved with it.`,
            ` وانتقلت معه ${joinList(fnbCarried, "ar")}.`,
          )
        : fnbDropped.length
          ? t(
              ctx.lang,
              ` I couldn't move your ${joinList(fnbDropped, "en")} to the new booking — you can add them again or buy them at the counter.`,
              ` لم أتمكن من نقل ${joinList(fnbDropped, "ar")} إلى الحجز الجديد — يمكنك إضافتها مجدداً أو شراؤها من المنفذ.`,
            )
          : "";
      const speech = t(
        ctx.lang,
        `Swapped! Your new booking is ${newBooking.VistaBookingId}: ${inp.ticketCount} ticket${inp.ticketCount === 1 ? "" : "s"} for ${inp.filmTitle}, ${inp.targetExperience} at ${await cname(ctx, inp.targetCinemaId)} ${onDateTime(inp.targetShowtime, "en", ctx.nowLocal)}, seats ${seats}.${fnbText} ${diffText} The original booking ${inp.bookingId} is cancelled and new tickets are on their way by email.`,
        `تم التبديل! حجزك الجديد ${newBooking.VistaBookingId}: ${inp.ticketCount} تذكرة لفيلم ${inp.filmTitle}، ${inp.targetExperience} في ${await cname(ctx, inp.targetCinemaId)} بتاريخ ${fmtDateTime(inp.targetShowtime, "ar", ctx.nowLocal)}، المقاعد ${seats}.${fnbText} ${diffText} تم إلغاء الحجز الأصلي ${inp.bookingId} وستصلك التذاكر الجديدة بالبريد.`,
      );
      return {
        result: {
          speech,
          newBookingId: newBooking.VistaBookingId,
          refundReference: spokenRefundRef(String(refund.Id ?? refund.Reference)),
          refundAmountCents: refund.AmountCents,
          seats,
        },
        ui: {
          type: "qr",
          title: t(ctx.lang, "New booking", "الحجز الجديد"),
          items: [
            {
              ...bookingCard(newBooking, ctx.lang, ctx.nowLocal, await cname(ctx, inp.targetCinemaId)),
              swappedFrom: inp.bookingId,
            },
          ],
        },
        journey: { name: "swap", status: "completed" },
      };
    },

    async add_tickets(ctx, a) {
      const inp = a.input as {
        userSessionId: string;
        tickets: { ticketTypeCode: string; qty: number }[];
        preference?: string;
      };
      const key = (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
      const sess = key ? await ctx.catalog.sessionByKey(key) : null;
      if (!sess) throw new ActionError("ORDER_INVALID_STATE", "No session selected for this order");
      // offers already on the order are dropped by Vista when tickets change — re-check them afterwards
      const before = await ctx.vista.getOrder(inp.userSessionId).catch(() => null);
      const prevOffers = (
        (before?.Order?.AppliedOffers ?? []) as {
          offerId: string;
          title: string;
          type: string;
          cardBin?: string;
        }[]
      ).filter((o) => o.type === "bank" || o.type === "promo" || o.type === "member");
      let r = await ctx.vista
        .addTickets({
          UserSessionId: inp.userSessionId,
          CinemaId: sess.cinemaId,
          SessionId: sess.sessionId,
          TicketTypes: inp.tickets.map((x) => ({ TicketTypeCode: x.ticketTypeCode, Qty: x.qty })),
          SeatPreference: inp.preference,
          ConversationId: a.conversationId,
        })
        .catch((e) => {
          throw fromVista(e);
        });
      ctx.catalog.invalidateSessions(sess.cinemaId);
      const offerNotes: string[] = [];
      for (const o of prevOffers) {
        const elig = await ctx.vista
          .offerEligibility(o.offerId, {
            sessionKey: key,
            memberId: ctx.conversation.memberId ?? undefined,
            cardBin: o.cardBin,
            ticketCount: inp.tickets.reduce((n, x) => n + x.qty, 0),
          })
          .catch(() => null);
        if (elig?.eligible) {
          const re = await ctx.vista
            .applyOffer({
              UserSessionId: inp.userSessionId,
              OfferId: o.offerId,
              CardBin: o.cardBin,
              MemberId: ctx.conversation.memberId ?? undefined,
            })
            .catch(() => null);
          if (re?.Order) {
            r = { ...r, Order: re.Order };
            offerNotes.push(t(ctx.lang, `${o.title} still applies.`, `لا يزال عرض ${o.title} سارياً.`));
            continue;
          }
        }
        const why =
          elig?.reasons?.[0] ?? t(ctx.lang, "its conditions no longer match", "لم تعد شروطه مطابقة");
        offerNotes.push(
          t(ctx.lang, `${o.title} was removed — ${why}.`, `تمت إزالة عرض ${o.title} — ${why}.`),
        );
      }
      const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cname(ctx, sess.cinemaId));
      const tier = /PREFERRED/i.test(s.tickets[0]?.description ?? "")
        ? "Preferred View"
        : /PREMIUM/i.test(s.tickets[0]?.description ?? "")
          ? "Premium"
          : "";
      const speech = t(
        ctx.lang,
        `${s.tickets.length} seat${s.tickets.length === 1 ? "" : "s"} held: ${seatRange(s.seats)}${tier ? ` (${tier})` : ""}, ${money(s.totalCents, "en")}.${offerNotes.length ? ` ${offerNotes.join(" ")}` : ""} Change seats, add food, or pay?`,
        `تم حجز ${s.tickets.length} ${s.tickets.length === 1 ? "مقعد" : "مقاعد"}: ${seatRange(s.seats)}، ${money(s.totalCents, "ar")}.${offerNotes.length ? ` ${offerNotes.join(" ")}` : ""} تغيير المقاعد، إضافة طعام، أم الدفع؟`,
      );
      await appendEvent(ctx.db, ctx.events, a.conversationId, "order.updated", {
        userSessionId: inp.userSessionId,
        summary: s,
      });
      return {
        result: { speech, order: s },
        ui: {
          type: "order",
          title: t(ctx.lang, "Your order", "طلبك"),
          items: [s],
          actions: [
            { label: t(ctx.lang, "Change seats", "تغيير المقاعد"), value: "seatmap:open" },
            { label: t(ctx.lang, "Add food & drinks", "أضف مأكولات"), value: "menu:open" },
            { label: t(ctx.lang, "Pay", "ادفع"), value: "pay:start", style: "primary" },
          ],
        },
      };
    },

    async select_seats(ctx, a) {
      const inp = a.input as {
        userSessionId: string;
        seats: { row: string; number: string }[];
        autoAllocate: boolean;
        preference?: string;
      };
      const key = (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
      const sess = key ? await ctx.catalog.sessionByKey(key) : null;
      if (!sess) throw new ActionError("ORDER_INVALID_STATE", "No session selected for this order");
      let order: Record<string, any>;
      if (inp.autoAllocate) {
        const cur = await ctx.vista.getOrder(inp.userSessionId);
        const tickets = (cur.Order?.Sessions?.[0]?.Tickets ?? []) as { TicketTypeCode: string }[];
        const counts: Record<string, number> = {};
        for (const x of tickets) counts[x.TicketTypeCode] = (counts[x.TicketTypeCode] ?? 0) + 1;
        const grouped = Object.entries(counts).map(([TicketTypeCode, Qty]) => ({ TicketTypeCode, Qty }));
        order = (
          await ctx.vista
            .addTickets({
              UserSessionId: inp.userSessionId,
              CinemaId: sess.cinemaId,
              SessionId: sess.sessionId,
              TicketTypes: grouped,
              SeatPreference: inp.preference ?? "middle",
            })
            .catch((e) => {
              throw fromVista(e);
            })
        ).Order;
      } else {
        order = (
          await ctx.vista
            .setSeats({
              UserSessionId: inp.userSessionId,
              CinemaId: sess.cinemaId,
              SessionId: sess.sessionId,
              SelectedSeats: inp.seats.map((s) => ({ Row: s.row.toUpperCase(), Number: String(s.number) })),
            })
            .catch((e) => {
              throw fromVista(e);
            })
        ).Order;
      }
      ctx.catalog.invalidateSessions(sess.cinemaId);
      const s = orderSummary(order, ctx.lang, ctx.nowLocal, await cname(ctx, sess.cinemaId));
      await appendEvent(ctx.db, ctx.events, a.conversationId, "order.updated", {
        userSessionId: inp.userSessionId,
        summary: s,
      });
      const tierNames = [
        ...new Set(
          s.tickets.map((tk: any) =>
            String(tk.description)
              .replace(/^[A-Z0-9]+ /, "")
              .toLowerCase(),
          ),
        ),
      ];
      const tierNote = tierNames.some((x) => /premium|preferred/.test(x))
        ? ` (${tierNames.join(", ")} — ${money(s.tickets[0]?.finalCents ?? s.tickets[0]?.priceCents ?? 0, "en")} per ticket)`
        : "";
      const speech = t(
        ctx.lang,
        `${seatRange(s.seats)} — done${tierNote}. ${money(s.totalCents, "en")}. Food, or straight to payment?`,
        `${seatRange(s.seats)} — تم${tierNote}. ${money(s.totalCents, "ar")}. طعام، أم الدفع مباشرة؟`,
      );
      return {
        result: { speech, order: s },
        ui: {
          type: "order",
          items: [s],
          actions: [
            { label: t(ctx.lang, "Add food & drinks", "أضف مأكولات"), value: "menu:open" },
            { label: t(ctx.lang, "Pay", "ادفع"), value: "pay:start", style: "primary" },
          ],
        },
      };
    },

    async add_concessions(ctx, a) {
      const inp = a.input as {
        userSessionId: string;
        items: { itemId: string; quantity: number; modifierIds?: string[] }[];
      };
      const cur = await ctx.vista.getOrder(inp.userSessionId);
      if (!cur.Order) throw new ActionError("NOT_FOUND", "No active order");
      // quantity 0 = take that item out (the guest rejected it) — remove its lines, never rebuild the order
      const removals = inp.items.filter((i) => i.quantity === 0);
      const removed: string[] = [];
      let order = cur.Order;
      for (const rm of removals) {
        // match on item, and on the chosen modifiers when given (so "remove the Pepsi combo" keeps the 7 Up combo)
        const want = (rm.modifierIds ?? []).map(String).sort().join("|");
        const all = (
          (order.Concessions ?? []) as {
            Id: string;
            ItemId: string;
            Description: string;
            Modifiers?: { Id: string }[];
          }[]
        ).filter((c) => c.ItemId === rm.itemId);
        const exact = want
          ? all.filter(
              (c) =>
                (c.Modifiers ?? [])
                  .map((m) => String(m.Id))
                  .sort()
                  .join("|") === want,
            )
          : [];
        const lines = exact.length ? exact : want ? all.slice(0, 1) : all;
        for (const line of lines) {
          const rr = await ctx.vista.removeConcession(inp.userSessionId, line.Id).catch((e) => {
            throw fromVista(e);
          });
          order = rr.Order ?? order;
          removed.push(line.Description);
        }
      }
      const adds = inp.items.filter((i) => i.quantity > 0);
      let r: { Order: Record<string, any>; FailedConcessions?: unknown } = {
        Order: order,
        FailedConcessions: [],
      };
      if (adds.length)
        r = await ctx.vista
          .addConcessions({
            UserSessionId: inp.userSessionId,
            CinemaId: cur.Order.CinemaId,
            Concessions: adds.map((i) => ({
              ItemId: i.itemId,
              Quantity: i.quantity,
              Modifiers: i.modifierIds,
            })),
          })
          .catch((e) => {
            throw fromVista(e);
          });
      const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cname(ctx, cur.Order.CinemaId));
      const failed = (r.FailedConcessions as { ItemId: string; Reason: string }[] | null) ?? [];
      await appendEvent(ctx.db, ctx.events, a.conversationId, "order.updated", {
        userSessionId: inp.userSessionId,
        summary: s,
      });
      const added = s.concessions.filter((c) => adds.some((i) => i.itemId === c.itemId));
      const addedText = added.map((c) => `${c.quantity}× ${c.description}`).join(", ");
      const speech = t(
        ctx.lang,
        `${removed.length ? `${removed.join(", ")} removed. ` : ""}${addedText ? `${addedText} added` : removed.length ? "" : "Nothing changed"}${failed.length ? ` (couldn't add ${failed.map((f) => f.ItemId).join(", ")})` : ""}${addedText || !removed.length ? ". " : ""}${money(s.totalCents, "en")} in total. Pay now?`,
        `${removed.length ? `تمت إزالة ${removed.join("، ")}. ` : ""}${addedText ? `تمت إضافة ${addedText}. ` : ""}الإجمالي ${money(s.totalCents, "ar")}. الدفع الآن؟`,
      );
      return {
        result: { speech, order: s, failed },
        ui: {
          type: "order",
          items: [s],
          actions: [{ label: t(ctx.lang, "Pay", "ادفع"), value: "pay:start", style: "primary" }],
        },
        journey: { name: "fnb_preorder", status: "completed" },
      };
    },

    async apply_offer(ctx, a) {
      const inp = a.input as {
        userSessionId: string;
        offerId?: string;
        promoCode?: string;
        cardBin?: string;
        memberId?: string;
      };
      const r = await ctx.vista
        .applyOffer({
          UserSessionId: inp.userSessionId,
          OfferId: inp.offerId,
          PromoCode: inp.promoCode,
          CardBin: inp.cardBin,
          MemberId: inp.memberId,
        })
        .catch((e) => {
          throw fromVista(e);
        });
      const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cname(ctx, r.Order.CinemaId));
      await appendEvent(ctx.db, ctx.events, a.conversationId, "order.updated", {
        userSessionId: inp.userSessionId,
        summary: s,
      });
      const d = r.AppliedOffer?.DiscountCents ?? 0;
      const speech =
        d > 0
          ? t(
              ctx.lang,
              `${r.AppliedOffer?.Title} applied — you save ${money(d, "en")}. New total ${money(s.totalCents, "en")}.`,
              `تم تطبيق ${r.AppliedOffer?.Title} — وفرت ${money(d, "ar")}. الإجمالي الجديد ${money(s.totalCents, "ar")}.`,
            )
          : t(
              ctx.lang,
              `${r.AppliedOffer?.Title} is applied to your order.`,
              `تم تطبيق ${r.AppliedOffer?.Title} على طلبك.`,
            );
      return {
        result: { speech, order: s, offer: r.AppliedOffer },
        ui: { type: "order", items: [s] },
        journey: { name: "apply_offer", status: "completed" },
      };
    },

    async redeem_points(ctx, a) {
      const inp = a.input as { userSessionId: string; memberId: string; points?: number };
      const r = await ctx.vista
        .redeemLoyalty({
          UserSessionId: inp.userSessionId,
          MemberId: inp.memberId,
          Points: inp.points,
          BalanceType: "SHARE_POINTS",
        })
        .catch((e) => {
          throw fromVista(e);
        });
      const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cname(ctx, r.Order.CinemaId));
      await appendEvent(ctx.db, ctx.events, a.conversationId, "order.updated", {
        userSessionId: inp.userSessionId,
        summary: s,
      });
      const speech = t(
        ctx.lang,
        `${r.Redeemed.Amount} Share Points applied, worth ${money(r.Redeemed.Amount, "en")}. ${s.totalCents > 0 ? `${money(s.totalCents, "en")} left to pay.` : "Nothing left to pay — shall I confirm the booking?"}`,
        `تم استخدام ${r.Redeemed.Amount} نقطة شير بقيمة ${money(r.Redeemed.Amount, "ar")}. ${s.totalCents > 0 ? `المتبقي ${money(s.totalCents, "ar")}.` : "لا يوجد مبلغ متبقٍ — هل أؤكد الحجز؟"}`,
      );
      return { result: { speech, order: s, redeemed: r.Redeemed }, ui: { type: "order", items: [s] } };
    },

    async pay_order(ctx, a) {
      const inp = a.input as {
        userSessionId: string;
        method: string;
        amountCents: number;
        customer: { name: string; email: string; phone: string };
        memberId?: string;
        customerId?: string;
        paymentToken?: string;
        cinemaId: string;
      };
      const cur = await ctx.vista.getOrder(inp.userSessionId);
      if (!cur.Order) throw new ActionError("NOT_FOUND", "No active order");
      if (!inp.customer?.email || !inp.customer?.name)
        throw new ActionError("VALIDATION", "A name, email and mobile number are needed for the tickets");
      const total = cur.Order.TotalValueCents as number;
      const tender =
        inp.method === "VOX_CREDIT"
          ? { PaymentTenderCategory: "EWALLET", PaymentValueCents: total, MemberId: inp.memberId }
          : inp.method === "SHARE_POINTS"
            ? {
                PaymentTenderCategory: "LOYALTY",
                PaymentValueCents: total,
                PointsRedeemed: total,
                MemberId: inp.memberId,
              }
            : {
                PaymentTenderCategory: "CREDIT",
                PaymentValueCents: total,
                PaymentToken: inp.paymentToken,
                CardNumber: inp.paymentToken?.startsWith("tok_") ? undefined : "4111111111111111",
              };
      const pay = await ctx.vista
        .completeOrder({
          UserSessionId: inp.userSessionId,
          CustomerEmail: inp.customer.email,
          CustomerName: inp.customer.name,
          CustomerPhone: inp.customer.phone,
          PaymentInfoCollection: [tender],
          MemberId: inp.memberId,
          CustomerId: inp.customerId,
          Source: "concierge",
        })
        .catch((e) => {
          throw fromVista(e);
        });
      const b = pay.Booking!;
      ctx.catalog.invalidateSessions(b.CinemaId);
      const fnbOrderPaid =
        (ctx.conversation.metadata as { fnbOrder?: string })?.fnbOrder === inp.userSessionId;
      await updateConversation(ctx.db, a.conversationId, {
        metadata: {
          ...(ctx.conversation.metadata ?? {}),
          activeOrder: null,
          fnbOrder: null,
          ...(fnbOrderPaid ? { lastFnbBookingId: b.VistaBookingId } : { lastBookingId: b.VistaBookingId }),
        },
      });
      const card = bookingCard(b, ctx.lang, ctx.nowLocal, await cname(ctx, b.CinemaId));
      const fnbOnly = card.ticketCount === 0;
      const speech = fnbOnly
        ? t(
            ctx.lang,
            `Done — food order ${b.VistaBookingId} is paid. Show the QR at the Candy Bar and it'll be ready for you. Enjoy the show!`,
            `تم — طلب الطعام ${b.VistaBookingId} مدفوع. أظهر رمز QR عند الكاندي بار وسيكون جاهزاً. استمتع بالعرض!`,
          )
        : t(
            ctx.lang,
            `You're booked — reference ${b.VistaBookingId}. The QR is on screen and the tickets are in your email; just scan it at the entrance. Want popcorn or a drink for the show?`,
            `تم الحجز — الرقم ${b.VistaBookingId}. رمز QR على الشاشة والتذاكر في بريدك؛ امسحه عند المدخل. هل تريد فشاراً أو مشروباً للعرض؟`,
          );
      return {
        result: { speech, bookingId: b.VistaBookingId, qrPayload: b.QrPayload, booking: card },
        ui: {
          type: "qr",
          title: t(ctx.lang, "Booking confirmed", "تم تأكيد الحجز"),
          items: [card],
          meta: { qrPayload: b.QrPayload },
        },
        journey: { name: "payment", status: "completed" },
      };
    },

    async cancel_order(ctx, a) {
      const inp = a.input as { userSessionId: string };
      await ctx.vista.cancelOrder(inp.userSessionId).catch((e) => {
        throw fromVista(e);
      });
      return {
        result: {
          speech: t(ctx.lang, "Order cancelled and seats released.", "تم إلغاء الطلب وتحرير المقاعد."),
        },
        journey: { name: "guided_booking", status: "abandoned" },
      };
    },

    async submit_feedback(ctx, a) {
      const inp = a.input as {
        rating: number;
        comment: string;
        resolved?: boolean;
        language: string;
        customerId?: string;
      };
      const id = prefixedId("fb", 10);
      await ctx.db.insert(S.feedback).values({
        id,
        conversationId: a.conversationId,
        customerId: inp.customerId ?? null,
        rating: inp.rating,
        comment: inp.comment,
        resolved: inp.resolved ?? null,
        language: inp.language,
        oneViewReference: `OV-FB-${id.slice(-6).toUpperCase()}`,
      });
      return {
        result: {
          speech: t(ctx.lang, "Thanks, your feedback is recorded.", "شكراً، تم تسجيل ملاحظاتك."),
          feedbackId: id,
        },
        journey: { name: "feedback", status: "completed" },
      };
    },

    async create_complaint(ctx, a) {
      const inp = a.input as {
        category: string;
        description: string;
        cinemaId?: string;
        bookingId?: string;
        visitDate?: string;
        customerId?: string;
        customerName: string;
        customerEmail: string;
        customerPhone: string;
        severity: string;
        language: string;
      };
      const n = (await ctx.db.select({ n: sql<number>`count(*)` }).from(S.complaints))[0]!.n;
      const id = `CMP-${new Date().getUTCFullYear()}-${String(Number(n) + 1).padStart(6, "0")}`;
      const resolution =
        inp.category === "refund"
          ? t(
              ctx.lang,
              "A customer care specialist will review the refund within 24 hours.",
              "سيراجع أخصائي خدمة العملاء الاسترداد خلال 24 ساعة.",
            )
          : inp.category === "fnb" || inp.category === "facility"
            ? t(
                ctx.lang,
                "The cinema manager will be informed today and you'll hear back within 48 hours.",
                "سيتم إبلاغ مدير السينما اليوم وستصلك إجابة خلال 48 ساعة.",
              )
            : t(
                ctx.lang,
                "Our team will respond by email within 48 hours.",
                "سيرد فريقنا عبر البريد الإلكتروني خلال 48 ساعة.",
              );
      await ctx.db.insert(S.complaints).values({
        id,
        conversationId: a.conversationId,
        customerId: inp.customerId ?? null,
        customerName: inp.customerName,
        customerEmail: inp.customerEmail,
        customerPhone: inp.customerPhone,
        category: inp.category,
        severity: inp.severity,
        cinemaId: inp.cinemaId ?? null,
        bookingId: inp.bookingId ?? null,
        visitDate: inp.visitDate ?? null,
        description: inp.description,
        resolutionOffered: resolution,
        status: "open",
        oneViewCaseId: `OV-${id}`,
      });
      const speech = t(
        ctx.lang,
        `Your complaint is logged with reference ${id}. ${resolution} Would you like me to connect you to an agent now as well?`,
        `تم تسجيل شكواك بالرقم المرجعي ${id}. ${resolution} هل تريد أن أوصلك بموظف الآن أيضاً؟`,
      );
      return {
        result: { speech, complaintId: id, resolution },
        ui: {
          type: "complaint",
          title: t(ctx.lang, "Complaint logged", "تم تسجيل الشكوى"),
          items: [
            {
              id,
              category: inp.category,
              severity: inp.severity,
              description: inp.description,
              resolution,
              bookingId: inp.bookingId,
              cinemaId: inp.cinemaId,
            },
          ],
        },
        journey: { name: "complaint", status: "completed" },
      };
    },

    async transfer_to_agent(ctx, a) {
      const inp = a.input as { reason: string; agentSummary: string; language: Language };
      const transferId = prefixedId("tr", 10);
      // Build a structured summary from the ledger + events
      const events = await ctx.db
        .select()
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, a.conversationId))
        .orderBy(desc(S.conversationEvents.seq))
        .limit(60);
      const toolsUsed = [
        ...new Set(events.filter((e) => e.type === "tool.completed").map((e) => String(e.payload.tool))),
      ];
      const bookingIds = [
        ...new Set(
          events.flatMap(
            (e) =>
              JSON.stringify(e.payload)
                .match(/"bookingId":"([A-Z0-9]{5,8})"/g)
                ?.map((m) => m.split('"')[3]!) ?? [],
          ),
        ),
      ];
      const complaint = (
        await ctx.db
          .select()
          .from(S.complaints)
          .where(eq(S.complaints.conversationId, a.conversationId))
          .orderBy(desc(S.complaints.createdAt))
          .limit(1)
      )[0];
      const transcriptRows = events
        .filter((e) => e.type === "message.user" || e.type === "message.agent")
        .reverse()
        .slice(-20);
      const customer = ctx.conversation.customerId
        ? await ctx.vista.customer(ctx.conversation.customerId).catch(() => null)
        : null;
      const lines = [
        `Reason: ${inp.reason}`,
        customer
          ? `Customer: ${customer.firstName} ${customer.lastName} (${customer.memberId ?? "guest"}, ${customer.tier ?? ""})`
          : "Customer: guest (not logged in)",
        `Language: ${inp.language}`,
        inp.agentSummary ? `Voxi summary: ${inp.agentSummary}` : "",
        bookingIds.length ? `Bookings discussed: ${bookingIds.join(", ")}` : "",
        complaint
          ? `Complaint: ${complaint.id} (${complaint.category}) — ${complaint.description.slice(0, 200)}`
          : "",
        toolsUsed.length ? `Steps taken: ${toolsUsed.join(", ")}` : "",
        (ctx.conversation.metadata as { activeOrder?: string })?.activeOrder
          ? `Active order: ${(ctx.conversation.metadata as { activeOrder?: string }).activeOrder}`
          : "",
      ].filter(Boolean);
      const summary = lines.join("\n");
      await ctx.db.insert(S.transfers).values({
        id: transferId,
        conversationId: a.conversationId,
        reason: inp.reason,
        summary,
        context: { bookingIds, complaintId: complaint?.id, toolsUsed },
        adapter: ctx.handover.name,
        status: "requested",
      });
      let res: Awaited<ReturnType<typeof ctx.handover.start>>;
      try {
        res = await ctx.handover.start({
          transferId,
          conversationId: a.conversationId,
          reason: inp.reason,
          summary,
          language: inp.language,
          customer: {
            name: customer ? `${customer.firstName} ${customer.lastName}` : undefined,
            email: customer?.email,
            phone: customer?.phone,
            memberId: customer?.memberId ?? undefined,
            customerId: customer?.id,
          },
          context: { bookingIds, complaintId: complaint?.id },
          transcript: transcriptRows.map((e) => ({
            role: e.actor === "user" ? "user" : "agent",
            text: String(e.payload.text ?? ""),
          })),
        });
      } catch (e) {
        await ctx.db.update(S.transfers).set({ status: "failed" }).where(eq(S.transfers.id, transferId));
        throw new ActionError(
          "HANDOVER_FAILED",
          `Could not reach the contact centre: ${(e as Error).message}`,
          true,
        );
      }
      await ctx.db
        .update(S.transfers)
        .set({
          status: res.status,
          externalConversationId: res.externalConversationId,
          externalReference: res.externalReference ?? null,
          agentName: res.agentName ?? null,
          oneViewNoteId: `OV-NOTE-${transferId.slice(-6).toUpperCase()}`,
        })
        .where(eq(S.transfers.id, transferId));
      await updateConversation(ctx.db, a.conversationId, {
        mode: "human",
        status: "transferred",
        outcome: "transferred",
      });
      await appendEvent(ctx.db, ctx.events, a.conversationId, "transfer.status", {
        transferId,
        status: res.status,
        agentName: res.agentName,
      });
      const speech = t(
        ctx.lang,
        `You're in the queue for a customer care agent${res.agentName ? ` — ${res.agentName} will be with you shortly` : ""}. I've shared the summary so they have the full picture.`,
        `أنت في قائمة الانتظار لموظف خدمة العملاء${res.agentName ? ` — سيكون ${res.agentName} معك قريباً` : ""}. شاركت الملخص ليكون لديهم الصورة كاملة.`,
      );
      return {
        result: { speech, transferId, status: res.status, agentName: res.agentName, summary },
        ui: {
          type: "transfer",
          items: [{ transferId, status: res.status, agentName: res.agentName, summary }],
          meta: { transferId },
        },
        journey: { name: "transfer", status: "completed" },
      };
    },
  };

export async function executeAction(app: AppContext, catalog: Catalog, a: ActionRow) {
  const conversation = (
    await app.db.select().from(S.conversations).where(eq(S.conversations.id, a.conversationId))
  )[0];
  if (!conversation)
    return fail(app.db, app.events, a, {
      code: "NOT_FOUND",
      message: "Conversation not found",
      retryable: false,
    });
  const ctx: ExecCtx = {
    ...app,
    catalog,
    conversation,
    lang: (conversation.language as Language) ?? "en",
    nowLocal: nowLocalIso(app.cfg.timeZone),
  };
  const handler = handlers[a.type];
  const steps: ActionRow["steps"] = [...(a.steps ?? [])];
  if (!handler)
    return fail(app.db, app.events, a, {
      code: "NOT_FOUND",
      message: `No executor for ${a.type}`,
      retryable: false,
    });
  const started = Date.now();
  try {
    const out = await handler(ctx, a, steps);
    if (out.journey) await markJourney(app.db, a.conversationId, out.journey.name, out.journey.status);
    app.log.info(
      { actionId: a.id, type: a.type, conversationId: a.conversationId, ms: Date.now() - started },
      "action succeeded",
    );
    return complete(app.db, app.events, a, out.result, out.ui, steps);
  } catch (e) {
    const err = e instanceof ActionError ? e : fromVista(e);
    app.log.warn(
      {
        actionId: a.id,
        type: a.type,
        code: err.code,
        msg: err.message,
        conflict: err.conflict,
        retryable: err.retryable,
      },
      "action failed",
    );
    const speech =
      err.code === "PAYMENT_DECLINED"
        ? t(
            ctx.lang,
            `The payment was declined (${err.message}). Would you like to try another card or pay with VOX credit?`,
            `تم رفض الدفع (${err.message}). هل تريد تجربة بطاقة أخرى أو الدفع برصيد فوكس؟`,
          )
        : err.code === "OFFER_NOT_ELIGIBLE"
          ? t(
              ctx.lang,
              `I can't apply that offer: ${err.message}. Shall I remove it, or change the tickets or card so it qualifies?`,
              `لا يمكنني تطبيق هذا العرض: ${err.message}. هل أزيله، أم نغيّر التذاكر أو البطاقة ليصبح مؤهلاً؟`,
            )
          : err.code === "SEATS_UNAVAILABLE"
            ? t(
                ctx.lang,
                "Those seats were just taken by someone else. Shall I pick the next best seats?",
                "تم حجز هذه المقاعد للتو من قبل شخص آخر. هل أختار أفضل المقاعد التالية؟",
              )
            : err.code === "BOOKING_ALREADY_CANCELLED"
              ? t(
                  ctx.lang,
                  "That booking was already cancelled a moment ago, so there's nothing more to do.",
                  "تم إلغاء هذا الحجز بالفعل قبل لحظات، فلا يوجد ما يمكن فعله.",
                )
              : err.code === "ORDER_EXPIRED"
                ? t(
                    ctx.lang,
                    "The order timed out and the seats were released. Let's start again — it only takes a moment.",
                    "انتهت مهلة الطلب وتم تحرير المقاعد. لنبدأ من جديد — لن يستغرق سوى لحظة.",
                  )
                : err.code === "VISTA_UNAVAILABLE"
                  ? t(
                      ctx.lang,
                      "The booking system is slow to respond right now. I'll retry automatically.",
                      "نظام الحجز بطيء الاستجابة حالياً. سأعيد المحاولة تلقائياً.",
                    )
                  : err.message;
    return fail(
      app.db,
      app.events,
      a,
      { code: err.code, message: speech, retryable: err.retryable, detail: err.detail },
      { conflict: err.conflict, steps },
    );
  }
}
