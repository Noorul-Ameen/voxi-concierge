import type { CommandResult, UiHint } from "./api";
import failureGuidance from "./receipt-failure-guidance.json";

export type PreparedReceiptQr = { payload: string; src: string };

export type ReceiptFailureReason = "reference_missing" | "session_changed" | "lookup_failed" |
  "receipt_mismatch" | "inactive_booking" | "qr_missing" | "display_failed";

/** The fixture generator reads the same static guidance; verification still comes only from this lookup. */
export function receiptRenderFailure(reason: ReceiptFailureReason, error: string, verifiedBookingId?: string) {
  const bookingVerified = reason === "display_failed" && !!verifiedBookingId;
  return {
    ok: false as const,
    rendered: false as const,
    reason,
    error,
    bookingVerified,
    ...(bookingVerified ? { bookingId: verifiedBookingId } : {}),
    guidance: failureGuidance[bookingVerified ? "verified" : "unverified"],
  };
}
export type ReceiptRenderFailure = ReturnType<typeof receiptRenderFailure>;

/** A historical receipt is a read-only view and cannot finish the customer's current basket. */
export function receiptCompletesCurrentOrder(ui: UiHint): boolean {
  return ui.type === "qr" && ui.meta?.receiptLookup !== true;
}

/** Only an exact, verified server receipt can supply the QR; agent arguments supply an ID only. */
export async function renderVerifiedReceipt(
  requestedId: unknown,
  load: (bookingId: string) => Promise<CommandResult>,
  generateQr: (payload: string) => Promise<string>,
  render: (ui: UiHint) => void | Promise<void>,
  isCurrent: () => boolean,
) {
  const bookingId = typeof requestedId === "string" ? requestedId.trim().toUpperCase() : "";
  const changed = () => receiptRenderFailure("session_changed", "The account session changed. Check the booking again.");
  if (!bookingId) return receiptRenderFailure("reference_missing", "A booking reference is required to display its QR code.");
  if (!isCurrent()) return changed();
  let verifiedBookingId: string | undefined;
  try {
    const result = await load(bookingId);
    if (!isCurrent()) return changed();
    if (!result.ok) return receiptRenderFailure("lookup_failed", result.error ?? "The verified receipt is not available.");
    const ui = result.ui;
    const booking = ui?.items?.[0];
    if (ui?.type !== "qr" || ui.items.length !== 1 || typeof booking?.bookingId !== "string" || booking.bookingId.trim().toUpperCase() !== bookingId)
      return receiptRenderFailure("receipt_mismatch", "No verified receipt for that exact booking was returned.");
    if (!["confirmed", "collected"].includes(booking.status)) return receiptRenderFailure("inactive_booking", "That booking has no active admission QR code.");
    const payload = booking.qrPayload;
    if (typeof payload !== "string" || !payload.trim() || (ui.meta?.qrPayload !== undefined && ui.meta.qrPayload !== payload))
      return receiptRenderFailure("qr_missing", "No matching confirmed QR payload was returned.");
    verifiedBookingId = bookingId;
    const src = await generateQr(payload);
    if (!isCurrent()) return changed();
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)) return receiptRenderFailure("display_failed", "The QR image could not be prepared.", verifiedBookingId);
    await render({
      type: "qr",
      ...(ui.title ? { title: ui.title } : {}),
      items: [booking],
      meta: { qrPayload: payload, receiptLookup: true, preparedQr: { payload, src } satisfies PreparedReceiptQr },
    });
    if (!isCurrent()) return changed();
    return { ok: true as const, rendered: true as const, bookingId };
  } catch {
    if (!isCurrent()) return changed();
    return verifiedBookingId
      ? receiptRenderFailure("display_failed", "The QR code could not be displayed.", verifiedBookingId)
      : receiptRenderFailure("lookup_failed", "The verified receipt could not be retrieved.");
  }
}
