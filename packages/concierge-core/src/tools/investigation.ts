import { createHash } from "node:crypto";
import { schema as S } from "@voxi/db";
import { and, desc, eq } from "drizzle-orm";
import { updateConversation } from "../services/conversation.js";
import { t } from "../services/format.js";
import { bookingCard, verifyOwnership } from "./bookings.js";
import { type ToolHandlers, ok } from "./types.js";

/** A bank statement is reported evidence. Only our own verified records establish a booking/payment. */
export const investigationTools: Pick<ToolHandlers, "investigate_payment"> = {
  async investigate_payment(ctx, input) {
    const metadata = ctx.conversation.metadata ?? {};
    const actions = await ctx.db
      .select()
      .from(S.actions)
      .where(and(eq(S.actions.conversationId, ctx.conversation.id), eq(S.actions.type, "pay_order")))
      .orderBy(desc(S.actions.createdAt))
      .limit(20);
    const knownOrders = new Set(
      [metadata.activeOrder, metadata.activeOrderId, ...actions.map((a) => a.input.userSessionId)].filter(
        (v): v is string => typeof v === "string",
      ),
    );
    const orderId =
      input.userSessionId ??
      (typeof metadata.activeOrder === "string"
        ? metadata.activeOrder
        : (actions[0]?.input.userSessionId as string | undefined));
    if (orderId && !knownOrders.has(orderId))
      return ok(
        { status: "verification_required", needs: "verified_order", bookingFound: false },
        t(
          ctx.lang,
          "Please sign in to the account used for this order or provide its booking reference for verification.",
          "يرجى تسجيل الدخول إلى الحساب المستخدم لهذا الطلب أو تقديم رقم الحجز للتحقق.",
        ),
      );
    const order = orderId ? (await ctx.vista.getOrder(orderId).catch(() => null))?.Order : null;
    const actionRows = actions.filter((a) => !orderId || a.input.userSessionId === orderId);
    const completedId =
      order?.CompletedBookingId ?? actionRows.find((a) => a.status === "succeeded")?.result?.bookingId;
    const bookingId =
      input.bookingId ??
      (!input.transactionReference && typeof completedId === "string" ? completedId : undefined);
    let candidates: Record<string, any>[] = [];
    let candidateBookings: Record<string, any>[] = [];
    if (bookingId) {
      const b = (await ctx.vista.getBooking(bookingId).catch(() => null))?.Booking;
      if (b) candidates = [b];
    } else if (ctx.conversation.isLoggedIn && ctx.conversation.customerId && input.transactionReference) {
      candidates = (
        await ctx.vista.searchBookings({
          CustomerId: ctx.conversation.customerId,
          UpcomingOnly: false,
          Limit: 50,
        })
      ).Bookings.filter((b) =>
        (b.PaymentInfoCollection ?? []).some(
          (p: any) =>
            p.Reference === input.transactionReference || p.BankReference === input.transactionReference,
        ),
      );
    }
    if (candidates.some((b) => !verifyOwnership(ctx, b, input.verification).ok))
      return ok(
        { status: "verification_required", needs: "booking_verification", bookingFound: false },
        t(
          ctx.lang,
          "I need to verify ownership before showing this booking. Please use the account it was booked with or verify the booking email.",
          "أحتاج إلى التحقق من ملكية الحجز قبل عرضه. استخدم حساب الحجز أو تحقق من بريده الإلكتروني.",
        ),
      );
    const matched = candidates.filter(
      (b) =>
        ["confirmed", "partially_refunded", "collected"].includes(b.Status) &&
        (!input.cardLast4 ||
          (b.PaymentInfoCollection ?? []).some((p: any) =>
            String(p.CardNumber ?? p.CardNumberMasked ?? "")
              .replace(/\D/g, "")
              .endsWith(input.cardLast4!),
          )),
    );
    if (
      !bookingId &&
      !input.transactionReference &&
      ctx.conversation.isLoggedIn &&
      ctx.conversation.customerId
    ) {
      const recent = (
        await ctx.vista.searchBookings({
          CustomerId: ctx.conversation.customerId,
          UpcomingOnly: true,
          Limit: 10,
        })
      ).Bookings;
      candidateBookings = recent
        .filter((b) => verifyOwnership(ctx, b).ok && ["confirmed", "partially_refunded"].includes(b.Status))
        .map((b) => bookingCard(b, ctx.lang, ctx.nowLocal));
    }
    const pending =
      !input.transactionReference && actionRows.some((a) => a.status === "queued" || a.status === "running");
    const failed =
      !input.transactionReference && actionRows.some((a) => a.status === "failed" || a.status === "conflict");
    const status = matched.length ? "found" : pending ? "processing" : failed ? "failed" : "unresolved";
    const evidence = {
      status,
      bookingFound: matched.length > 0,
      ...(candidateBookings.length ? { needs: "booking_selection", candidateBookings } : {}),
      userSessionId: orderId ?? null,
      orderState: order?.State ?? null,
      actions: actionRows.map((a) => ({
        actionId: a.id,
        status: a.status,
        errorCode: a.error?.code ?? null,
      })),
      bookings: matched.map((b) => bookingCard(b, ctx.lang, ctx.nowLocal)),
      reportedTransactionReference: input.transactionReference ?? null,
      reportedCardLast4: input.cardLast4 ?? null,
      transactionReferenceVerified:
        !!input.transactionReference &&
        matched.some((b) =>
          (b.PaymentInfoCollection ?? []).some(
            (p: any) =>
              p.Reference === input.transactionReference || p.BankReference === input.transactionReference,
          ),
        ),
      bankDebitVerified: false,
      paymentRecordFound: matched.some((b) => b.PaymentInfoCollection?.length),
      retryPaymentAllowed: false,
      nextStep:
        status === "found"
          ? "show_confirmed_booking"
          : status === "processing"
            ? "check_pending_action"
            : candidateBookings.length
              ? "choose_booking"
              : "offer_handover",
    };
    const investigationId = `inv_${createHash("sha256")
      .update(JSON.stringify({ conversationId: ctx.conversation.id, ...evidence }))
      .digest("hex")
      .slice(0, 18)}`;
    await updateConversation(ctx.db, ctx.conversation.id, {
      metadata: {
        ...metadata,
        paymentInvestigation: {
          investigationId,
          ...evidence,
          authGeneration: Number(metadata.widgetAuthGeneration ?? 0),
          checkedAt: new Date().toISOString(),
        },
      },
    });
    return ok(
      { investigationId, ...evidence },
      t(
        ctx.lang,
        candidateBookings.length
          ? "I found recent bookings on your account. Is one of these the booking for the reported payment?"
          : status === "found"
            ? "I found the confirmed booking; its details and QR are on screen."
            : status === "processing"
              ? "The payment request is still processing. I'll check its result before any next step."
              : "I couldn't match this to a confirmed booking. This check cannot confirm a bank debit. Shall I pass the order and payment reference to Customer Care?",
        candidateBookings.length
          ? "وجدت حجوزات حديثة في حسابك. هل أحدها هو الحجز المقصود بالدفع؟"
          : status === "found"
            ? "وجدت الحجز المؤكد؛ تفاصيله ورمز QR على الشاشة."
            : status === "processing"
              ? "طلب الدفع قيد المعالجة. سأتحقق من نتيجته قبل الخطوة التالية."
              : "لم أجد حجزاً مؤكداً مطابقاً. هذا الفحص لا يؤكد الخصم البنكي. هل أحيل الطلب ومرجع الدفع إلى خدمة العملاء؟",
      ),
      {
        type: "payment_investigation",
        items: [{ investigationId, ...evidence }],
        meta: { investigationId, status },
        actions: candidateBookings.length
          ? candidateBookings.map((b) => ({
              label: `${b.filmTitle} · ${b.bookingId}`,
              value: `investigation:booking:${b.bookingId}`,
            }))
          : status === "failed" || status === "unresolved"
            ? [
                {
                  label: t(ctx.lang, "Contact Customer Care", "التواصل مع خدمة العملاء"),
                  value: `investigation:handover:${investigationId}`,
                },
              ]
            : [],
      },
    );
  },
};
