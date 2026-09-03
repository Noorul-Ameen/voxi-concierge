/**
 * Concurrency proof (objective O3): fire many simultaneous, overlapping requests at the concierge and
 * assert that side effects happen exactly once.
 *   node infra/load/concurrency.mjs            (API at http://localhost:4020, secret from .env)
 */
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=").map((x, i) => (i === 0 ? x.trim() : x.split("#")[0].trim()))),
);
const API = process.env.CONCIERGE_URL ?? "http://localhost:4020";
const KEY = process.env.TOOL_HMAC_SECRET ?? env.TOOL_HMAC_SECRET;
const tool = async (name, conversationId, input) =>
  (
    await fetch(`${API}/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voxi-key": KEY },
      body: JSON.stringify({ conversationId, ...input }),
    })
  ).json();
const results = { pass: 0, fail: 0 };
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? results.pass++ : results.fail++;
};
const t0 = Date.now();

// 1. Same customer, one confirmation, 25 concurrent "yes" → one action, one refund
{
  const c = `load_cancel_${Date.now()}`;
  const prep = await tool("prepare_cancellation", c, {
    bookingId: "LHGUEST5",
    verification: { phoneLast4: "4455" },
  });
  if (!prep.ok) console.log("prep", prep);
  const rs = await Promise.all(
    Array.from({ length: 25 }, () =>
      tool("cancel_booking", c, {
        bookingId: "LHGUEST5",
        confirmationId: prep.data.confirmationId,
        confirmed: true,
      }),
    ),
  );
  const ids = new Set(rs.map((r) => r.data?.action?.actionId).filter(Boolean));
  const b = await tool("find_booking", c, { bookingId: "LHGUEST5", upcomingOnly: false });
  check(
    "25 concurrent confirmations → 1 action",
    ids.size === 1,
    `${ids.size} action ids; booking=${b.data.bookings[0].status}; refunded=${b.data.bookings[0].refundedCents}`,
  );
  check(
    "refund amount equals booking total (no double refund)",
    b.data.bookings[0].refundedCents === b.data.bookings[0].totalCents,
  );
}

// 2. Interleaved conversation: reads keep flowing while a write is in progress
{
  const c = `load_mix_${Date.now()}`;
  await tool("login_customer", c, { email: "james.whitfield@example.com", pin: "9876" });
  const prep = await tool("prepare_cancellation", c, { bookingId: "JWIMX42" });
  const started = Date.now();
  const [cancel, ...reads] = await Promise.all([
    tool("cancel_booking", c, {
      bookingId: "JWIMX42",
      confirmationId: prep.data.confirmationId,
      confirmed: true,
    }),
    ...Array.from({ length: 20 }, (_, i) =>
      tool(i % 2 ? "search_films" : "list_cinemas", c, i % 2 ? { query: "odyssey" } : {}),
    ),
  ]);
  check(
    "reads succeed while a write executes",
    reads.every((r) => r.ok),
    `${reads.length} reads in ${Date.now() - started}ms`,
  );
  check(
    "write completed exactly once",
    cancel.ok && cancel.data.action.status === "succeeded",
    cancel.data?.action?.status,
  );
}

// 3. Seat contention: 30 conversations racing for the same 2 seats → exactly one wins
{
  const s = await tool("search_sessions", `load_probe_${Date.now()}`, {
    cinemaName: "Deira",
    experience: "Standard",
    dateTo: "2099-01-01",
    limit: 60,
  });
  const now = new Date(Date.now() + 3 * 3600000 + 4 * 3600000).toISOString().slice(0, 19); // local ≈ utc+4
  const sess = s.data.sessions.find((x) => x.seatsAvailable > 40 && x.showtime > now);
  const plan = await tool("get_seat_plan", `load_probe_${Date.now()}`, { sessionKey: sess.sessionKey });
  const row = plan.data.rows.find((r) => r.seats.filter((x) => x.status === 0 && x.style === 0).length >= 6);
  const free = row.seats.filter((x) => x.status === 0 && x.style === 0).slice(2, 4);
  const seats = free.map((x) => ({ row: row.row, number: x.id }));
  const racers = await Promise.all(
    Array.from({ length: 30 }, async (_, i) => {
      const c = `load_seat_${Date.now()}_${i}`;
      const st = await tool("start_order", c, { sessionKey: sess.sessionKey });
      const usid = st.data.userSessionId;
      await tool("add_tickets", c, { userSessionId: usid, tickets: [{ ticketTypeCode: "STD0001", qty: 2 }] });
      const r = await tool("select_seats", c, { userSessionId: usid, seats });
      return r.ok && r.data?.action?.status === "succeeded";
    }),
  );
  const winners = racers.filter(Boolean).length;
  check("30 conversations racing for the same seats → exactly 1 wins", winners === 1, `${winners} winner(s)`);
}

// 4. Idempotent retries of the same order step
{
  const c = `load_idem_${Date.now()}`;
  const s = await tool("search_sessions", c, { cinemaName: "Yas", dateTo: "2099-01-01", limit: 60 });
  const now = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19);
  const sess = s.data.sessions.find((x) => x.seatsAvailable > 20 && x.showtime > now);
  const st = await tool("start_order", c, { sessionKey: sess.sessionKey });
  const usid = st.data.userSessionId;
  await tool("add_tickets", c, { userSessionId: usid, tickets: [{ ticketTypeCode: "0001", qty: 1 }] });
  const rs = await Promise.all(
    Array.from({ length: 10 }, () =>
      tool("add_concessions", c, {
        userSessionId: usid,
        items: [{ itemId: "101", quantity: 1 }],
        idempotencyKey: "retry-1",
      }),
    ),
  );
  const order = await tool("get_order", c, { userSessionId: usid });
  if (!order.ok) console.log(order, rs[0]);
  const qty = order.data.order.concessions.find((x) => x.itemId === "101")?.quantity;
  check("10 retried add_concessions with one idempotency key → quantity 1", qty === 1, `quantity=${qty}`);
}

console.log(`\n${results.pass} passed, ${results.fail} failed in ${Date.now() - t0}ms`);
process.exit(results.fail ? 1 : 0);
