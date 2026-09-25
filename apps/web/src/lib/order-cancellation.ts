import type { UiHint, WidgetEvent } from "./api";
import type { TranscriptItem } from "./widget-state";

export type OrderEventIdentity = { token: string; conversationId: string; epoch: number };

/** A completed cancellation identifies its order; speech or a cleared server draft is not that proof. */
export function cancelledCurrentOrder(
  event: WidgetEvent,
  activeOrderId: string | undefined,
  expected: OrderEventIdentity,
  current: OrderEventIdentity | null,
): string | undefined {
  if (!current || current.token !== expected.token || current.conversationId !== expected.conversationId || current.epoch !== expected.epoch) return;
  if (event.type !== "action.completed" || event.action.type !== "cancel_order" || event.action.status !== "succeeded") return;
  const id: unknown = event.action.result?.userSessionId;
  if (typeof id === "string" && id.trim() && id === activeOrderId) return id;
}

const basketCards = new Set(["order", "payment", "seatmap", "payment_switch", "balance_split_confirmation", "balance_reset_confirmation", "payment_switch_confirmation"]);

/** Late reads for a terminal order must not restore its recovery/payment controls. */
export function isCancelledOrderUi(ui: UiHint, cancelledOrders: ReadonlySet<string>): boolean {
  if (!basketCards.has(ui.type)) return false;
  const ids = [ui.meta?.userSessionId, ...ui.items.map(item => item.userSessionId)]
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  const id = ids[0];
  return id !== undefined && ids.every(value => value === id) && cancelledOrders.has(id);
}

/** Keep every card on screen; only this basket's controls are switched off once it is cancelled. */
export function removeCancelledOrderCards(items: TranscriptItem[], orderId: string): TranscriptItem[] {
  const cancelled = new Set([orderId]);
  return items.map(item => item.kind === "cards" && !item.archived && isCancelledOrderUi(item.ui, cancelled) ? { ...item, archived: true } : item);
}
