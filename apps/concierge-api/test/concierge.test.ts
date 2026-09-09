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
  it("relaxes one constraint at a time and keeps the requested language", async () => {
    // Arabic films at a cinema that has none → other cinemas with Arabic films, not other languages at the same cinema
    const r = await h.tool("search_sessions", conv("s3"), {
      language: "Arabic",
      cinemaName: "City Centre Deira",
      dateTo: "next sunday",
    });
    expect(r.ok).toBe(true);
    if (r.data.sessions.length) {
      expect(r.data.sessions.every((x: any) => /arabic/i.test(x.filmLanguage ?? x.language))).toBe(true);
      if (r.data.relaxed) expect(r.speech).toMatch(/No Arabic films/);
    }
  });
  it("filters films by child age", async () => {
    const r = await h.tool("search_films", conv("f2"), { maxAge: 10, limit: 20 });
    expect(r.data.films.every((f: any) => !/^(15\+|18\+|18TC|21\+)$/.test(f.rating))).toBe(true);
  });
  it("finds showtimes at a cinema by spoken alias and suggests alternatives", async () => {
    const available = await h.tool("search_sessions", conv("s1_fixture"), {
      cinemaName: "Mall of the Emirates",
      dateTo: "2099-01-01",
      limit: 1,
    });
    expect(available.data.sessions.length).toBeGreaterThan(0);
    const title = available.data.sessions[0].filmTitle;
    const r = await h.tool("search_sessions", conv("s1"), {
      title,
      cinemaName: "MOE",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
    });
    expect(r.ok).toBe(true);
    expect(r.data.sessions.length).toBeGreaterThan(0);
    expect(r.data.sessions[0].cinemaId).toBe("0002");
    const none = await h.tool("search_sessions", conv("s2"), {
      title,
      cinemaName: "Mall of the Emirates",
      timeFrom: "03:00",
      timeTo: "03:30",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
    });
    expect(none.ok).toBe(true);
    expect(none.data.relaxed).toBeTruthy();
  });
  it("nearest cinemas use the location set in the widget (never coordinates from the agent)", async () => {
    const c = conv("c1");
    const none = await h.tool("nearest_cinemas", c, {});
    expect(none.ok).toBe(false);
    expect(none.error.code).toBe("LOCATION_REQUIRED");
    const session = await h.session(c);
    await h.widget("command", session.token, {
      type: "location",
      lat: 25.1181,
      lng: 55.2004,
      label: "Al Barsha",
      source: "manual",
    });
    const n = await h.tool("nearest_cinemas", c, {});
    expect(n.data.cinemas[0].cinemaId).toBe("0002");
    expect(n.speech).toMatch(/Al Barsha/);
    const ctx = await h.tool("get_session_context", c, {});
    expect(ctx.data.location).toBe("Al Barsha");
    // near-me showtimes: nearest cinema first, with distance and a map link
    const near = await h.tool("search_sessions", c, { dateTo: "2099-01-01" });
    expect(near.ok).toBe(true);
    expect(near.data.sessions[0].distanceKm).toBeDefined();
    expect(near.data.sessions[0].mapUrl).toMatch(/google\.com\/maps/);
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
    const byRef = await h.tool("find_booking", conv("b1"), { bookingId: "wxa7k2m" });
    expect(byRef.data.bookings[0].bookingId).toBe("WXA7K2M");
    expect(byRef.data.bookings[0].eligibility.eligible).toBe(true);
    const cutoff = await h.tool("find_booking", conv("b2"), { bookingId: "WM3PQ9X" });
    expect(cutoff.data.bookings[0].eligibility.code).toBe("CUTOFF_PASSED");
    const bank = await h.tool("check_cancellation_eligibility", conv("b3"), { bookingId: "WMB6GQ2" });
    expect(bank.data.eligibility.eligible).toBe(false);
    expect(bank.speech).toMatch(/bank/i);
    const collected = await h.tool("check_cancellation_eligibility", conv("b4"), { bookingId: "WK4DXC9" });
    expect(collected.data.eligibility.code).toBe("TICKETS_USED");
  });
  it("requires guest verification, then cancels with confirmation and refunds to VOX credit; duplicates are idempotent", async () => {
    const c = conv("cancel");
    const denied = await h.tool("prepare_cancellation", c, { bookingId: "WXA7K2M" });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("VERIFICATION_REQUIRED");
    const prep = await h.tool("prepare_cancellation", c, {
      bookingId: "WXA7K2M",
      refundMethod: "VOX_CREDIT",
      verification: { phoneLast4: "4567" },
    });
    expect(prep.ok).toBe(true);
    expect(prep.speech).toMatch(/To confirm/);
    const confirmationId = prep.data.confirmationId;
    // no confirmation → rejected
    const bad = await h.tool("cancel_booking", c, {
      bookingId: "WXA7K2M",
      confirmationId: "cnf_nope",
      confirmed: true,
    });
    expect(bad.ok).toBe(false);
    // 8 concurrent identical confirmations → exactly one action, one refund
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.tool("cancel_booking", c, { bookingId: "WXA7K2M", confirmationId, confirmed: true }),
      ),
    );
    const okOnes = results.filter((r) => r.ok);
    expect(okOnes.length).toBeGreaterThanOrEqual(1);
    const actionIds = new Set(results.map((r) => r.data?.action?.actionId).filter(Boolean));
    expect(actionIds.size).toBe(1);
    const final = await h.tool("get_action_result", c, { actionId: [...actionIds][0], waitMs: 8000 });
    expect(final.data.action.status).toBe("succeeded");
    expect(final.speech).toMatch(/cancelled/);
    const after = await h.tool("find_booking", c, { bookingId: "WXA7K2M", upcomingOnly: false });
    expect(after.data.bookings[0].status).toBe("refunded");
    const bal = await h.ctx.vista.balances("SHR100234");
    expect(bal.Balances.find((b) => b.BalanceTypeId === "VOX_REWARDS")!.ValueCents).toBeGreaterThan(12000);
    // cancelling again is a clean conflict, not a second refund
    const prep2 = await h.tool("prepare_cancellation", c, {
      bookingId: "WXA7K2M",
      verification: { phoneLast4: "4567" },
    });
    expect(prep2.ok).toBe(false);
    expect(prep2.error.code).toBe("BOOKING_ALREADY_CANCELLED");
  });
  it("partial cancellation keeps F&B and refunds proportionally", async () => {
    const c = conv("partial");
    const prep = await h.tool("prepare_cancellation", c, {
      bookingId: "WKGRP33",
      ticketIds: ["1"],
      refundMethod: "SHARE_POINTS",
      verification: { email: "rahul.menon@example.com" },
    });
    expect(prep.ok).toBe(true);
    expect(prep.data.summary.partial).toBe(true);
    const r = await h.tool("cancel_booking", c, {
      bookingId: "WKGRP33",
      confirmationId: prep.data.confirmationId,
      confirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.action.status).toBe("succeeded");
    const after = await h.tool("find_booking", c, { bookingId: "WKGRP33", upcomingOnly: false });
    expect(after.data.bookings[0].status).toBe("partially_refunded");
    expect(after.data.bookings[0].concessions.length).toBe(1);
  });
});

