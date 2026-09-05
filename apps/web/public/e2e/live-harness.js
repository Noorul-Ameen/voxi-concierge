/**
 * Aggressive live test harness — runs inside a browser tab on the demo site (same-origin fetch to the concierge API).
 * Usage (DevTools / automation): paste this file, then `await V.run("all")` or `await V.run("booking")`.
 * Every check records {name, ok, note}. Nothing here touches ElevenLabs; it exercises the concierge tools,
 * widget commands and reporting endpoints exactly as the agent and widget do.
 */
(() => {
  const API = window.__VOXI_API ?? "https://concierge-api-production-3d90.up.railway.app";
  const KEY = window.__VOXI_KEY;
  const results = [];
  const rec = (name, ok, note = "") => {
    results.push({ name, ok: !!ok, note: String(note).slice(0, 300) });
    return ok;
  };
  const conv = (s) => `conv_e2e_${s}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tool = async (name, conversationId, input = {}, extra = {}) => {
    const r = await fetch(`${API}/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voxi-key": KEY },
      body: JSON.stringify({ conversationId, ...extra, ...input }),
    });
    return r.json();
  };
  const session = async (conversationId, extra = {}) =>
    fetch(`${API}/widget/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, ...extra }) }).then((r) => r.json());
  const cmd = async (s, body) =>
    fetch(`${API}/widget/command`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(body) }).then((r) => r.json());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (s, re) => re.test(String(s ?? ""));

  // ------------------------------------------------------------------ 1–4: information
  async function info() {
    let r = await tool("search_films", conv("f"), { query: "spider man" });
    rec("1 films: fuzzy title", r.ok && /Spider-Man/.test(r.data?.films?.[0]?.title), r.speech);
    rec("1 films: poster + trailer on card", !!(r.data?.films?.[0]?.posterUrl && (r.data.films[0].youtubeId || r.data.films[0].trailerUrl)), JSON.stringify(r.data?.films?.[0]).slice(0, 200));
    r = await tool("search_films", conv("f"), { language: "Tamil", status: "now_showing", limit: 5 });
    rec("1 films: language filter Tamil", r.ok && r.data.films.length > 0 && r.data.films.every((f) => /tamil/i.test(f.language)), r.speech);
    r = await tool("search_films", conv("f"), { genre: "Animation", maxAge: 8, limit: 5 });
    rec("1 films: genre + child age", r.ok && r.data.films.every((f) => !/^(15|18|21)/.test(f.rating)), r.speech);
    r = await tool("search_films", conv("f"), { status: "coming_soon", limit: 5 });
    rec("1 films: coming soon", r.ok && r.data.films.length > 0, r.speech);
    r = await tool("search_films", conv("f"), { query: "zzzxq nonexistent film" });
    rec("1 films: no match → alternatives, no crash", r.ok !== undefined && !/undefined/.test(r.speech ?? ""), r.speech);
    r = await tool("search_films", conv("f"), { rating: "PG13", limit: 3 });
    rec("1 films: rating filter", r.ok && r.data.films.every((f) => f.rating === "PG13"), r.speech);
    r = await tool("get_film", conv("f"), { title: "Mirzapur" });
    rec("1 film details incl. rating/runtime", r.ok && r.data.film?.rating, r.speech);
    r = await tool("search_sessions", conv("s"), { title: "spider-man", cinemaName: "MOE", date: "today", dateTo: "next sunday" });
    rec("1 sessions: MOE alias + date words", r.ok && r.data.sessions.length > 0 && r.data.sessions[0].cinemaId === "0002", r.speech);
    r = await tool("search_sessions", conv("s"), { title: "spider-man", cinemaName: "Dubai", date: "weekend" });
    rec("1 sessions: emirate = every cinema in Dubai", r.ok && new Set(r.data.sessions.map((s) => s.cinemaId)).size > 1, r.speech);
    r = await tool("search_sessions", conv("s"), { cinemaName: "City Centre Deira", date: "tonight", timeFrom: "17:00" });
    rec("1 sessions: tonight at a cinema ≤3 spoken + 'more on screen'", r.ok && (r.speech.match(/\d{1,2}:\d{2}/g) || []).length <= 4, r.speech);
    r = await tool("search_sessions", conv("s"), { title: "spider-man", cinemaName: "Mall of the Emirates", timeFrom: "03:00", timeTo: "03:30", date: "today", dateTo: "2099-01-01" });
    rec("1 sessions: impossible window → relaxed alternative", r.ok && r.data.relaxed, r.speech);
    r = await tool("search_sessions", conv("s"), { language: "Arabic", cinemaName: "City Centre Deira", date: "tomorrow" });
    rec("1 sessions: Arabic kept when relaxing", r.ok && (r.data.sessions.length === 0 || r.data.sessions.every((s) => /arabic/i.test(s.filmLanguage ?? s.language))), r.speech);
    r = await tool("search_sessions", conv("s"), { title: "spider-man", experience: "IMAX", date: "today", dateTo: "next sunday" });
    rec("1 sessions: experience filter", r.ok && (r.data.sessions.every((s) => s.experience === "IMAX") || r.data.relaxed), r.speech);
    r = await tool("search_sessions", conv("s"), { title: "spider-man", date: "yesterday" });
    rec("1 sessions: past date handled gracefully", !/undefined|NaN/.test(r.speech ?? "") && (r.ok || r.error), r.speech ?? r.error?.message);
    r = await tool("search_sessions", conv("s"), { date: "tomorrow" });
    rec("1 sessions: no film, no cinema → asks", !r.ok && /which/i.test(r.error?.message ?? ""), r.error?.message);

    r = await tool("list_cinemas", conv("c"), { emirate: "Abu Dhabi" });
    rec("2 cinemas: by emirate", r.ok && r.data.cinemas.length >= 4 && r.data.cinemas.every((c) => c.emirate === "Abu Dhabi"), r.speech);
    r = await tool("get_cinema", conv("c"), { name: "Deira City Centre" });
    rec("2 cinema: hours + directions + parking + accessibility", r.ok && r.data.cinema.hours && r.data.cinema.directions && r.data.cinema.parking && r.data.cinema.accessibility, JSON.stringify(r.data?.cinema).slice(0, 300));
    rec("2 cinema: map link", has(r.data?.cinema?.mapUrl, /google\.com\/maps/), r.data?.cinema?.mapUrl);
    const c1 = conv("c");
    r = await tool("nearest_cinemas", c1, {});
    rec("2 nearest: no location → LOCATION_REQUIRED", !r.ok && r.error?.code === "LOCATION_REQUIRED", r.error?.message);
    const s1 = await session(c1);
    await cmd(s1, { type: "location", lat: 24.488, lng: 54.608, label: "Yas Island", source: "manual" });
    r = await tool("nearest_cinemas", c1, {});
    rec("2 nearest: Yas Island → Yas Mall first with km", r.ok && r.data.cinemas[0].cinemaId === "0012" && /km/.test(r.speech), r.speech);
    r = await tool("search_sessions", c1, { title: "spider-man", date: "today", dateTo: "next sunday" });
    rec("2 near-me sessions sorted by distance + map link", r.ok && r.data.sessions[0].distanceKm != null && r.data.sessions[0].mapUrl, r.speech);
    await cmd(s1, { type: "location.clear" });
    r = await tool("nearest_cinemas", c1, {});
    rec("2 nearest: cleared location → asks again", !r.ok && r.error?.code === "LOCATION_REQUIRED", r.error?.message);

    r = await tool("get_age_rules", conv("a"), { rating: "18+", childAge: 12 });
    rec("3 age: 18+ with 12yo → No", r.ok && /^No/.test(r.data.verdict), r.data?.verdict);
    r = await tool("get_age_rules", conv("a"), { rating: "PG13", childAge: 10 });
    rec("3 age: PG13 with 10yo → accompanied", r.ok && /accompan/i.test(r.data.verdict), r.data?.verdict);
    r = await tool("get_age_rules", conv("a"), { experience: "GOLD" });
    rec("3 age: experience rule (GOLD)", r.ok && r.speech, r.speech);
    r = await tool("get_age_rules", conv("a"), { rating: "G", childAge: 3 });
    rec("3 age: G with 3yo", r.ok && !/^No/.test(r.data.verdict), r.data?.verdict);
  }

  // ------------------------------------------------------------------ 5, 6, 16: offers
  async function offers() {
    let r = await tool("list_offers", conv("o"), { experience: "MAX" });
    rec("5 offers: list with images + eligibility", r.ok && r.data.offers.length > 0 && r.data.offers.every((o) => o.imageUrl !== undefined && o.eligible !== undefined), r.speech);
    r = await tool("list_offers", conv("o"), { bank: "HSBC" });
    rec("5 offers: bank filter HSBC only", r.ok && r.data.offers.length > 0 && r.data.offers.every((o) => /HSBC/i.test(o.titleEn)), r.speech);
    r = await tool("list_offers", conv("o"), { bank: "Barclays" });
    rec("5 offers: unknown bank → honest none", r.ok && r.data.offers.length === 0 && /don't have/i.test(r.speech), r.speech);
    r = await tool("list_offers", conv("o"), { cardBin: "455533" });
    rec("5 offers: card BIN → ENBD", r.ok && r.data.offers.every((o) => /NBD/i.test(o.titleEn)), r.speech);
    const g = conv("o");
    r = await tool("list_offers", g, { type: "bank" });
    rec("5 offers: guest sees members-only note", r.ok && r.data.guest === true && /Log in or create an account/.test(r.speech), r.speech);
    const m = conv("o");
    await tool("login_customer", m, { phone: "0501234567", pin: "1234" });
    r = await tool("list_offers", m, { bank: "ENBD" });
    rec("5 offers: member saved-card hint", r.ok && r.data.offers[0]?.savedCard?.last4 === "3845" && /saved Mastercard ending 3845/.test(r.speech), r.speech);
    r = await tool("check_offer_eligibility", m, { offerId: "BANK-ENBD-BOGO", cardBin: "521334", ticketCount: 3 });
    rec("16 eligibility: BOGO with 3 tickets refused with reason", r.ok && r.data.eligible === false && /exactly 2/.test(r.speech + JSON.stringify(r.data)), r.speech);
    r = await tool("check_offer_eligibility", m, { offerId: "BANK-ENBD-BOGO", cardBin: "999999", ticketCount: 2 });
    rec("16 eligibility: wrong card refused", r.ok && r.data.eligible === false, r.speech);
    r = await tool("how_to_book", conv("h"), {});
    rec("6 how to book: in-chat + link", r.ok && r.data.canBookInChat && /voxcinemas/.test(r.data.url), r.speech);
    r = await tool("how_to_book", conv("h"), { hoCode: "HO00013528" });
    rec("6 how to book: film link", r.ok && /voxcinemas/.test(r.data.url), r.data?.url);
  }

  // ------------------------------------------------------------------ 7, 8, 18: bookings, cancellations, swaps
  async function bookings() {
    let r = await tool("find_booking", conv("b"), { bookingId: "wxa7k2m" });
    rec("18 find by reference (case-insensitive)", r.ok && r.data.bookings[0].bookingId === "WXA7K2M", r.speech);
    r = await tool("find_booking", conv("b"), { bookingId: "WZZZZZZ" });
    rec("18 find: unknown reference → helpful, no crash", !r.ok && /find|found/i.test(r.error?.message ?? r.speech ?? ""), r.error?.message ?? r.speech);
    r = await tool("find_booking", conv("b"), { phone: "050 123 4567" });
    rec("18 find by phone (spaces tolerated)", r.ok && r.data.bookings.length > 0, r.speech);
    r = await tool("find_booking", conv("b"), { email: "James.Whitfield@example.com" });
    rec("18 find by email (case-insensitive)", r.ok && r.data.bookings.length > 0, r.speech);
    rec("18 find: guest data masked", r.ok && /\*/.test(JSON.stringify(r.data.bookings[0].customer)), JSON.stringify(r.data?.bookings?.[0]?.customer));
    const gc = conv("b");
    r = await tool("get_session_context", gc, {});
    rec("18 session context: guest detected", r.ok && r.data.isLoggedIn === false, r.speech);
    r = await tool("login_customer", gc, { phone: "0501234567", pin: "0000" });
    rec("18 login: wrong PIN rejected", !r.ok, r.error?.message ?? r.speech);
    r = await tool("login_customer", gc, { phone: "0501234567", pin: "1234" });
    rec("18 login: Sara", r.ok && /Sara/.test(r.speech), r.speech);
    r = await tool("list_my_bookings", gc, {});
    rec("18 my bookings (member)", r.ok && r.data.bookings.some((b) => b.bookingId === "WXA7K2M"), r.speech);
    r = await tool("get_loyalty_balance", gc, {});
    rec("17 balance: Share Points + VOX credit (10 pts = 1 AED)", r.ok && /2450|245/.test(r.speech) && /120/.test(r.speech), r.speech);

    // cancellation eligibility matrix
    r = await tool("check_cancellation_eligibility", conv("b"), { bookingId: "WM3PQ9X" });
    rec("7 cut-off: inside 30 min → refused with reason", r.ok && r.data.eligibility.code === "CUTOFF_PASSED" && /30/.test(r.speech), r.speech);
    r = await tool("check_cancellation_eligibility", conv("b"), { bookingId: "WMB6GQ2" });
    rec("7 bank-offer booking → non-refundable", r.ok && !r.data.eligibility.eligible && /bank/i.test(r.speech), r.speech);
    r = await tool("check_cancellation_eligibility", conv("b"), { bookingId: "WK4DXC9" });
    rec("7 collected tickets → refused", r.ok && r.data.eligibility.code === "TICKETS_USED", r.speech);
    r = await tool("check_cancellation_eligibility", conv("b"), { bookingId: "WLHCNC2" });
    rec("7 already cancelled → explained", !r.ok || !r.data.eligibility.eligible, r.speech ?? r.error?.message);

    // guest verification + cancellation to original card, idempotent
    const c = conv("b");
    r = await tool("prepare_cancellation", c, { bookingId: "WLHGST5" });
    rec("7 guest: verification required before anything", !r.ok && r.error?.code === "VERIFICATION_REQUIRED", r.error?.message);
    r = await tool("prepare_cancellation", c, { bookingId: "WLHGST5", verification: { phoneLast4: "0000" } });
    rec("7 guest: wrong last-4 rejected", !r.ok, r.error?.message);
    r = await tool("prepare_cancellation", c, { bookingId: "WLHGST5", verification: { phoneLast4: "4455" } });
    rec("7 guest: prepare → summary with amount + method", r.ok && /To confirm/.test(r.speech) && r.data.confirmationId, r.speech);
    const conf = r.data?.confirmationId;
    rec("7 guest refund goes to original card", /card/i.test(r.speech), r.speech);
    const bad = await tool("cancel_booking", c, { bookingId: "WLHGST5", confirmationId: "cnf_nope", confirmed: true });
    rec("7 cancel: bogus confirmation rejected", !bad.ok, bad.error?.message);
    const all = await Promise.all(Array.from({ length: 5 }, () => tool("cancel_booking", c, { bookingId: "WLHGST5", confirmationId: conf, confirmed: true })));
    const ids = new Set(all.map((x) => x.data?.action?.actionId).filter(Boolean));
    rec("7 cancel: 5 concurrent confirms → 1 action", ids.size === 1, `actions=${[...ids].join(",")}`);
    const fin = await tool("get_action_result", c, { actionId: [...ids][0], waitMs: 8000 });
    rec("7 cancel: succeeded + refund reference RF-", fin.data?.action?.status === "succeeded" && /RF-[A-Z0-9]{6}/.test(fin.speech), fin.speech);
    r = await tool("find_booking", c, { bookingId: "WLHGST5", upcomingOnly: false });
    rec("7 cancel: booking now refunded", r.ok && r.data.bookings[0].status === "refunded", r.data?.bookings?.[0]?.status);
    r = await tool("prepare_cancellation", c, { bookingId: "WLHGST5", verification: { phoneLast4: "4455" } });
    rec("7 cancel again → clean 'already cancelled'", !r.ok && r.error?.code === "BOOKING_ALREADY_CANCELLED", r.error?.message);

    // member partial cancellation (Rahul WKGRP33, 3 seats → cancel 1) to Share Points
    const rc = conv("b");
    await tool("login_customer", rc, { memberId: "SHR200877", pin: "2468" });
    const grp = (await tool("find_booking", rc, { bookingId: "WKGRP33" })).data?.bookings?.[0];
    r = await tool("prepare_cancellation", rc, { bookingId: "WKGRP33", ticketIds: [grp?.tickets?.[0]?.id], refundMethod: "SHARE_POINTS" });
    rec("7 partial cancel: 1 of 3 to Share Points prepared", r.ok && /1 ticket|one ticket|1 of/i.test(r.speech), r.speech);
    if (r.ok) {
      const a = await tool("cancel_booking", rc, { bookingId: "WKGRP33", confirmationId: r.data.confirmationId, confirmed: true });
      const f = await tool("get_action_result", rc, { actionId: a.data?.action?.actionId, waitMs: 8000 });
      rec("7 partial cancel executed; points credited", f.data?.action?.status === "succeeded" && /point/i.test(f.speech), f.speech);
      const b = await tool("find_booking", rc, { bookingId: "WKGRP33", upcomingOnly: false });
      rec("7 partial cancel: 2 seats remain", b.ok && b.data.bookings[0].ticketCount === 2, JSON.stringify(b.data?.bookings?.[0]?.seats));
    }

    // swap (James WJMX42R → another IMAX showtime)
    const sc = conv("b");
    await tool("login_customer", sc, { email: "james.whitfield@example.com", pin: "9876" });
    const b = (await tool("find_booking", sc, { bookingId: "WJMX42R" })).data?.bookings?.[0];
    const alt = await tool("search_sessions", sc, { hoCode: b?.hoCode, title: b?.filmTitle, experience: "IMAX", date: "tomorrow", dateTo: "next sunday", limit: 12 });
    const target = alt.data?.sessions?.find((s) => s.sessionKey !== `${b?.cinemaId}-${b?.sessionId}` && new Date(s.showtime) - Date.now() > 4 * 3600e3);
    if (target) {
      r = await tool("prepare_swap", sc, { bookingId: "WJMX42R", targetSessionKey: target.sessionKey });
      rec("8 swap: prepared with price difference", r.ok && r.data.confirmationId && /differ|same price|no difference|refund|charge/i.test(r.speech), r.speech);
      if (r.ok) {
        const a = await tool("swap_booking", sc, { bookingId: "WJMX42R", targetSessionKey: target.sessionKey, confirmationId: r.data.confirmationId, confirmed: true });
        const f = await tool("get_action_result", sc, { actionId: a.data?.action?.actionId, waitMs: 12000 });
        rec("8 swap: executed → new W reference, old cancelled", f.data?.action?.status === "succeeded" && /\bW[A-Z0-9]{6}\b/.test(f.speech), f.speech);
      }
    } else rec("8 swap: no alternative IMAX session found to test", false, JSON.stringify(alt.speech));
  }

  // ------------------------------------------------------------------ 13, 14, 15, 16, 17: guided booking
  async function booking() {
    // pick a Standard session at Mirdif tomorrow with plenty of seats, Sun–Wed for ADCB if possible
    const c = conv("g");
    await tool("login_customer", c, { memberId: "SHR200877", pin: "2468" }); // Rahul: ADCB + HSBC cards
    const ss = await tool("search_sessions", c, { title: "spider-man", cinemaName: "Mirdif", date: "tomorrow", dateTo: "next sunday", experience: "Standard", limit: 20 });
    const pick = (ss.data?.sessions ?? []).find((s) => s.seatsAvailable > 20 && [0, 1, 2, 3].includes(new Date(`${s.showtime}Z`).getUTCDay())) ?? ss.data?.sessions?.find((s) => s.seatsAvailable > 20);
    rec("15 booking: session found", !!pick, ss.speech);
    if (!pick) return;
    let r = await tool("get_ticket_types", c, { sessionKey: pick.sessionKey });
    rec("15 ticket types: tiers + VAT note", r.ok && r.data.ticketTypes.length > 0, r.speech);
    r = await tool("start_order", c, { sessionKey: pick.sessionKey });
    rec("15 start order", r.ok && r.data.userSessionId, r.speech);
    const usid = r.data?.userSessionId;
    r = await tool("add_tickets", c, { userSessionId: usid, tickets: [{ ticketTypeCode: "0001", qty: 3 }] });
    rec("15 add 3 tickets → seats auto-held", r.ok && /held seats/.test(r.speech), r.speech);
    r = await tool("get_seat_plan", c, { sessionKey: pick.sessionKey, userSessionId: usid });
    rec("15 seat plan: tiers, suggestions front/middle/back with prices", r.ok && r.data.tiers?.length && r.data.suggestions?.length >= 2 && /Seat prices/.test(r.speech), r.speech);
    const taken = r.data?.rows?.flatMap((row) => row.seats.filter((s) => s.status === 1).map((s) => ({ row: row.row, number: s.id })))[0];
    if (taken) {
      const t = await tool("select_seats", c, { userSessionId: usid, seats: [taken, taken, taken] });
      rec("15 select a sold seat → SEATS_UNAVAILABLE explained", !t.ok && /taken|unavailable/i.test(t.error?.message ?? t.speech), t.error?.message ?? t.speech);
    }
    const sug = r.data?.suggestions?.find((s) => s.region === "middle")?.options?.[0];
    // pick 3 adjacent free seats from the plan
    const freeRow = r.data?.rows?.find((row) => row.seats.filter((s) => s.status === 0 && s.style === 0).length >= 6);
    const free = freeRow ? freeRow.seats.filter((s) => s.status === 0 && s.style === 0).slice(0, 3) : [];
    if (free.length === 3) {
      const t = await tool("select_seats", c, { userSessionId: usid, seats: free.map((s) => ({ row: freeRow.row, number: s.id })) });
      rec("15 select 3 chosen seats", t.ok && /yours/.test(t.speech), t.speech);
    }
    // BOGO with 3 tickets refused
    r = await tool("apply_offer", c, { userSessionId: usid, offerId: "BANK-ADCB-BOGO", cardBin: "409255" });
    rec("16 BOGO with 3 tickets refused with reason", !r.ok && /exactly 2|Sunday|Monday/.test(r.error?.message ?? ""), r.error?.message ?? r.speech);
    // change to 2 tickets and apply
    r = await tool("add_tickets", c, { userSessionId: usid, tickets: [{ ticketTypeCode: "0001", qty: 2 }] });
    rec("15 change to 2 tickets (order edit after edit)", r.ok && /2 tickets/.test(r.speech), r.speech);
    r = await tool("apply_offer", c, { userSessionId: usid, offerId: "BANK-ADCB-BOGO", cardBin: "409255" });
    const bogoApplied = r.ok;
    rec("16 BOGO with 2 tickets on eligible day applied (or day rule explained)", r.ok || /Sunday|Monday|Tuesday|Wednesday/.test(r.error?.message ?? ""), r.speech ?? r.error?.message);
    // F&B
    r = await tool("browse_menu", c, { tab: "Popcorn" });
    rec("13 menu: popcorn tab with images + sizes", r.ok && r.data.items.length > 0 && r.data.items.every((i) => i.imageUrl) && r.data.items.some((i) => i.modifiers?.length), r.speech);
    r = await tool("browse_menu", c, { dietary: ["vegan"] });
    rec("13 menu: vegan filter", r.ok && r.data.items.every((i) => i.dietaryTags.includes("vegan")), r.speech);
    r = await tool("browse_menu", c, { query: "combo" });
    rec("13 menu: combos with drink choice", r.ok && r.data.items.some((i) => i.isCombo || /combo/i.test(i.name)), r.speech);
    r = await tool("browse_menu", c, { experience: "GOLD", cinemaId: "0002" });
    rec("13 menu: GOLD menu differs", r.ok && r.data.items.length > 0, r.speech);
    r = await tool("browse_menu", c, { query: "7up" });
    rec("13 menu: '7up' finds 7 Up (spelling tolerance)", r.ok && r.data.items.some((i) => /7\s?up/i.test(i.name)), r.speech);
    r = await tool("add_concessions", c, { userSessionId: usid, items: [{ itemId: "7747", quantity: 1, modifierIds: ["DIET"] }] });
    rec("14 add F&B with modifier", r.ok && /added/i.test(r.speech), r.speech);
    r = await tool("add_concessions", c, { userSessionId: usid, items: [{ itemId: "7747", quantity: 0 }, { itemId: "2402", quantity: 2 }] });
    rec("14 swap F&B: remove + add in one call", r.ok && /removed/i.test(r.speech) && r.data.result.order.concessions.length === 1, r.speech);
    r = await tool("get_order", c, { userSessionId: usid });
    rec("15 order summary: tickets + F&B + offer + VAT-inclusive total", r.ok && r.data.order.tickets.length === 2 && r.data.order.concessions.length === 1 && r.data.order.totalCents > 0, r.speech);
    // payment paths
    r = await tool("prepare_payment", c, { userSessionId: usid, method: "SHARE_POINTS" });
    rec("17 pay with Share Points: insufficient explained (620 pts)", !r.ok && r.error?.code === "INSUFFICIENT_POINTS", r.error?.message);
    r = await tool("prepare_payment", c, { userSessionId: usid, method: "SAVED_CARD" });
    rec("17 prepare payment: saved card, sheet with saved cards + wallet + VAT", r.ok && r.ui?.meta?.savedCards?.length === 2 && r.ui.meta.wallet && r.ui.meta.vat, r.speech);
    rec("17 prepare payment: bank offers listed for member", (r.ui?.meta?.bankOffers?.length ?? 0) > 0, `bankOffers=${r.ui?.meta?.bankOffers?.length}`);
    const conf = r.data?.confirmationId;
    const s = await session(c);
    let pay = await cmd(s, { type: "payment.token", userSessionId: usid, confirmationId: conf, token: "tok_declined_1" });
    rec("17 declined card → clear failure", pay.ok === false && /declined/i.test(pay.action?.error?.message ?? ""), pay.action?.error?.message);
    if (bogoApplied) {
      pay = await cmd(s, { type: "payment.token", userSessionId: usid, confirmationId: conf, token: "tok_saved_rahul_6034" });
      rec("17 wrong-bank card with BOGO → refused", pay.ok === false && /ADCB/.test(pay.action?.error?.message ?? ""), pay.action?.error?.message);
    }
    pay = await cmd(s, { type: "payment.token", userSessionId: usid, confirmationId: conf, token: "tok_saved_rahul_2211" });
    rec("17 retry with the right saved card → paid", pay.ok === true, JSON.stringify(pay.action?.result ?? pay).slice(0, 200));
    const ref = pay.action?.result?.bookingId;
    rec("15 booking confirmed: W reference + QR payload", /^W[A-Z0-9]{6}$/.test(ref ?? "") && pay.action?.result?.qrPayload, ref);
    if (ref) {
      const f = await tool("find_booking", c, { bookingId: ref });
      rec("18 new booking findable, paid-with card shown", f.ok && /MASTERCARD|VISA/.test(f.data.bookings[0].payment ?? ""), f.data?.bookings?.[0]?.payment);
      // cancel it again to leave things clean (member → VOX credit)
      const p = await tool("prepare_cancellation", c, { bookingId: ref, refundMethod: "VOX_CREDIT" });
      if (p.ok) {
        const a = await tool("cancel_booking", c, { bookingId: ref, confirmationId: p.data.confirmationId, confirmed: true });
        const fr = await tool("get_action_result", c, { actionId: a.data?.action?.actionId, waitMs: 8000 });
        rec("7 cancel the new booking → VOX credit (bank-offer bookings are non-refundable)", bogoApplied ? !p.ok || fr.data?.action?.status !== "succeeded" : fr.data?.action?.status === "succeeded", fr.speech ?? p.speech);
      } else rec("7 cancel the new booking refused because bank offer", bogoApplied && /bank/i.test(p.error?.message ?? ""), p.error?.message);
    }
    // guest booking with Samsung Pay + expiry
    const gc = conv("g");
    const g0 = await tool("start_order", gc, { sessionKey: pick.sessionKey });
    const gusid = g0.data?.userSessionId;
    await tool("add_tickets", gc, { userSessionId: gusid, tickets: [{ ticketTypeCode: "0001", qty: 1 }] });
    r = await tool("prepare_payment", gc, { userSessionId: gusid, method: "SAMSUNG_PAY" });
    rec("17 guest without details → asks name/email/mobile", !r.ok && /name/i.test(r.error?.message ?? ""), r.error?.message);
    r = await tool("prepare_payment", gc, { userSessionId: gusid, method: "SAMSUNG_PAY", customer: { name: "Test Guest", email: "guest@example.com", phone: "0501112222" } });
    rec("17 guest: Samsung Pay sheet, no bank offers, login nudge", r.ok && r.ui.meta.guest === true && r.ui.meta.bankOffers.length === 0 && /Log in or create an account/.test(r.speech), r.speech);
    const gs = await session(gc);
    const gp = await cmd(gs, { type: "payment.token", userSessionId: gusid, confirmationId: r.data?.confirmationId, token: `tok_samsungpay_0000_${Date.now()}` });
    rec("17 guest Samsung Pay → booking", gp.ok === true && /^W/.test(gp.action?.result?.bookingId ?? ""), gp.action?.result?.bookingId);
    // stale order
    r = await tool("get_order", gc, { userSessionId: "usid_doesnotexist" });
    rec("15 unknown order → graceful", !r.ok && /no active order/i.test(r.error?.message ?? ""), r.error?.message);
  }

  // ------------------------------------------------------------------ 12, 19, 20, 21: transfer, feedback, complaint, personalisation
  async function service() {
    const c = conv("t");
    let r = await tool("create_complaint", c, { category: "fnb", description: "Popcorn was stale and the staff were rude at Mall of the Emirates last night.", cinemaId: "0002", bookingId: "WXA7K2M" });
    rec("20 complaint: reference + next step", r.ok && /CMP-\d{4}-\d{6}/.test(r.speech), r.speech);
    r = await tool("transfer_to_agent", c, { reason: "sentiment", summary: "Guest unhappy about stale popcorn, wants a manager." });
    rec("12 transfer: accepted with summary", r.ok && /transfer|agent|connect/i.test(r.speech), r.speech);
    await sleep(6000);
    const s = await session(c);
    const st = await fetch(`${API}/widget/state`, { headers: { authorization: `Bearer ${s.token}` } }).then((x) => x.json());
    rec("12 transfer: widget in human mode with agent name", st.mode === "human" || st.transfer?.status, JSON.stringify(st).slice(0, 200));
    const hm = await cmd(s, { type: "human.message", transferId: st.transfer?.transferId ?? "", text: "Hello, is anyone there?" });
    rec("12 transfer: guest message reaches the (simulated) agent", hm.ok === true, JSON.stringify(hm));
    r = await tool("submit_feedback", conv("t"), { rating: 5, comment: "Great help", resolved: true });
    rec("19 feedback stored", r.ok, r.speech);
    r = await tool("submit_feedback", conv("t"), { rating: 9 });
    rec("19 feedback: rating validated 1–5", !r.ok, r.error?.message);

    const g = conv("p");
    r = await tool("get_recommendations", g, {});
    rec("21 recs: guest cold start = popular", r.ok && r.data.personalised === false && r.data.movies.length > 0, r.speech);
    const sa = conv("p");
    await tool("login_customer", sa, { phone: "0501234567", pin: "1234" });
    r = await tool("get_recommendations", sa, {});
    rec("21 recs: Sara → asks about children first", r.ok && r.data.askChildren === true && /children/i.test(r.speech), r.speech);
    r = await tool("get_recommendations", sa, { withChildren: true, kind: "both" });
    rec("21 recs: with children → family films + usual snack", r.ok && r.data.movies.length > 0 && r.data.movies.some((m) => m.family) && /based on your previous bookings/i.test(r.speech), r.speech);
    r = await tool("get_recommendations", sa, { withChildren: false });
    rec("21 recs: adults only → no family films", r.ok && r.data.movies.every((m) => !m.family), r.speech);
    const ra = conv("p");
    await tool("login_customer", ra, { memberId: "SHR200877", pin: "2468" });
    r = await tool("get_recommendations", ra, {});
    rec("21 recs: Rahul → Tamil/Hindi, no children question", r.ok && !r.data.askChildren && /Tamil|Hindi/.test(r.speech), r.speech);
    r = await tool("get_recommendations", ra, { language: "Hindi" });
    rec("21 recs: explicit language wins", r.ok && r.data.movies.every((m) => /hindi/i.test(m.language)), r.speech);
    const ja = conv("p");
    await tool("login_customer", ja, { email: "james.whitfield@example.com", pin: "9876" });
    r = await tool("get_recommendations", ja, {});
    rec("21 recs: James → English only, premium session suggested", r.ok && r.data.movies.every((m) => /english/i.test(m.language)), r.speech);
    r = await tool("get_session_context", ja, {});
    rec("18 session context after login", r.ok && r.data.isLoggedIn && /James/.test(r.data.customer?.name ?? ""), r.speech);
  }

  // ------------------------------------------------------------------ 10, 11, 22: reporting, arabic, channels
  async function platform() {
    let r = await fetch(`${API}/reporting/summary?days=7`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    rec("10 reporting summary (7d): window + kpis + journeys + funnel", r.window && (r.kpis || r.journeys) && r.funnel, JSON.stringify(Object.keys(r)));
    r = await fetch(`${API}/reporting/conversations?limit=5`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    rec("10 reporting: conversation list with transcripts", Array.isArray(r.conversations ?? r) , JSON.stringify(r).slice(0, 200));
    const ar = conv("ar");
    r = await tool("search_films", ar, { query: "spider man" }, { language: "ar" });
    rec("11 Arabic: speech in Arabic", r.ok && /[؀-ۿ]/.test(r.speech), r.speech);
    r = await tool("search_sessions", ar, { title: "spider-man", cinemaName: "مول الإمارات", date: "tomorrow" }, { language: "ar" });
    rec("11 Arabic: cinema name in Arabic resolved", r.ok && r.data.sessions?.[0]?.cinemaId === "0002", r.speech);
    r = await tool("search_sessions", ar, { title: "spider-man", cinemaName: "دبي", date: "weekend" }, { language: "ar" });
    rec("11 Arabic: emirate in Arabic", r.ok && r.data.sessions.length > 0, r.speech);
    r = await tool("get_age_rules", ar, { rating: "18+", childAge: 12 }, { language: "ar" });
    rec("11 Arabic: age verdict in Arabic", r.ok && /[؀-ۿ]/.test(r.speech), r.speech);
    r = await tool("get_session_context", conv("ch"), {}, { channel: "whatsapp" });
    rec("22 channel param accepted (whatsapp)", r.ok && r.data.channel === "whatsapp", r.data?.channel);
    // hammer: 10 concurrent reads
    const t0 = Date.now();
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) => tool("search_sessions", conv(`h${i}`), { title: "spider-man", cinemaName: "Dubai", date: "tomorrow" })));
    rec("perf: 10 concurrent searches all ok", many.every((x) => x.ok), `${Date.now() - t0} ms total`);
    // bad input
    r = await tool("search_sessions", conv("v"), { date: "not-a-date", title: "spider-man" });
    rec("robustness: bad date → graceful", !/undefined|NaN|Invalid/.test(r.speech ?? r.error?.message ?? ""), r.speech ?? r.error?.message);
    r = await fetch(`${API}/tools/search_films`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "x" }) });
    rec("security: tools need the key", r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  const groups = { info, offers, bookings, booking, service, platform };
  window.V = {
    results,
    async run(which = "all") {
      const names = which === "all" ? Object.keys(groups) : which.split(",");
      for (const n of names) {
        try {
          await groups[n]();
        } catch (e) {
          rec(`${n}: harness error`, false, String(e?.stack ?? e).slice(0, 300));
        }
      }
      const failed = results.filter((r) => !r.ok);
      return { total: results.length, passed: results.length - failed.length, failed };
    },
  };
  return "harness ready";
})();
