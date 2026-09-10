import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Customer } from "../lib/api";
import { AccountPanel } from "./AccountPanel";
import { Cards, cardConfirmationId, chooseShowtime, confirmedQrPayload, createTicketQr, refundChoiceCommand, routeAction, seatPlanCommand, type CardActions } from "./Cards";

const act: CardActions = { say: () => undefined, command: async () => ({ ok: true }), openLink: () => undefined, playTrailer: () => undefined };

describe("concierge decision cards", () => {
  it("binds confirm and decline to the displayed confirmation without triggering a payment", async () => {
    const decisions: unknown[] = [];
    const commands: unknown[] = [];
    const messages: string[] = [];
    const actions: CardActions = { ...act, decision: (decision) => { decisions.push(decision); }, command: async (command) => { commands.push(command); return { ok: true }; }, say: (message) => { messages.push(message); } };
    const ui = { type: "booking", meta: { confirmationId: "confirm-card-A" }, items: [{ filmTitle: "The Journey", bookingId: "BOOK-A" }], actions: [{ value: "confirm:confirm-card-A", label: "Confirm exchange" }, { value: "abort", label: "Keep original" }] };
    await routeAction("confirm:confirm-card-A", "Confirm exchange", actions, "en", ui);
    await routeAction("abort", "Keep original", actions, "en", ui);
    await routeAction("confirm:confirm-card-B", "Confirm another", actions, "en", ui);
    expect(decisions).toEqual([{ confirmationId: "confirm-card-A", confirmed: true, summary: "The Journey" }, { confirmationId: "confirm-card-A", confirmed: false, summary: "The Journey" }]);
    expect(commands.every((command: any) => command.type === "card.action")).toBe(true);
    expect(messages).toEqual([]);
  });

  it("uses exact-ID fallback and refuses ambiguous or missing confirmation bindings", () => {
    const messages: string[] = [];
    routeAction("confirm:review-123", "Confirm", { ...act, say: (message) => { messages.push(message); } }, "en");
    expect(messages).toEqual(["I confirm request review-123. Go ahead."]);
    expect(cardConfirmationId("abort", { type: "booking", items: [], actions: [{ value: "confirm:a", label: "A" }] })).toBe("a");
    expect(cardConfirmationId("abort", { type: "booking", items: [], actions: [{ value: "confirm:a", label: "A" }, { value: "confirm:b", label: "B" }] })).toBeUndefined();
    expect(cardConfirmationId("confirm:unlisted", { type: "booking", items: [] })).toBeUndefined();
    expect(cardConfirmationId("confirm:")).toBeUndefined();
    expect(cardConfirmationId("abort")).toBeUndefined();
  });

  it("keeps a swap showtime selection in its exact existing booking and only requests a preview", async () => {
    const commands: unknown[] = [];
    const messages: string[] = [];
    const actions: CardActions = { ...act, command: async (command) => { commands.push(command); return { ok: true }; }, say: (message) => { messages.push(message); } };
    const ui = { type: "showtimes", items: [{ sessionKey: "cinema-target" }], meta: { journey: "swap", bookingId: "BOOK-ORIGINAL" } };
    await chooseShowtime("cinema-target", ui, actions, "en");
    await routeAction("swap-choice:BOOK-ORIGINAL:cinema-target", "7 PM", actions, "ar", ui);
    await chooseShowtime("guessed-target", ui, actions, "en");
    await chooseShowtime("cinema-target", { ...ui, meta: { journey: "swap" } }, actions, "en");
    await routeAction("swap-choice:OTHER-BOOKING:cinema-target", "7 PM", actions, "en", ui);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe("Review swapping booking BOOK-ORIGINAL to showtime cinema-target; keep the original booking until I confirm the exchange.");
    expect(messages[1]).toContain("BOOK-ORIGINAL");
    expect(messages[1]).toContain("cinema-target");
    expect(commands.every((command: any) => command.type === "card.action")).toBe(true);
    await chooseShowtime("cinema-target", { type: "showtimes", items: ui.items }, actions, "en");
    expect(commands.at(-1)).toEqual({ type: "booking.select", sessionKey: "cinema-target" });
  });

  it("displays backend reprice amounts and destination before a separate offer-switch consent", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "payment_switch", items: [{ currentTotalCents: 9050, totalAfterCents: 12550, removedOfferIds: ["BANK-VERIFIED"], nextPaymentMethod: "VOX_CREDIT" }], meta: { confirmationId: "switch-1" }, actions: [{ value: "confirm:switch-1", label: "Remove offer and switch" }, { value: "abort", label: "Keep bank offer" }] }} />);
    for (const text of ["Current total", "AED 90.50", "AED 125.50", "VOX Credit", "BANK-VERIFIED", "Payment is reviewed and confirmed separately", "Remove offer and switch"]) expect(html).toContain(text);
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain("Pay now");
  });

  it("does not invent a zero total when a switch preview amount is missing", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "payment_switch", items: [{ nextPaymentMethod: "SHARE_POINTS" }] }} />);
    expect(html).toContain("SHARE Points");
    expect(html).not.toContain("AED");
    expect(html).not.toContain("Current total");
  });

  it("shows candidate bookings without claiming the reported debit matched or presenting their QR", async () => {
    const ui = { type: "payment_investigation", items: [{ bookingFound: false, needs: "booking_selection", nextStep: "choose_booking", candidateBookings: [{ bookingId: "BOOK-CANDIDATE", filmTitle: "The Journey", cinemaName: "Mall of the Emirates", showtimeLabel: "Friday 7 PM", seats: "G8, G9", total: "AED 100", qrPayload: "actual-but-not-yet-matched-qr" }] }] };
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={ui} />);
    for (const text of ["Possible bookings to check", "not been matched to the reported debit", "The Journey", "Check booking BOOK-CANDIDATE"]) expect(html).toContain(text);
    for (const text of ["Booking located", "Booking confirmed", "Download QR", "actual-but-not-yet-matched-qr"]) expect(html).not.toContain(text);
    const messages: string[] = [];
    await routeAction("investigation:booking:BOOK-CANDIDATE", "", { ...act, say: (message) => { messages.push(message); } }, "en");
    expect(messages).toEqual(["Check booking BOOK-CANDIDATE for that payment"]);
  });

  it("carries the signed refund choice proof unchanged and rejects malformed proofs", () => {
    expect(refundChoiceCommand({ bookingId: "BOOK-A", ticketIds: ["ticket-2"], refundChoiceProof: "opaque.signed.proof" }, "VOX_CREDIT")).toEqual({ type: "refund.choose", bookingId: "BOOK-A", refundMethod: "VOX_CREDIT", ticketIds: ["ticket-2"], refundChoiceProof: "opaque.signed.proof" });
    expect(refundChoiceCommand({ bookingId: "BOOK-A", refundChoiceProof: {} }, "VOX_CREDIT")).toBeUndefined();
    expect(refundChoiceCommand({ bookingId: "BOOK-A", refundChoiceProof: "" }, "VOX_CREDIT")).toBeUndefined();
  });

  it("displays the exact refund timing, destination and validity in the final review", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "booking", meta: { confirmationId: "refund-1" }, items: [{ bookingId: "BOOK-A", refund: { amountCents: 10000, method: "ORIGINAL_PAYMENT", cardLast4: "6789", eta: "5–10 days", validityDays: 90 } }] }} />);
    for (const text of ["AED 100", "Original payment method", "6789", "5–10 days", "90 days"]) expect(html).toContain(text);
  });

  it.each([{ differenceCents: 2000, chargeCents: 2000, refundCents: 0, newTotalCents: 12000, expected: "Extra amount to pay" }, { differenceCents: -2000, chargeCents: 0, refundCents: 2000, newTotalCents: 8000, expected: "Refund timing" }, { differenceCents: 0, chargeCents: 0, refundCents: 0, newTotalCents: 10000, expected: "No extra charge or refund" }])("shows actual exchange settlement and target choices: $differenceCents cents", (financial) => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "booking", meta: { confirmationId: "exchange-1" }, items: [{ bookingId: "BOOK-A", swapTo: { ...financial, originalTotalCents: 10000, showtimeLabel: "Saturday 6 PM", cinemaName: "Mall of the Emirates", experience: "MAX", seats: ["J8", "J9"], concessions: [{ quantity: 1, description: "Salted popcorn" }], paymentMethod: "CARD", refundMethod: "ORIGINAL_PAYMENT", cardLast4: "4321", refundEta: "5–10 days to the same original card" } }] }} />);
    for (const text of ["Original total", "New total", "J8, J9", "1× Salted popcorn", "Saturday 6 PM", financial.expected]) expect(html).toContain(text);
    if (financial.differenceCents !== 0) { expect(html).toContain("AED 20"); expect(html).toContain("4321"); }
    if (financial.differenceCents >= 0) expect(html).not.toContain("5–10 days");
  });

  it("never substitutes a booking reference or brand text for a missing confirmed QR payload", () => {
    expect(confirmedQrPayload(undefined, { qrPayload: undefined })).toBeUndefined();
    expect(confirmedQrPayload("", { qrPayload: "older-ticket" })).toBeUndefined();
    expect(confirmedQrPayload("  ", {})).toBeUndefined();
    expect(confirmedQrPayload(42, {})).toBeUndefined();
    expect(confirmedQrPayload("verified-new-payload", { qrPayload: "older-ticket" })).toBe("verified-new-payload");
    expect(confirmedQrPayload(undefined, { qrPayload: "verified-ticket-payload" })).toBe("verified-ticket-payload");
  });

  it("creates a real PNG for the confirmed QR and rejects an empty payload", async () => {
    const png = await createTicketQr("CONFIRMED:QR:W4PU9V6");
    const other = await createTicketQr("CONFIRMED:QR:W9SH6AR");
    expect(png).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(png).not.toBe(other);
    await expect(createTicketQr(" ")).rejects.toThrow("confirmed QR payload");
  });

  it("keeps the receipt, actual amount and reference together without invented fulfilment claims or purchase date", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "qr", items: [{ bookingId: "W4PU9V6", filmTitle: "The Journey", cinemaName: "Mall of the Emirates", showtimeLabel: "Friday, 7 PM", seats: "D8, D9", totalCents: 16200 }] }} />);
    for (const value of ["Booking confirmed", "W4PU9V6", "The Journey", "D8, D9", "AED 162", "QR code isn&#x27;t available"]) expect(html).toContain(value);
    expect(html).not.toContain("emailed");
    expect(html).not.toContain("Prepare my order");
    expect(html).not.toContain("Purchase date");
    expect(html).not.toContain('download=');
    expect(html).not.toContain('alt="QR"');
  });

  it("makes a priced proposal visibly unheld and does not attach a countdown", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "booking_proposal", meta: { proposalToken: "signed-proposal" }, items: [{ filmTitle: "The Journey", ticketQuantity: 2, selectedSeats: [{ row: "G", number: "8" }, { row: "G", number: "9" }], totalCents: 10000, priceIncludesFees: true, held: false }] }} />);
    expect(html).toContain("No seats held yet");
    expect(html).toContain("G8, G9");
    expect(html).toContain("AED 100");
    expect(html).toContain("Includes booking fees");
    expect(html).not.toContain('class="hold');
    expect(html).not.toMatch(/disabled=""[^>]*>Hold these seats/);
  });

  it("requires a verified proposal token, quantity and price before accepting", () => {
    for (const [meta, proposal] of [[{}, { ticketQuantity: 2, totalCents: 10000 }], [{ proposalToken: "signed" }, { ticketQuantity: null, totalCents: 10000 }], [{ proposalToken: "signed" }, { ticketQuantity: 2, totalCents: null }]] as const) {
      const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "booking_proposal", meta, items: [proposal] }} />);
      expect(html).toMatch(/disabled=""[^>]*>Hold these seats/);
    }
  });

  it("shows refund destinations and returned processing terms without claiming refund completion", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "refund_options", items: [{ method: "ORIGINAL_PAYMENT", amountCents: 9000, eta: "5–7 working days", cardLast4: "1234" }, { method: "VOX_CREDIT", amountCents: 9000, eta: "Immediately after confirmation", validityDays: 365 }] }} />);
    expect(html).toContain("Original payment method");
    expect(html).toContain("VOX Credit");
    expect(html).toContain("5–7 working days");
    expect(html).toContain("1234");
    expect(html).toContain("Valid for 365 days");
    expect(html).not.toContain("Refund completed");
  });

  it("preserves the exact refund booking and selected tickets in a direct review command", () => {
    expect(refundChoiceCommand({ bookingId: "W4PU9V6", ticketIds: ["ticket-2", "ticket-4"] }, "ORIGINAL_PAYMENT")).toEqual({ type: "refund.choose", bookingId: "W4PU9V6", refundMethod: "ORIGINAL_PAYMENT", ticketIds: ["ticket-2", "ticket-4"] });
    expect(refundChoiceCommand({ bookingId: "W4PU9V6" }, "SHARE_POINTS")).toEqual({ type: "refund.choose", bookingId: "W4PU9V6", refundMethod: "SHARE_POINTS" });
    expect(refundChoiceCommand({}, "ORIGINAL_PAYMENT")).toBeUndefined();
    expect(refundChoiceCommand({ bookingId: "W4PU9V6", ticketIds: "ticket-2" }, "ORIGINAL_PAYMENT")).toBeUndefined();
    expect(refundChoiceCommand({ bookingId: "W4PU9V6" }, "OTHER_CARD")).toBeUndefined();
  });

  it("separates an unverified payment report from an actual confirmed booking", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "payment_investigation", items: [{ status: "unresolved", bookingFound: false, investigationId: "inv-123", reportedTransactionReference: "bank-456", reportedCardLast4: "1234", transactionReferenceVerified: false, nextStep: "offer_handover", bookings: [], retryPaymentAllowed: false }] }} />);
    expect(html).toContain("No confirmed booking found");
    expect(html).toContain("This transaction reference has not been verified");
    expect(html).toContain("bank-456");
    expect(html).toContain("Customer Care");
    expect(html).not.toContain("offer_handover");
    expect(html).not.toContain("Booking confirmed");
    expect(html).not.toContain("Pay now");
  });
  it("opens the card's verified seat map directly in either language without asking the agent", async () => {
    const commands: Record<string, unknown>[] = [];
    const messages: string[] = [];
    const actions: CardActions = { ...act, command: async (command) => { commands.push(command); return { ok: true }; }, say: (message) => { messages.push(message); } };
    const ui = { type: "order", meta: { sessionKey: "cinema-current-show", userSessionId: "current-order" }, items: [{ cinemaId: "older-cinema", sessionId: "older-show", userSessionId: "older-order" }] };
    await routeAction("seats:open", "Change seats", actions, "en", ui);
    await routeAction("seatmap:open", "تغيير المقاعد", actions, "ar", ui);
    expect(commands.filter((command) => command.type === "seat.plan")).toEqual([
      { type: "seat.plan", sessionKey: "cinema-current-show", userSessionId: "current-order" },
      { type: "seat.plan", sessionKey: "cinema-current-show", userSessionId: "current-order" },
    ]);
    expect(messages).toEqual([]);
  });

  it("uses legacy order summary IDs and disables unavailable seat-map controls", () => {
    expect(seatPlanCommand({ type: "order", items: [{ cinemaId: "cinema", sessionId: "show", userSessionId: "held-order" }] }))
      .toEqual({ type: "seat.plan", sessionKey: "cinema-show", userSessionId: "held-order" });
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "order", items: [{ tickets: [], totalCents: 0 }], actions: [{ value: "seats:open", label: "Change seats" }] }} />);
    expect(html).toMatch(/disabled=""[^>]*>Choose seats/);
  });

  it("shows preserved expired booking choices with localized recovery controls and no payment", () => {
    const ui = { type: "order", title: "Your booking", meta: { expired: true }, items: [{ filmTitle: "The Journey", cinemaName: "Mall of the Emirates", showtime: "2026-09-12T19:15:00", tickets: [{ seat: "G8" }, { seat: "G9" }], concessions: [{ quantity: 1, description: "Popcorn" }], totalCents: 14000 }], actions: [{ label: "Check seats again", value: "recover:confirm" }, { label: "Another show", value: "booking:restart" }, { label: "Pay now", value: "pay:start" }, { label: "Edit seats", value: "seats:open" }] };
    const en = renderToStaticMarkup(<Cards lang="en" act={act} ui={ui} />);
    const ar = renderToStaticMarkup(<Cards lang="ar" act={act} ui={ui} />);
    for (const html of [en, ar]) { expect(html).toContain("The Journey"); expect(html).toContain("Mall of the Emirates"); expect(html).toContain("G8, G9"); expect(html).toContain("Popcorn"); expect(html.match(/<button/g)).toHaveLength(2); expect(html).not.toContain("Pay now"); expect(html).not.toContain("Edit seats"); }
    expect(en).toContain("Previous total");
    expect(en).toContain("Check and hold seats again");
    expect(ar).toContain("الإجمالي السابق");
    expect(ar).toContain("تحقق واحجز المقاعد مجدداً");
    expect(ar).toContain("عرض آخر");
    expect(ar).not.toContain("Another show");
  });

  it("renders a complete recommendation reason when the backend sends a string", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "recommendation", items: [{ hoCode: "one", title: "The Journey", why: "An English thriller for your evening." }] }} />);
    expect(html).toContain("An English thriller for your evening.");
  });

  it("shows showtimes without repeating a movie poster or synopsis", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "showtimes", title: "Showtimes", meta: { film: { title: "The Journey", posterUrl: "https://example.com/poster.jpg", heroUrl: "https://example.com/hero.jpg", rating: "PG13" } }, items: [{ sessionKey: "one", date: "2026-09-11", dateLabel: "Tomorrow", time: "7:15 PM", cinemaName: "Mall of the Emirates", experience: "MAX", seatsAvailable: 40 }] }} />);
    expect(html).toContain("The Journey");
    expect(html).toContain("7:15 PM");
    expect(html).toContain("Tomorrow");
    expect(html).not.toContain("poster.jpg");
    expect(html).not.toContain("hero.jpg");
    expect(html).not.toContain("PG13");
  });

  it("keeps equal-film showtimes from different cinemas in separate groups", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "showtimes", items: [
      { sessionKey: "one", date: "2026-09-11", time: "7:15 PM", cinemaName: "Mall of the Emirates", filmTitle: "The Journey", experience: "MAX" },
      { sessionKey: "two", date: "2026-09-11", time: "8:15 PM", cinemaName: "City Centre Mirdif", filmTitle: "The Journey", experience: "STANDARD" },
    ] }} />);
    expect(html.match(/class="showgroup"/g)).toHaveLength(2);
    expect(html).toContain("City Centre Mirdif");
  });

  it("starts a personalized recommendation with one film and offers alternatives", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "recommendation", items: [{ hoCode: "one", title: "First choice", language: "Tamil" }, { hoCode: "two", title: "Second choice", language: "Tamil" }] }} />);
    expect(html).toContain("First choice");
    expect(html).not.toContain("Second choice");
    expect(html).toContain("Other options");
    expect(html).not.toContain("hscroll");
  });

  it("does not default an unknown ticket quantity to one", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "quantity", meta: { sessionKey: "one" }, items: [] }} />);
    expect(html).toContain("How many are going?");
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toMatch(/disabled=""[^>]*>Find seats/);
  });

  it("requires all requested seats before confirming and labels every seat", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "seatmap", meta: { ticketCount: 2, columnCount: 2, userSessionId: "held" }, items: [{ row: "G", rowIndex: 6, areaCategoryCode: "regular", seats: [{ col: 0, id: "1", status: 2 }, { col: 1, id: "2", status: 0 }] }] }} />);
    expect(html).toContain('aria-label="G1');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/disabled=""[^>]*>Confirm seats/);
  });

  it("starts the food decision with a small selection and deeper browsing", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ itemId: String(i), name: `Snack ${i}`, price: "AED 10" }));
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "menu", items }} />);
    expect(html.match(/class="fnbcard"/g)).toHaveLength(4);
    expect(html).toContain("Browse menu");
    expect(html).toContain("Continue to checkout");
  });

  it("keeps wallet payment review on its explicit confirmation step", () => {
    const html = renderToStaticMarkup(<Cards lang="en" act={act} ui={{ type: "payment", meta: { requiresSheet: false, method: "VOX_CREDIT" }, items: [{ filmTitle: "The Journey", tickets: [], totalCents: 8000 }], actions: [{ label: "Confirm payment", value: "confirm:wallet", style: "primary" }] }} />);
    expect(html).toContain("Confirm payment");
    expect(html).not.toContain("Food &amp; drinks");
    expect(html).not.toContain("Credit and Debit Cards");
  });
});