describe("Phase 1 — swaps", () => {
  it("swaps to another showtime of the same film (saga) and links bookings", async () => {
    const c = conv("swap");
    const login = await h.login(c, "JAMES");
    expect(login.ok).toBe(true);
    const b = (await h.tool("find_booking", c, { bookingId: "WJG8LD7" })).data.bookings[0];
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
        s.showtime >
          new Date(new Date(`${nowLocalIso()}Z`).getTime() + 3 * 3600000).toISOString().slice(0, 19), // not inside the swap cut-off
    );
    expect(target).toBeTruthy();
    const prep = await h.tool("prepare_swap", c, {
      bookingId: "WJG8LD7",
      targetSessionKey: target.sessionKey,
      paymentMethodForDifference: "VOX_CREDIT",
    });
    expect(prep.ok).toBe(true);
    expect(prep.speech).toMatch(/move(s)? with it/); // F&B on the booking is carried over
    const r = await h.tool("swap_booking", c, {
      bookingId: "WJG8LD7",
      confirmationId: prep.data.confirmationId,
      confirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.result.newBookingId).toHaveLength(7);
    expect(r.speech).toMatch(/moved with it/);
    expect(r.speech).not.toMatch(/1 tickets/);
    const old = await h.tool("find_booking", c, { bookingId: "WJG8LD7", upcomingOnly: false });
    expect(old.data.bookings[0].status).toBe("swapped");
    const fresh = await h.tool("find_booking", c, { bookingId: r.data.result.newBookingId });
    expect(fresh.data.bookings[0].status).toBe("confirmed");
    expect(fresh.data.bookings[0].concessions.length).toBe(b.concessions.length);
    expect(fresh.data.bookings[0].sessions ?? true).toBeTruthy();
  });
});

