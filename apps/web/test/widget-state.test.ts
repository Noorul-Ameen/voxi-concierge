import { describe, expect, it } from "vitest";
import { acceptWidgetEvent, actionContext, appendTranscript, decisionSummary, directSeatMapFeedback, holdSeconds, recordUserActivity, renderVerifiedSeatMap, uiActionLabel, type TranscriptItem } from "../src/lib/widget-state";

describe("authoritative widget state", () => {
  it("preserves the exact refund confirmation and proposed choices without exposing signed proofs", () => {
    const context = JSON.parse(actionContext("refund.choose", { ok: true, data: { confirmationId: "confirmation-123", summary: { refundCents: 4500, refundMethod: "original", refundChoiceProof: "PRIVATE-PROOF" }, proposal: { filmTitle: "Selected film", proposalToken: "PRIVATE-TOKEN", held: false } } }));
    expect(context.state.confirmationId).toBe("confirmation-123");
    expect(context.state.summary).toEqual({ refundCents: 4500, refundMethod: "original" });
    expect(context.state.proposal).toEqual({ filmTitle: "Selected film", held: false });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  });
  it("acknowledges a successful direct map without requesting another map or booking change", () => {
    const feedback = directSeatMapFeedback("seat.plan", { ok: true, ui: { type: "seatmap", items: [] } }, "en", true, true);
    expect(feedback?.text).toContain("Seat map ready");
    expect(JSON.parse(feedback!.context!)).toMatchObject({ action: "seat_map_opened", succeeded: true, rendered: true, bookingChanged: false });
    expect(JSON.parse(feedback!.context!).instruction).toContain("without calling tools, reopening the map or changing/holding seats");
    // The agent-invoked client tool already produces its own response; it gets no second acknowledgement.
    expect(directSeatMapFeedback("render_seat_map", { ok: true, ui: { type: "seatmap", items: [] } }, "en", true, true)).toBeUndefined();
  });

  it("gives localized UI feedback while disconnected without an agent message or reconnect request", () => {
    const feedback = directSeatMapFeedback("seat.plan", { ok: true, ui: { type: "seatmap", items: [] } }, "ar", false, true);
    expect(feedback).toEqual({ text: "خريطة المقاعد جاهزة. يمكنك الآن اختيار مقاعدك.", context: undefined });
  });

  it("does not announce a map for failed responses, wrong UI or a stale account", () => {
    expect(directSeatMapFeedback("seat.plan", { ok: false, error: "Unavailable" }, "en", true, true)).toBeUndefined();
    expect(directSeatMapFeedback("seat.plan", { ok: true, ui: { type: "order", items: [] } }, "en", true, true)).toBeUndefined();
    expect(directSeatMapFeedback("seat.plan", { ok: true, ui: { type: "seatmap", items: [] } }, "en", true, false)).toBeUndefined();
  });

  it("reports seat-map success only after the awaited verified map renders", async () => {
    let resolve!: (result: { ok: boolean; ui: { type: string; items: [] } }) => void;
    const pending = new Promise<{ ok: boolean; ui: { type: string; items: [] } }>((done) => { resolve = done; });
    const rendered: string[] = [];
    let finished = false;
    const result = renderVerifiedSeatMap(() => pending, (ui) => { rendered.push(ui.type); }, () => true).then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(rendered).toEqual([]);
    resolve({ ok: true, ui: { type: "seatmap", items: [] } });
    expect(await result).toEqual({ ok: true, rendered: true });
    expect(rendered).toEqual(["seatmap"]);
  });

  it("never claims a seat map opened after backend failure, wrong UI, network loss or account change", async () => {
    const rendered: string[] = [];
    const render = (ui: { type: string }) => { rendered.push(ui.type); };
    const failed = await renderVerifiedSeatMap(async () => ({ ok: false, error: "Seat hold expired" }), render, () => true);
    expect(failed).toEqual({ ok: false, rendered: false, error: "Seat hold expired" });
    expect(await renderVerifiedSeatMap(async () => ({ ok: true, ui: { type: "order", items: [] } }), render, () => true)).toMatchObject({ ok: false, rendered: false });
    expect(await renderVerifiedSeatMap(async () => { throw new Error("network"); }, render, () => true)).toMatchObject({ ok: false, rendered: false });
    expect(await renderVerifiedSeatMap(async () => ({ ok: true, ui: { type: "seatmap", items: [] } }), render, () => false)).toMatchObject({ ok: false, rendered: false });
    expect(rendered).toEqual([]);
  });

  it("keeps activity current during wheel/input bursts while throttling provider pings", () => {
    const clock = { lastUserAt: 0, lastProviderPingAt: Number.NEGATIVE_INFINITY };
    const pings: number[] = [];
    // Pointer, focus, keyboard, wheel and input can overlap within the same second.
    for (const now of [100, 100, 350, 999, 1100, 1400]) {
      recordUserActivity(clock, () => pings.push(now), now);
      expect(clock.lastUserAt).toBe(now);
    }
    expect(pings).toEqual([100, 1100]);
    expect(181399 - clock.lastUserAt).toBeLessThan(180000);
    expect(181400 - clock.lastUserAt).toBe(180000);
  });

  it("tracks disconnected customer activity without suppressing the first connected ping", () => {
    const clock = { lastUserAt: 0, lastProviderPingAt: Number.NEGATIVE_INFINITY };
    recordUserActivity(clock, undefined, 500);
    expect(clock.lastUserAt).toBe(500);
    let pings = 0;
    recordUserActivity(clock, () => { pings++; }, 510);
    expect(pings).toBe(1);
    expect(clock.lastUserAt).toBe(510);
  });

  it("does not replay old cards or hold updates across reconnects but accepts new target results", () => {
    const sequences = new Map<string, number>();
    const identities = new Set<string>();
    const oldCard = { type: "ui.render" as const, seq: 8, eventId: "original-card", ui: { type: "order", items: [] } };
    const oldHold = { type: "order.updated" as const, seq: 9, eventId: "original-hold", userSessionId: "hold", summary: { expiresAtUtc: "2026-09-10T10:00:00Z" } };
    expect(acceptWidgetEvent(sequences, identities, "first", oldCard)).toBe(true);
    expect(acceptWidgetEvent(sequences, identities, "first", oldHold)).toBe(true);
    // An agent may create a new target card before the link imports old history.
    expect(acceptWidgetEvent(sequences, identities, "second", { ...oldCard, seq: 1, eventId: "early-target-card" })).toBe(true);
    expect(acceptWidgetEvent(sequences, identities, "second", { ...oldCard, seq: 2 })).toBe(false);
    expect(acceptWidgetEvent(sequences, identities, "second", { ...oldHold, seq: 3 })).toBe(false);
    expect(sequences.get("second")).toBe(3);
    expect(acceptWidgetEvent(sequences, identities, "second", { ...oldHold, seq: 4, eventId: "new-hold" })).toBe(true);
    // A later reconnect preserves the same identity even though its sequence changes again.
    expect(acceptWidgetEvent(sequences, identities, "third", { ...oldCard, seq: 1 })).toBe(false);
    expect(acceptWidgetEvent(sequences, identities, "third", { ...oldCard, seq: 2, eventId: "new-request-same-card" })).toBe(true);
  });

  it("summarizes the show actually selected when prior showtime choices collapse", () => {
    const options: TranscriptItem = { id: "shows", kind: "cards", ui: { type: "showtimes", items: [{ sessionKey: "private-one", filmTitle: "Early Movie", cinemaName: "Other cinema", time: "2 PM" }, { sessionKey: "private-two", filmTitle: "The Journey", cinemaName: "Mall of the Emirates", time: "7:15 PM" }] } };
    const progressed = appendTranscript([options], { id: "quantity", kind: "cards", ui: { type: "quantity", items: [], meta: { sessionKey: "private-two" } } });
    const archived = progressed[0];
    expect(archived.kind).toBe("cards");
    if (archived.kind !== "cards") return;
    const text = decisionSummary(archived.ui, "en");
    expect(text).toContain("The Journey"); expect(text).toContain("7:15 PM"); expect(text).not.toContain("Early Movie"); expect(text).not.toContain("private-two");
    const booking = { type: "order", title: "Your booking", items: [{ filmTitle: "The Journey", cinemaName: "Mall of the Emirates", tickets: [{ seat: "G8" }, { seat: "G9" }], userSessionId: "private-order" }] };
    expect(decisionSummary(booking, "en")).toContain("2 tickets · Seats G8, G9");
    expect(decisionSummary(booking, "ar")).toContain("2 تذاكر · المقاعد G8, G9");
    expect(decisionSummary(booking, "en")).not.toContain("private-order");
  });

  it("translates fixed controls after a language switch while preserving dynamic names", () => {
    expect(uiActionLabel("booking:restart", "Another show", "ar")).toBe("عرض آخر");
    expect(uiActionLabel("booking:restart", "عرض آخر", "en")).toBe("Another show");
    expect(uiActionLabel("showtimes:private-film", "The Journey", "ar")).toBe("The Journey");
  });

  const seats: TranscriptItem = { id: "seat-result", kind: "cards", ui: { type: "order", title: "Your seats", items: [], meta: { userSessionId: "a", expiresAtUtc: "2026-09-10T16:00:00Z" } } };
  it("collapses earlier controls but lets a new user request reopen identical choices", () => {
    const payment: TranscriptItem = { id: "payment", kind: "cards", ui: { type: "payment", items: [], meta: { userSessionId: "a" } } };
    const progressed = appendTranscript([seats], payment);
    expect(progressed[0]).toMatchObject({ archived: true });
    const reopened = appendTranscript(progressed, { ...seats, id: "reopened" });
    expect(reopened.at(-1)).toMatchObject({ id: "reopened", ui: seats.ui });
    expect(reopened[1]).toMatchObject({ archived: true });
    expect(reopened.filter((item) => item.kind === "cards" && !item.archived)).toHaveLength(1);
  });
  it("deduplicates duplicate delivery of a currently visible card", () => {
    expect(appendTranscript([seats], { ...seats, id: "duplicate" })).toEqual([seats]);
  });
  it("updates an active order without multiplying cards", () => {
    const changed = { ...seats, id: "update", ui: { ...seats.ui, items: [{ seats: "D5–D6" }] } };
    expect(appendTranscript([seats], changed)).toEqual([{ ...changed, id: seats.id }]);
  });
  it("deduplicates SDK echoes of text typed by the user", () => {
    const message: TranscriptItem = { id: "one", kind: "msg", role: "user", text: "Two tickets" };
    expect(appendTranscript([message], { ...message, id: "echo" })).toEqual([message]);
  });
  it("uses real expiry and stays expired while disconnected", () => {
    expect(holdSeconds("2026-09-10T16:00:00Z", Date.parse("2026-09-10T15:59:30Z"))).toBe(30);
    expect(holdSeconds("2026-09-10T16:00:00Z", Date.parse("2026-09-10T16:05:00Z"))).toBe(0);
    expect(holdSeconds("invalid")).toBeNull();
  });
  it("does not send credentials or payment tokens in action context", () => {
    const context = actionContext("payment.token", { ok: false, action: { status: "queued", type: "pay_order" }, data: { paymentToken: "secret", password: "secret", totalCents: 4000 } });
    expect(context).not.toContain("secret");
    expect(JSON.parse(context)).toMatchObject({ succeeded: false, pending: true, state: { totalCents: 4000 } });
  });
  it("does not describe a queued successful request as a completed payment", () => {
    expect(JSON.parse(actionContext("payment.token", { ok: true, action: { status: "queued", type: "pay_order" } })))
      .toMatchObject({ succeeded: false, pending: true });
  });
  it("removes credentials nested in an otherwise allowed booking summary", () => {
    const context = actionContext("booking.select", { ok: true, data: { summary: { seats: ["G1"], cards: [{ cardToken: "secret-card", last4: "1234" }], customer: { password: "secret-password", email: "private@example.com" } } } });
    expect(context).not.toContain("secret");
    expect(context).not.toContain("private@example.com");
    expect(JSON.parse(context).state.summary.seats).toEqual(["G1"]);
  });
});