describe("account experience", () => {
  it("provides only email and password credentials with no demo credential hints", () => {
    const html = renderToStaticMarkup(<AccountPanel lang="en" customer={null} onLogin={async () => undefined} onLogout={async () => undefined} onClose={() => undefined} />);
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("PIN");
    expect(html).not.toContain("member id");
    expect(html).not.toContain("mobile");
  });

  it("shows separate history-derived weekday and weekend preferences", () => {
    const customer: Customer = { id: "rahul", firstName: "Rahul", lastName: "Sharma", memberId: "one", tier: "gold", sharePoints: 500, voxCreditCents: 2000, profile: { movieLanguage: "Tamil", cinemaId: "one", cinemaName: "Burjuman", weekday: { from: "19:00", to: "21:00", around: "20:00", sampleCount: 4 }, weekend: { from: "15:00", to: "17:00", around: "16:00", sampleCount: 5 }, seatPreference: "back", historyCount: 9, timeZone: "Asia/Dubai", weekendDays: [6, 0] } };
    const html = renderToStaticMarkup(<AccountPanel lang="en" customer={customer} onLogin={async () => undefined} onLogout={async () => undefined} onClose={() => undefined} />);
    expect(html).toContain("Tamil");
    expect(html).toContain("Burjuman");
    expect(html).toContain("Weekdays");
    expect(html).toContain("Weekends");
    expect(html).toContain("Your cinema visits");
    expect(html).not.toContain("sampleCount");
  });
});