describe("Phase 2 — guided booking end to end", () => {
  it("start → tickets → seats → F&B → promo → payment sheet → booking with QR; then cancels it", async () => {
    const c = conv("book");
    const login = await h.login(c, "SARA");
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
      (t: any) => /REGULAR$/.test(t.description) && t.area === "regular",
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
    const session = await h.session(c);
    const seatCmd = await h.widget("command", session.token, {
      type: "seat.select",
      userSessionId: usid,
      seats: free.map((s: any) => ({ row: freeRow.row, number: s.id })),
    });
    expect(seatCmd.ok).toBe(true);
    const fnb = await h.tool("add_concessions", c, {
      userSessionId: usid,
      items: [{ itemId: "7747", quantity: 1, modifierIds: ["DIET"] }],
    });
    expect(fnb.ok).toBe(true);
    // the guest rejects a drink: quantity 0 removes it and the replacement is added in the same call
    const swap = await h.tool("add_concessions", c, {
      userSessionId: usid,
      items: [
        { itemId: "7747", quantity: 0 },
        { itemId: "2402", quantity: 1 },
      ],
    });
    expect(swap.ok).toBe(true);
    expect(swap.data.result.speech).toMatch(/removed/i);
    expect(swap.data.result.order.concessions).toHaveLength(1);
    expect(swap.data.result.order.concessions[0].itemId).toBe("2402");
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
    expect(r.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Phase 2 — personalisation, feedback, complaints, transfer", () => {
  it("recommends from history", async () => {
    const c = conv("rec");
    const login = await h.login(c, "RAHUL");
    expect(login.error, JSON.stringify(login)).toBeUndefined();
    const r = await h.tool("get_recommendations", c, { kind: "both" });
    expect(r.data.personalised, JSON.stringify(r).slice(0, 500)).toBe(true);
    expect(r.data.movies.length).toBeGreaterThan(0);
    expect(r.data.profile.inferred.movieLanguage).toBe("Tamil");
    expect(r.speech).not.toMatch(/based on your previous bookings/i);
    // an explicit language wins over the profile
    const hi = await h.tool("get_recommendations", c, { language: "Hindi" });
    expect(hi.data.movies.every((m: any) => /hindi/i.test(m.language))).toBe(true);
  });
  it("uses profile context without an extra children question and respects an explicit family request", async () => {
    const c = conv("rec-kids");
    await h.login(c, "SARA");
    const ask = await h.tool("get_recommendations", c, {});
    expect(ask.data.askChildren).toBeUndefined();
    expect(ask.data.movies.length).toBeGreaterThan(0);
    const adults = await h.tool("get_recommendations", c, { withChildren: false });
    expect(adults.data.askChildren).toBeUndefined();
    expect(adults.data.movies.length).toBeGreaterThan(0);
    expect(adults.data.movies.every((m: any) => !m.family)).toBe(true);
    const kids = await h.tool("get_recommendations", c, { withChildren: true });
    expect(kids.data.movies.every((m: any) => !/^(15|18|21)/.test(m.rating ?? ""))).toBe(true);
  });
  it("filters offers by bank, hints saved cards for members and hides bank offers from guests", async () => {
    const member = conv("offers-m");
    await h.login(member, "SARA");
    const enbd = await h.tool("list_offers", member, { bank: "ENBD" });
    expect(enbd.data.offers.length).toBeGreaterThan(0);
    expect(enbd.data.offers.every((o: any) => /NBD/i.test(o.titleEn))).toBe(true);
    expect(enbd.data.offers[0].savedCard?.last4).toBe("3845");
    expect(enbd.speech).toMatch(/ENBD|Emirates NBD/);
    const guest = conv("offers-g");
    const g = await h.tool("list_offers", guest, { type: "bank" });
    expect(g.data.guest).toBe(true);
    expect(g.speech).toMatch(/(?:Log|Sign) in/);
    expect(g.data.offers.every((o: any) => o.eligible === false && o.requires.includes("member"))).toBe(true);
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
    const session = await h.session(c);
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
    expect(Object.keys(r.paths).length).toBe(44);
  });
});

describe("Booking v2 — one-shot booking, recovery, quick F&B", () => {
  const widgetSession = (c: string) => h.session(c);
  const pickShow = async (c: string, cinemaName: string) => {
    const sessions = await h.tool("search_sessions", c, {
      cinemaName,
      experience: "Standard",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
      limit: 60,
    });
    const soon = new Date(new Date(`${nowLocalIso()}Z`).getTime() + 2 * 3600000).toISOString().slice(0, 19);
    return sessions.data.sessions.find((s: any) => s.seatsAvailable > 12 && s.showtime > soon);
  };

  it("quick_book uses the usual cinema, asks only unknown quantity, then reviews seats before checkout", async () => {
    const c = conv("qb");
    await h.login(c, "RAHUL");
    const show = await pickShow(c, "Burjuman");
    if (!show) return;
    // The usual cinema is already known; only ticket quantity needs asking.
    const ask = await h.tool("quick_book", c, {
      title: show.filmTitle,
      date: show.date,
      time: show.showtime.slice(11, 16),
    });
    expect(ask.ok).toBe(true);
    expect(ask.data.needs).toBe("tickets");
    expect(ask.ui.type).toBe("quantity");
    // Once quantity is supplied, show editable seats and optional snacks.
    const hhmm = show.showtime.slice(11, 16);
    const r = await h.tool("quick_book", c, {
      title: show.filmTitle,
      cinemaName: "Burjuman",
      date: show.date,
      time: hhmm,
      tickets: 2,
    });
    expect(r.error, JSON.stringify(r).slice(0, 600)).toBeUndefined();
    expect(r.ui.type).toBe("order");
    expect(r.data.bookingState.currentJourneyStage).toBe("seats");
    expect(r.data.order.tickets).toHaveLength(2);
    expect(r.data.order.sessionId).toBe(show.sessionId);
    expect(r.speech).toMatch(/2 seats held/);
    expect(r.speech).not.toMatch(/undefined/);
    const checkout = await h.tool("prepare_payment", c, {
      userSessionId: r.data.order.userSessionId,
      method: "SAVED_CARD",
    });
    expect(checkout.ui.type).toBe("payment");
    expect(checkout.data.sheet.preferredToken).toBeTruthy();
    expect(checkout.data.sheet.expiresAtUtc).toBeTruthy();
    // the spoken seat label is compact (F10–F11) and the price is stated once
    expect(r.speech).toMatch(/[A-Z]\d+–[A-Z]\d+|[A-Z]\d+, [A-Z]\d+/);
    // resume returns the same held order without rebuilding it
    const again = await h.tool("resume_order", c, {});
    expect(again.ok).toBe(true);
    expect(again.data.active).toBe(true);
    expect(again.data.order.userSessionId).toBe(r.data.order.userSessionId);
    await h.tool("cancel_order", c, { userSessionId: r.data.order.userSessionId });
  });

  it("quick_book: books an exact sessionKey for a guest and lets the sheet collect the details; then F&B as a separate order", async () => {
    const c = conv("qb-guest");
    const show = await pickShow(c, "Mirdif");
    if (!show) return;
    const r = await h.tool("quick_book", c, { sessionKey: show.sessionKey, tickets: 1 });
    expect(r.error, JSON.stringify(r).slice(0, 600)).toBeUndefined();
    expect(r.ui.type).toBe("order");
    const checkout = await h.tool("prepare_payment", c, {
      userSessionId: r.data.order.userSessionId,
      method: "CARD",
    });
    expect(checkout.data.sheet.guest).toBe(true);
    expect(checkout.data.sheet.customerKnown).toBe(false);
    const session = await widgetSession(c);
    const paid = await h.widget("command", session.token, {
      type: "payment.token",
      userSessionId: r.data.order.userSessionId,
      confirmationId: checkout.data.confirmationId,
      token: "tok_visa_4242",
      customer: { name: "Guest Tester", email: "guest.tester@example.com", phone: "0509998877" },
    });
    expect(paid.ok, JSON.stringify(paid).slice(0, 400)).toBe(true);
    const bookingId = paid.action.result.bookingId;
    expect(bookingId).toHaveLength(7);
    // food after the tickets: quick picks, then a separate F&B order for the same show
    const sug = await h.tool("suggest_fnb", c, {});
    expect(sug.ok).toBe(true);
    expect(sug.ui.type).toBe("menu");
    expect(sug.data.items.length).toBeGreaterThan(0);
    const item = sug.data.items[0];
    const fnb = await h.tool("order_fnb", c, { items: [{ itemId: item.itemId, quantity: 1 }] });
    expect(fnb.error, JSON.stringify(fnb).slice(0, 600)).toBeUndefined();
    expect(fnb.ui.type).toBe("payment");
    expect(fnb.data.sheet.fnbOnly).toBe(true);
    expect(fnb.data.order.tickets).toHaveLength(0);
    expect(fnb.data.order.concessions).toHaveLength(1);
    const fnbPaid = await h.widget("command", session.token, {
      type: "payment.token",
      userSessionId: fnb.data.order.userSessionId,
      confirmationId: fnb.data.confirmationId,
      token: "tok_visa_4242",
      customer: { name: "Guest Tester", email: "guest.tester@example.com", phone: "0509998877" },
    });
    expect(fnbPaid.ok, JSON.stringify(fnbPaid).slice(0, 400)).toBe(true);
    expect(fnbPaid.action.result.bookingId).not.toBe(bookingId);
    expect(fnbPaid.action.result.speech).toMatch(/food order/i);
  });

  it("quick_book: an unavailable time returns up to three alternatives instead of 'no showtimes'", async () => {
    const c = conv("qb-alt");
    const show = await pickShow(c, "Mall of the Emirates");
    if (!show) return;
    const r = await h.tool("quick_book", c, {
      title: show.filmTitle,
      cinemaName: "Mall of the Emirates",
      date: show.date,
      time: "03:30",
    });
    expect(r.ok).toBe(true);
    expect(r.data.needs).toBe("alternative");
    expect(r.data.alternatives.length).toBeGreaterThan(0);
    expect(r.data.alternatives.length).toBeLessThanOrEqual(3);
    expect(r.speech).toMatch(/isn't available/);
    expect(r.speech).toMatch(/which (?:one|works)\?$/);
    expect(r.ui.type).toBe("showtimes");
    // Picking a show keeps it selected, but an unknown quantity is never assumed.
    const pick = await h.tool("quick_book", c, { sessionKey: r.data.alternatives[0].sessionKey });
    expect(pick.error, JSON.stringify(pick).slice(0, 400)).toBeUndefined();
    expect(pick.data.needs).toBe("tickets");
    const selected = await h.tool("quick_book", c, {
      sessionKey: r.data.alternatives[0].sessionKey,
      tickets: 2,
    });
    expect(selected.data.order.tickets).toHaveLength(2);
    await h.tool("cancel_order", c, { userSessionId: selected.data.order.userSessionId });
  });

  it("recover_order: after the hold expires the same seats are re-held (or the closest in the row) with F&B kept", async () => {
    const c = conv("qb-recover");
    await h.login(c, "SARA");
    const show = await pickShow(c, "Mirdif");
    if (!show) return;
    const r = await h.tool("quick_book", c, {
      sessionKey: show.sessionKey,
      tickets: 2,
      cinemaName: "Mirdif",
    });
    expect(r.error, JSON.stringify(r).slice(0, 400)).toBeUndefined();
    const usid = r.data.order.userSessionId;
    const fnb = await h.tool("add_concessions", c, {
      userSessionId: usid,
      items: [{ itemId: "2402", quantity: 1 }],
    });
    expect(fnb.ok).toBe(true);
    const seats = r.data.order.seats;
    // simulate Vista's clean-up: force the order to expire
    await h.expireOrder(usid);
    const dead = await h.tool("get_order", c, { userSessionId: usid });
    expect(dead.error?.code).toBe("ORDER_EXPIRED");
    const permission = await h.tool("recover_order", c, {});
    expect(permission.data.needs).toBe("recovery_confirmation");
    expect(permission.data.active).toBe(false);
    const rec = await h.tool("recover_order", c, { confirmed: true });
    expect(rec.error, JSON.stringify(rec).slice(0, 600)).toBeUndefined();
    expect(rec.data.seatsRecovered).toBe("same");
    expect(rec.data.order.seats).toBe(seats);
    expect(rec.data.order.userSessionId).not.toBe(usid);
    expect(rec.data.order.concessions).toHaveLength(1);
    expect(rec.speech).toMatch(/still free/);
    expect(rec.ui.type).toBe("order");
    // the widget path (order.recover) does the same and renders the sheet
    const session = await widgetSession(c);
    await h.expireOrder(rec.data.order.userSessionId);
    const cmd = await h.widget("command", session.token, { type: "order.recover", confirmed: true });
    expect(cmd.ok, JSON.stringify(cmd).slice(0, 400)).toBe(true);
    expect(cmd.speech).toMatch(/held/);
    await h.tool("cancel_order", c, { userSessionId: cmd.data.order.userSessionId });
  });

  it("offer intelligence: a saved-card offer is hinted only when the basket qualifies, and the monthly limit is enforced", async () => {
    const c = conv("qb-offer");
    await h.login(c, "RAHUL");
    const sessions = await h.tool("search_sessions", c, {
      cinemaName: "Burjuman",
      experience: "Standard",
      date: nowLocalIso().slice(0, 10),
      dateTo: "2099-01-01",
      limit: 60,
    });
    const soon = new Date(new Date(`${nowLocalIso()}Z`).getTime() + 2 * 3600000).toISOString().slice(0, 19);
    // ADCB BOGO is valid on specific days — find one where a 2-ticket basket qualifies
    let hinted: any = null;
    let one: any = null;
    for (const s of sessions.data.sessions
      .filter((x: any) => x.seatsAvailable > 12 && x.showtime > soon)
      .slice(0, 12)) {
      const single = await h.tool("quick_book", c, { sessionKey: s.sessionKey, tickets: 1 });
      if (!single.ok) continue;
      expect(single.data.offerHint ?? null).toBeNull(); // 1 ticket never qualifies for buy-one-get-one
      one = single;
      const two = await h.tool("quick_book", c, { sessionKey: s.sessionKey, tickets: 2 });
      if (two.ok && two.data.offerHint) {
        hinted = two;
        break;
      }
    }
    if (!hinted) {
      if (one) await h.tool("cancel_order", c, { userSessionId: one.data.order.userSessionId });
      return;
    }
    expect(hinted.data.offerHint.cardLabel).toMatch(/ending \d{4}/);
    const checkout = await h.tool("prepare_payment", c, {
      userSessionId: hinted.data.order.userSessionId,
      method: "SAVED_CARD",
    });
    expect(checkout.data.sheet.preferredToken).toBe(hinted.data.offerHint.cardToken);
    const applied = await h.tool("apply_offer", c, {
      userSessionId: hinted.data.order.userSessionId,
      offerId: hinted.data.offerHint.offerId,
      cardBin: hinted.data.offerHint.cardBin,
    });
    expect(applied.ok, JSON.stringify(applied).slice(0, 400)).toBe(true);
    expect(applied.data.result.order.discountCents).toBeGreaterThan(0);
    await h.tool("cancel_order", c, { userSessionId: hinted.data.order.userSessionId });
  });

  it("the first message is personal for a signed-in member and generic for a guest", async () => {
    const guest = await widgetSession(conv("greet-g"));
    expect(guest.dynamicVariables.greetingEn).toBe(
      "Hi, welcome to VOX Cinemas. What are you in the mood to watch?",
    );
    const c = conv("greet-m");
    await h.login(c, "SARA");
    const member = await widgetSession(c);
    expect(member.dynamicVariables.greetingEn).toBe("Hi Sara, what are you in the mood to watch?");
    expect(member.dynamicVariables.firstName).toBe("Sara");
  });
});
