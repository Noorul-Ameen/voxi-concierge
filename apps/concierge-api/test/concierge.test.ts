import { nowLocalIso } from "@voxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

const conv = (s: string) => `conv_${s}_${Date.now().toString(36)}`;

describe("Phase 1 — information", () => {
  it("searches films and resolves fuzzy titles", async () => {
    const r = await h.tool("search_films", conv("f1"), { query: "spider man" });
    expect(r.ok).toBe(true);
    expect(r.data.films[0].title).toMatch(/Spider-Man/);
    expect(r.speech).toMatch(/Spider-Man/);
    expect(r.ui.type).toBe("movie");
  });
  it("accepts a film-language filter without breaking the conversation context (regression)", async () => {
    const r = await h.tool("search_films", conv("f3"), {
      language: "Tamil",
      status: "now_showing",
      limit: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.data.films.length).toBeGreaterThan(0);
    expect(r.data.films.every((f: any) => /Tamil/i.test(f.language))).toBe(true);
    expect(r.speech).not.toMatch(/undefined/);
  });
  it("treats 'Dubai' as an emirate and a language code as a film language when searching sessions", async () => {
    const f = await h.tool("search_films", conv("f4"), { language: "ta", status: "now_showing", limit: 1 });
    expect(f.ok).toBe(true);
    const r = await h.tool("search_sessions", conv("f4"), {
      title: f.data.films[0].title,
      cinemaName: "Dubai",
      date: "weekend",
      language: "ta",
    });
    expect(r.ok).toBe(true);
    expect(r.speech).not.toMatch(/don't recognise|other languages/);
  });
  it("never offers child tickets for an 18+ film", async () => {
    const f = await h.tool("search_films", conv("f5"), { rating: "18+", status: "now_showing", limit: 1 });
    if (!f.ok || !f.data.films.length) return;
    const s = await h.tool("search_sessions", conv("f5"), {
      title: f.data.films[0].title,
      dateTo: "next sunday",
    });
    if (!s.ok || !s.data.sessions.length) return;
    const tt = await h.tool("get_ticket_types", conv("f5"), { sessionKey: s.data.sessions[0].sessionKey });
    expect(tt.ok).toBe(true);
    expect(tt.data.ticketTypes.some((x: any) => x.isChild)).toBe(false);
    expect(tt.speech).toMatch(/adults only/);
  });
  it("filters films by child age", async () => {
    const r = await h.tool("search_films", conv("f2"), { maxAge: 10, limit: 20 });
    expect(r.data.films.every((f: any) => !/^(15\+|18\+|18TC|21\+)$/.test(f.rating))).toBe(true);
  });
  it("finds showtimes at a cinema by spoken alias and suggests alternatives", async () => {
    const r = await h.tool("search_sessions", conv("s1"), {
      title: "spider-man",
      cinemaName: "MOE",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
    });
    expect(r.ok).toBe(true);
    expect(r.data.sessions.length).toBeGreaterThan(0);
    expect(r.data.sessions[0].cinemaId).toBe("0002");
    const none = await h.tool("search_sessions", conv("s2"), {
      title: "spider-man",
      cinemaName: "Mall of the Emirates",
      timeFrom: "03:00",
      timeTo: "03:30",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
    });
    expect(none.ok).toBe(true);
    expect(none.data.relaxed).toBeTruthy();
  });
  it("nearest cinemas and cinema details incl. in-mall directions", async () => {
    const n = await h.tool("nearest_cinemas", conv("c1"), { lat: 25.1181, lng: 55.2004 });
    expect(n.data.cinemas[0].cinemaId).toBe("0002");
    const d = await h.tool("get_cinema", conv("c2"), { name: "Deira City Centre" });
    expect(d.data.cinema.cinemaId).toBe("0001");
    expect(d.data.cinema.directions).toMatch(/Level 2/);
  });
  it("age rules verdicts", async () => {
    const r = await h.tool("get_age_rules", conv("a1"), { rating: "18+", childAge: 12 });
    expect(r.data.verdict).toMatch(/No/);
    const r2 = await h.tool("get_age_rules", conv("a2"), { rating: "PG13", childAge: 10 });
    expect(r2.data.verdict).toMatch(/accompanied/);
  });
  it("lists offers with eligibility", async () => {
    const r = await h.tool("list_offers", conv("o1"), { experience: "MAX" });
    expect(r.data.offers.length).toBeGreaterThan(0);
    expect(r.data.offers.some((o: any) => o.type === "bank")).toBe(true);
  });
});

describe("Phase 1 — booking lookup, cancellation, refund", () => {
  it("finds by reference, phone and email with eligibility", async () => {
    const byRef = await h.tool("find_booking", conv("b1"), { bookingId: "vxa7k2m" });
    expect(byRef.data.bookings[0].bookingId).toBe("VXA7K2M");
    expect(byRef.data.bookings[0].eligibility.eligible).toBe(true);
    const cutoff = await h.tool("find_booking", conv("b2"), { bookingId: "RM3PQ9X" });
    expect(cutoff.data.bookings[0].eligibility.code).toBe("CUTOFF_PASSED");
    const bank = await h.tool("check_cancellation_eligibility", conv("b3"), { bookingId: "RMB0GO1" });
    expect(bank.data.eligibility.eligible).toBe(false);
    expect(bank.speech).toMatch(/bank/i);
    const collected = await h.tool("check_cancellation_eligibility", conv("b4"), { bookingId: "OK4DXC0" });
    expect(collected.data.eligibility.code).toBe("TICKETS_USED");
  });
  it("requires guest verification, then cancels with confirmation and refunds to VOX credit; duplicates are idempotent", async () => {
    const c = conv("cancel");
    const denied = await h.tool("prepare_cancellation", c, { bookingId: "VXA7K2M" });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("VERIFICATION_REQUIRED");
    const prep = await h.tool("prepare_cancellation", c, {
      bookingId: "VXA7K2M",
      refundMethod: "VOX_CREDIT",
      verification: { phoneLast4: "4567" },
    });
    expect(prep.ok).toBe(true);
    expect(prep.speech).toMatch(/To confirm/);
    const confirmationId = prep.data.confirmationId;
    // no confirmation → rejected
    const bad = await h.tool("cancel_booking", c, {
      bookingId: "VXA7K2M",
      confirmationId: "cnf_nope",
      confirmed: true,
    });
    expect(bad.ok).toBe(false);
    // 8 concurrent identical confirmations → exactly one action, one refund
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.tool("cancel_booking", c, { bookingId: "VXA7K2M", confirmationId, confirmed: true }),
      ),
    );
    const okOnes = results.filter((r) => r.ok);
    expect(okOnes.length).toBeGreaterThanOrEqual(1);
    const actionIds = new Set(results.map((r) => r.data?.action?.actionId).filter(Boolean));
    expect(actionIds.size).toBe(1);
    const final = await h.tool("get_action_result", c, { actionId: [...actionIds][0], waitMs: 8000 });
    expect(final.data.action.status).toBe("succeeded");
    expect(final.speech).toMatch(/cancelled/);
    const after = await h.tool("find_booking", c, { bookingId: "VXA7K2M", upcomingOnly: false });
    expect(after.data.bookings[0].status).toBe("refunded");
    const bal = await h.ctx.vista.balances("SHR100234");
    expect(bal.Balances.find((b) => b.BalanceTypeId === "VOX_REWARDS")!.ValueCents).toBeGreaterThan(12000);
    // cancelling again is a clean conflict, not a second refund
    const prep2 = await h.tool("prepare_cancellation", c, {
      bookingId: "VXA7K2M",
      verification: { phoneLast4: "4567" },
    });
    expect(prep2.ok).toBe(false);
    expect(prep2.error.code).toBe("BOOKING_ALREADY_CANCELLED");
  });
  it("partial cancellation keeps F&B and refunds proportionally", async () => {
    const c = conv("partial");
    const prep = await h.tool("prepare_cancellation", c, {
      bookingId: "OKGRP33",
      ticketIds: ["1"],
      refundMethod: "SHARE_POINTS",
      verification: { email: "omar.khan@example.com" },
    });
    expect(prep.ok).toBe(true);
    expect(prep.data.summary.partial).toBe(true);
    const r = await h.tool("cancel_booking", c, {
      bookingId: "OKGRP33",
      confirmationId: prep.data.confirmationId,
      confirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.action.status).toBe("succeeded");
    const after = await h.tool("find_booking", c, { bookingId: "OKGRP33", upcomingOnly: false });
    expect(after.data.bookings[0].status).toBe("partially_refunded");
    expect(after.data.bookings[0].concessions.length).toBe(1);
  });
});

describe("Phase 1 — swaps", () => {
  it("swaps to another showtime of the same film (saga) and links bookings", async () => {
    const c = conv("swap");
    const login = await h.tool("login_customer", c, { email: "james.whitfield@example.com", pin: "9876" });
    expect(login.ok).toBe(true);
    const b = (await h.tool("find_booking", c, { bookingId: "JWG0LD7" })).data.bookings[0];
    const alts = await h.tool("search_sessions", c, {
      hoCode: b.tickets ? undefined : undefined,
      title: b.filmTitle,
      experience: "GOLD",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
      limit: 60,
    });
    const target = alts.data.sessions.find(
      (s: any) =>
        `${s.cinemaId}-${s.sessionId}` !== `${b.cinemaId}-${b.sessionId}` &&
        s.seatsAvailable > 2 &&
        s.showtime > nowLocalIso(),
    );
    expect(target).toBeTruthy();
    const prep = await h.tool("prepare_swap", c, {
      bookingId: "JWG0LD7",
      targetSessionKey: target.sessionKey,
      paymentMethodForDifference: "VOX_CREDIT",
    });
    expect(prep.ok).toBe(true);
    const r = await h.tool("swap_booking", c, {
      bookingId: "JWG0LD7",
      confirmationId: prep.data.confirmationId,
      confirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.result.newBookingId).toHaveLength(7);
    const old = await h.tool("find_booking", c, { bookingId: "JWG0LD7", upcomingOnly: false });
    expect(old.data.bookings[0].status).toBe("swapped");
    const fresh = await h.tool("find_booking", c, { bookingId: r.data.result.newBookingId });
    expect(fresh.data.bookings[0].status).toBe("confirmed");
    expect(fresh.data.bookings[0].sessions ?? true).toBeTruthy();
  });
});

describe("Phase 2 — guided booking end to end", () => {
  it("start → tickets → seats → F&B → promo → payment sheet → booking with QR; then cancels it", async () => {
    const c = conv("book");
    const login = await h.tool("login_customer", c, { phone: "0501234567", pin: "1234" });
    expect(login.ok).toBe(true);
    const sessions = await h.tool("search_sessions", c, {
      cinemaName: "Mirdif",
      experience: "Standard",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
      limit: 60,
    });
    const soon = new Date(new Date(`${nowLocalIso()}Z`).getTime() + 2 * 3600000).toISOString().slice(0, 19);
    // needs a family-rated film so both adult and child tickets exist (adults-only films hide child tickets)
    const familyOk = (s: any) =>
      !/^(15|18|21)\+?$/.test(s.rating ?? "") && s.seatsAvailable > 10 && s.showtime > soon;
    const monday =
      sessions.data.sessions.find((s: any) => new Date(`${s.showtime}Z`).getUTCDay() === 1 && familyOk(s)) ??
      sessions.data.sessions.find(familyOk);
    const start = await h.tool("start_order", c, { sessionKey: monday.sessionKey });
    expect(start.ok).toBe(true);
    const usid = start.data.userSessionId;
    const adult = start.data.ticketTypes.find(
      (t: any) => /ADULT/.test(t.description) && t.area === "regular",
    ).code;
    const child = start.data.ticketTypes.find((t: any) => t.isChild && t.area === "regular").code;
    const add = await h.tool("add_tickets", c, {
      userSessionId: usid,
      tickets: [
        { ticketTypeCode: adult, qty: 2 },
        { ticketTypeCode: child, qty: 1 },
      ],
    });
    expect(add.ok).toBe(true);
    expect(add.data.result.order.tickets).toHaveLength(3);
    expect(add.data.result.order.seats).toMatch(/[A-Z]\d+/);
    const plan = await h.tool("get_seat_plan", c, { sessionKey: monday.sessionKey, userSessionId: usid });
    expect(plan.data.held).toHaveLength(3);
    // pick three specific free adjacent seats via the widget path
    const freeRow = plan.data.rows.find(
      (r: any) => r.seats.filter((s: any) => s.status === 0 && s.style === 0).length >= 5,
    );
    const free = freeRow.seats.filter((s: any) => s.status === 0 && s.style === 0).slice(0, 3);
    const session = await h.api
      .request("/widget/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: c }),
      })
      .then((r) => r.json() as any);
    const seatCmd = await h.widget("command", session.token, {
      type: "seat.select",
      userSessionId: usid,
      seats: free.map((s: any) => ({ row: freeRow.row, number: s.id })),
    });
    expect(seatCmd.ok).toBe(true);
    const fnb = await h.tool("add_concessions", c, {
      userSessionId: usid,
      items: [{ itemId: "160", quantity: 1, modifierIds: ["COKEZ"] }],
    });
    expect(fnb.ok).toBe(true);
    const isMonday = new Date(`${monday.showtime}Z`).getUTCDay() === 1;
    if (isMonday) {
      const promo = await h.tool("apply_offer", c, { userSessionId: usid, promoCode: "MONDAY30" });
      expect(promo.ok).toBe(true);
      expect(promo.data.result.order.discountCents).toBeGreaterThan(0);
    }
    const order = await h.tool("get_order", c, { userSessionId: usid });
    expect(order.data.order.concessions).toHaveLength(1);
    const prep = await h.tool("prepare_payment", c, { userSessionId: usid, method: "CARD" });
    expect(prep.ok).toBe(true);
    expect(prep.ui.type).toBe("payment");
    // widget completes the (simulated) payment sheet → token
    const declined = await h.widget("command", session.token, {
      type: "payment.token",
      userSessionId: usid,
      confirmationId: prep.data.confirmationId,
      token: "tok_declined_test",
    });
    expect(declined.ok).toBe(false);
    expect(declined.action.error.code).toBe("PAYMENT_DECLINED");
    const prep2 = await h.tool("prepare_payment", c, { userSessionId: usid, method: "CARD" });
    const paid = await h.widget("command", session.token, {
      type: "payment.token",
      userSessionId: usid,
      confirmationId: prep2.data.confirmationId,
      token: "tok_visa_4242",
    });
    expect(paid.ok).toBe(true);
    const bookingId = paid.action.result.bookingId;
    expect(bookingId).toHaveLength(7);
    expect(paid.action.result.qrPayload).toContain(bookingId);
    // Phase 1 sees it and can cancel it (member → VOX credit)
    const mine = await h.tool("list_my_bookings", c, {});
    expect(mine.data.bookings.some((b: any) => b.bookingId === bookingId)).toBe(true);
    const cprep = await h.tool("prepare_cancellation", c, { bookingId });
    expect(cprep.error, JSON.stringify(cprep)).toBeUndefined();
    expect(cprep.ok).toBe(true);
    const cancel = await h.tool("cancel_booking", c, {
      bookingId,
      confirmationId: cprep.data.confirmationId,
      confirmed: true,
    });
    expect(cancel.ok).toBe(true);
  });
  it("expired confirmations and order state errors are explained, not executed", async () => {
    const c = conv("err");
    const r = await h.tool("pay_order", c, {
      userSessionId: "nope",
      confirmationId: "cnf_missing",
      confirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
  });
});

describe("Phase 2 — personalisation, feedback, complaints, transfer", () => {
  it("recommends from history", async () => {
    const c = conv("rec");
    const login = await h.tool("login_customer", c, { memberId: "SHR200877", pin: "2468" });
    expect(login.error, JSON.stringify(login)).toBeUndefined();
    const r = await h.tool("get_recommendations", c, { kind: "both" });
    expect(r.data.personalised, JSON.stringify(r).slice(0, 500)).toBe(true);
    expect(r.data.movies.length).toBeGreaterThan(0);
    expect(r.speech).toMatch(/Rahul/);
  });
  it("logs a complaint with a reference and transfers to a (simulated) human with summary", async () => {
    const c = conv("tr");
    const cm = await h.tool("create_complaint", c, {
      category: "fnb",
      description: "The popcorn was stale and cold at Mall of the Emirates last night.",
      cinemaId: "0002",
      customerName: "Layla Haddad",
      customerEmail: "layla.haddad@example.com",
    });
    expect(cm.ok).toBe(true);
    expect(cm.data.result.complaintId).toMatch(/^CMP-/);
    const tr = await h.tool("transfer_to_agent", c, {
      reason: "complaint",
      summary: "Customer unhappy with F&B quality; complaint logged.",
    });
    expect(tr.ok).toBe(true);
    expect(tr.data.result.summary).toMatch(/CMP-/);
    // simulated agent greets within ~3s
    await new Promise((r) => setTimeout(r, 3500));
    const session = await h.api
      .request("/widget/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: c }),
      })
      .then((r) => r.json() as any);
    const state = await h.widget("state", session.token);
    expect(state.conversation.mode).toBe("human");
    expect(state.transfer.status).toBe("connected");
    const msg = await h.widget("command", session.token, {
      type: "human.message",
      transferId: tr.data.result.transferId,
      text: "Thanks, when will I hear back?",
    });
    expect(msg.ok).toBe(true);
    const fb = await h.tool("submit_feedback", c, { rating: 4, comment: "Quick and helpful" });
    expect(fb.ok).toBe(true);
  });
  it("reporting summary reflects activity", async () => {
    const r = await h.api.request("/reporting/summary?days=1").then((x) => x.json() as any);
    expect(r.conversations.total).toBeGreaterThan(5);
    expect(r.journeys.cancellation.completed).toBeGreaterThanOrEqual(2);
    expect(r.transfers.total).toBeGreaterThanOrEqual(1);
    expect(r.feedback.count).toBeGreaterThanOrEqual(1);
  });
  it("exposes OpenAPI for all tools", async () => {
    const r = await h.api.request("/openapi.json").then((x) => x.json() as any);
    expect(Object.keys(r.paths).length).toBe(39);
  });
});
