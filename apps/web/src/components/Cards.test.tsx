import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Customer } from "../lib/api";
import { AccountPanel } from "./AccountPanel";
import { Cards, type CardActions } from "./Cards";

const act: CardActions = { say: () => undefined, command: async () => ({ ok: true }), openLink: () => undefined, playTrailer: () => undefined };

describe("concierge decision cards", () => {
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
