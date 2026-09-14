import { describe, expect, it } from "vitest";
import type { CommandResult, WidgetEvent } from "../src/lib/api";
import { cancelledCurrentOrder, isCancelledOrderUi, removeCancelledOrderCards, type OrderEventIdentity } from "../src/lib/order-cancellation";
import { verifyHoldNotice, type HoldNoticeSnapshot, type TranscriptItem } from "../src/lib/widget-state";

const identity: OrderEventIdentity = { token: "test-token", conversationId: "test-conversation", epoch: 3 };
const orderId = "expired-order";
const success: WidgetEvent = { type: "action.completed", seq: 7, action: { actionId: "cancel-action", type: "cancel_order", status: "succeeded", result: { userSessionId: orderId, speech: "تم إلغاء الطلب وتحرير المقاعد." } } };
const expired: TranscriptItem = { id: "expired", kind: "cards", ui: { type: "order", items: [{ userSessionId: orderId, filmTitle: "Unpaid film", state: "expired" }], meta: { userSessionId: orderId, expired: true, stage: "expired" }, actions: [{ label: "Check and hold seats again", value: "recover:confirm" }] } };

describe("cancelled basket presentation", () => {
  it("retires the successful expired order's recovery/payment controls without touching another order or paid receipt", () => {
    const payment: TranscriptItem = { id: "payment", kind: "cards", ui: { type: "payment", items: [], meta: { userSessionId: orderId } } };
    const unrelated: TranscriptItem = { id: "other", kind: "cards", ui: { type: "order", items: [], meta: { userSessionId: "other-order" } } };
    const receipt: TranscriptItem = { id: "paid", kind: "cards", ui: { type: "qr", items: [{ userSessionId: orderId, bookingId: "paid-booking" }], meta: { receiptLookup: true } } };
    const history: TranscriptItem = { ...expired, id: "history", archived: true };
    const note: TranscriptItem = { id: "note", kind: "note", text: "Earlier hold expired" };
    const matched = cancelledCurrentOrder(success, orderId, identity, identity);
    expect(matched).toBe(orderId);
    expect(removeCancelledOrderCards([history, expired, payment, unrelated, receipt, note], matched!)).toEqual([history, unrelated, receipt, note]);
    // The same terminal order must not return through a later UI read/replayed card.
    expect(isCancelledOrderUi(expired.ui, new Set([matched!]))).toBe(true);
    expect(isCancelledOrderUi(payment.ui, new Set([matched!]))).toBe(true);
    expect(isCancelledOrderUi(receipt.ui, new Set([matched!]))).toBe(false);
    expect(isCancelledOrderUi(unrelated.ui, new Set([matched!]))).toBe(false);
  });

  it.each(["queued", "running", "failed", "conflict", "cancelled"])("keeps the hold and controls when the cancellation action is %s", status => {
    expect(cancelledCurrentOrder({ ...success, action: { ...success.action, status } }, orderId, identity, identity)).toBeUndefined();
  });

  it("removes the cancelled order's actual offer-switch confirmation and rejects its late replay", () => {
    const switchCard: TranscriptItem = { id: "switch", kind: "cards", ui: { type: "payment_switch", items: [{ userSessionId: orderId, currentTotalCents: 9550, totalAfterCents: 14550, nextPaymentMethod: "VOX_CREDIT" }], meta: { userSessionId: orderId, confirmationId: "switch-proof" }, actions: [{ label: "Remove offer and switch", value: "confirm:switch-proof" }] } };
    const unrelated: TranscriptItem = { ...switchCard, id: "other-switch", ui: { ...switchCard.ui, items: [{ userSessionId: "other-order" }], meta: { userSessionId: "other-order", confirmationId: "other-proof" } } };
    expect(removeCancelledOrderCards([switchCard, unrelated], orderId)).toEqual([unrelated]);
    expect(isCancelledOrderUi(switchCard.ui, new Set([orderId]))).toBe(true);
    expect(isCancelledOrderUi(unrelated.ui, new Set([orderId]))).toBe(false);
  });

  it.each([
    { type: "cancel_booking", result: { userSessionId: orderId } },
    { type: "cancel_order", result: { userSessionId: "other-order" } },
    { type: "cancel_order", result: { speech: "Order cancelled" } },
    { type: "cancel_order", result: { userSessionId: "" } },
  ])("never infers current basket cancellation from an unrelated action or missing order proof: %j", action => {
    expect(cancelledCurrentOrder({ ...success, action: { ...success.action, ...action } }, orderId, identity, identity)).toBeUndefined();
    expect(cancelledCurrentOrder(success, undefined, identity, identity)).toBeUndefined();
  });

  it.each([
    null,
    { ...identity, token: "new-token" },
    { ...identity, conversationId: "new-conversation" },
    { ...identity, epoch: identity.epoch + 1 },
  ])("ignores a previous account/session completion: %j", current => {
    expect(cancelledCurrentOrder(success, orderId, identity, current)).toBeUndefined();
  });

  it("does not retire cards with missing or contradictory order IDs", () => {
    const missing: TranscriptItem = { id: "missing", kind: "cards", ui: { type: "order", items: [] } };
    const conflicting: TranscriptItem = { id: "conflict", kind: "cards", ui: { type: "order", items: [{ userSessionId: "other-order" }], meta: { userSessionId: orderId } } };
    expect(removeCancelledOrderCards([missing, conflicting], orderId)).toEqual([missing, conflicting]);
    expect(isCancelledOrderUi({ type: "order", items: [{ userSessionId: orderId }] }, new Set([orderId]))).toBe(true);
  });

  it("discards an in-flight expiry/recovery response after the matched cancellation clears the hold", async () => {
    const deadline = "2030-06-03T13:00:00Z";
    let current: HoldNoticeSnapshot | null = { ...identity, userSessionId: orderId, expiresAtUtc: deadline };
    let complete!: (result: CommandResult) => void;
    const response = new Promise<CommandResult>(resolve => { complete = resolve; });
    const pending = verifyHoldNotice(current, () => current,
      async () => ({ conversation: { id: identity.conversationId, metadata: { activeOrder: orderId } } }),
      () => response, () => Date.parse(deadline));
    await Promise.resolve();
    expect(cancelledCurrentOrder(success, current.userSessionId, identity, identity)).toBe(orderId);
    current = null; // Concierge commits this synchronously when the exact completion arrives.
    complete({ ok: true, data: { expired: true, userSessionId: orderId, summary: { expiresAtUtc: deadline } }, ui: expired.ui });
    expect(await pending).toEqual({ kind: "none" });
  });
});
