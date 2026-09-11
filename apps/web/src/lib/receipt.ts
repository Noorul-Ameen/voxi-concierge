import type { CommandResult, UiHint } from "./api";

export type PreparedReceiptQr = { payload: string; src: string };

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
  const failed = (error: string) => ({ ok: false as const, rendered: false as const, error });
  const changed = () => failed("The account session changed. Check the booking again.");
  if (!bookingId) return failed("A booking reference is required to display its QR code.");
  if (!isCurrent()) return changed();
  try {
    const result = await load(bookingId);
    if (!isCurrent()) return changed();
    if (!result.ok) return failed(result.error ?? "The verified receipt is not available.");
    const ui = result.ui;
    const booking = ui?.items?.[0];
    if (ui?.type !== "qr" || ui.items.length !== 1 || typeof booking?.bookingId !== "string" || booking.bookingId.trim().toUpperCase() !== bookingId)
      return failed("No verified receipt for that exact booking was returned.");
    if (!["confirmed", "collected"].includes(booking.status)) return failed("That booking has no active admission QR code.");
    const payload = booking.qrPayload;
    if (typeof payload !== "string" || !payload.trim() || (ui.meta?.qrPayload !== undefined && ui.meta.qrPayload !== payload))
      return failed("No matching confirmed QR payload was returned.");
    const src = await generateQr(payload);
    if (!isCurrent()) return changed();
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)) return failed("The QR image could not be prepared.");
    await render({
      type: "qr",
      ...(ui.title ? { title: ui.title } : {}),
      items: [booking],
      meta: { qrPayload: payload, receiptLookup: true, preparedQr: { payload, src } satisfies PreparedReceiptQr },
    });
    if (!isCurrent()) return changed();
    return { ok: true as const, rendered: true as const, bookingId };
  } catch {
    return failed("The QR code could not be displayed. Please try again.");
  }
}
