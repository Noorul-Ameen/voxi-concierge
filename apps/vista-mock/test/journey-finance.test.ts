import { randomUUID } from "node:crypto";
import { schema as S, flattenLayout, nowLocalDate } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { exchangeBooking } from "../src/services/exchange.js";
import { loadSeatState } from "../src/services/orders.js";
import { consumeWalletCredits, expireWalletCredits } from "../src/services/wallet.js";
import { testApp } from "./helpers.js";

const app = testApp();
const tag = randomUUID().slice(0, 8);
const memberId = `JOURNEY_${tag}`;
const bankOffer = `bank_${tag}`;
let source: typeof S.sessions.$inferSelect;
let target: typeof S.sessions.$inferSelect;
let ticket: typeof S.ticketTypes.$inferSelect;
beforeAll(async () => {
  await app.auth();
  await app.db.insert(S.loyaltyAccounts).values({
    memberId,
    customerId: "cust_sara",
    sharePointsBalance: 100000,
    voxRewardsBalanceCents: 100000,
  });
  await app.db.insert(S.offers).values({
    id: bankOffer,
    title: "Test bank offer",
    shortDescription: "Isolated fixture",
    type: "bank",
    rules: { bankBins: ["424242"] },
    benefit: { type: "percent_off", percent: 20, appliesTo: "tickets" },
  });
  const [base] = await app.db
    .select()
    .from(S.sessions)
    .where(and(eq(S.sessions.cinemaId, "0005"), eq(S.sessions.experience, "Standard")))
    .limit(1);
  expect(base).toBeTruthy();
  const show = new Date(nowLocalDate().getTime() + 48 * 60 * 60_000);
  [source] = await app.db
    .insert(S.sessions)
    .values({ ...base!, sessionId: `j${tag}a`, showtime: show, allowTicketSales: true, soldoutStatus: 0 })
    .returning();
  [target] = await app.db
    .insert(S.sessions)
    .values({
      ...base!,
      sessionId: `j${tag}b`,
      showtime: new Date(show.getTime() + 120 * 60_000),
      allowTicketSales: true,
      soldoutStatus: 0,
    })
    .returning();
  const types = await app.db
    .select()
    .from(S.ticketTypes)
    .where(and(eq(S.ticketTypes.cinemaId, "0005"), eq(S.ticketTypes.experience, "Standard")));
  ticket = types.find(
    (t) => t.areaCategoryCode === "0000000002" && !t.isChildOnlyTicket && !t.isAvailableForLoyaltyMembersOnly,
  )!;
  expect(ticket).toBeTruthy();
});
afterAll(async () => {
  await app.close();
});

async function hold(quantity = 1) {
  const id = `jf_${randomUUID()}`;
  const result = await app.post("/Ticketing/Order/tickets", {
    UserSessionId: id,
    CinemaId: source.cinemaId,
    SessionId: source.sessionId,
    TicketTypes: [{ TicketTypeCode: ticket.ticketTypeCode, Qty: quantity }],
  });
  expect(result.json.Result, JSON.stringify(result.json)).toBe(0);
  return result.json.Order;
}
async function pay(order: any, tenders?: any[]) {
  return app.post("/Ticketing/order/payment", {
    UserSessionId: order.UserSessionId,
    CustomerId: "cust_sara",
    MemberId: memberId,
    CustomerName: "Journey Test",
    CustomerEmail: "journey@example.com",
    CustomerPhone: "0500000000",
    PaymentInfoCollection: tenders ?? [
      {
        PaymentTenderCategory: "CREDIT",
        PaymentValueCents: order.TotalValueCents,
        PaymentToken: "tok_visa_424242_4242_test",
      },
    ],
  });
}
async function booking(adjustOriginalCents = 0) {
  const order = await hold();
  const result = await pay(order);
  expect(result.json.Result, JSON.stringify(result.json)).toBe(0);
  const [b] = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.vistaBookingId, result.json.VistaBookingId));
  if (!adjustOriginalCents) return b!;
  const [changed] = await app.db
    .update(S.bookings)
    .set({
      totalValueCents: b!.totalValueCents + adjustOriginalCents,
      tickets: b!.tickets.map((t, i) =>
        i
          ? t
          : {
              ...t,
              PriceCents: t.PriceCents + adjustOriginalCents,
              FinalPriceCents: t.FinalPriceCents + adjustOriginalCents,
            },
      ),
      payments: b!.payments.map((p, i) =>
        i ? p : { ...p, PaymentValueCents: p.PaymentValueCents + adjustOriginalCents },
      ),
    })
    .where(eq(S.bookings.vistaBookingId, b!.vistaBookingId))
    .returning();
  return changed!;
}
async function request(b: typeof S.bookings.$inferSelect) {
  const loaded = await app.db.transaction((tx) => loadSeatState(tx, target.cinemaId, target.sessionId));
  const available = Object.entries(loaded.state.seats).find(
    ([key, value]) =>
      value.status === 0 &&
      flattenLayout(loaded.tpl.layout).some(
        (s) =>
          s.areaCategoryCode === ticket.areaCategoryCode &&
          s.style === 0 &&
          s.row === key.split(":")[0] &&
          s.number === key.split(":")[1],
      ),
  );
  expect(available).toBeTruthy();
  const [Row, seatNumber] = available![0].split(":");
  const total = ticket.priceInCents + app.cfg.order.bookingFeeCentsPerTicket;
  return {
    BookingId: b.vistaBookingId,
    TargetCinemaId: target.cinemaId,
    TargetSessionId: target.sessionId,
    ExpectedVersion: b.version,
    ExpectedTotalCents: total,
    ExpectedDifferenceCents: total - b.totalValueCents,
    Seats: [{ Row: Row!, Number: seatNumber!, TicketTypeCode: ticket.ticketTypeCode }],
    PaymentMethod: "CARD",
    RefundMethod: "ORIGINAL_PAYMENT",
    Reference: `x_${randomUUID().slice(0, 16)}`,
    ConversationId: `conv_${tag}`,
  };
}

it("rejects bank offers with either balance and mixed card/balance tenders, leaving the order unpaid", async () => {
  const order = await hold(2);
  const applied = await app.post("/Ticketing/Order/offers", {
    UserSessionId: order.UserSessionId,
    OfferId: bankOffer,
    CardBin: "424242",
    MemberId: memberId,
  });
  expect(applied.json.Result).toBe(0);
  const total = applied.json.Order.TotalValueCents;
  for (const category of ["EWALLET", "LOYALTY"]) {
    const result = await pay(applied.json.Order, [
      {
        PaymentTenderCategory: "CREDIT",
        PaymentValueCents: total - 100,
        PaymentToken: "tok_visa_424242_4242_test",
      },
      { PaymentTenderCategory: category, PaymentValueCents: 100, MemberId: memberId, PointsRedeemed: 10 },
    ]);
    expect(result.json.Result).not.toBe(0);
    expect(result.json.ErrorDescription).toMatch(/bank|card.offer/i);
  }
  const reserved = await app.post("/Ticketing/Order/loyalty-redeem", {
    UserSessionId: order.UserSessionId,
    MemberId: memberId,
    Points: 10,
  });
  expect(reserved.json.Result).not.toBe(0);
  const [stored] = await app.db
    .select()
    .from(S.orders)
    .where(eq(S.orders.userSessionId, order.UserSessionId));
  expect(stored?.completedBookingId).toBeNull();
});
it("previews removal without mutation and applies only the agreed repriced total once, preserving the deadline", async () => {
  const initial = await hold(2);
  const applied = await app.post("/Ticketing/Order/offers", {
    UserSessionId: initial.UserSessionId,
    OfferId: bankOffer,
    CardBin: "424242",
    MemberId: memberId,
  });
  const preview = await app.post("/Ticketing/Order/offers/preview-removal", {
    UserSessionId: initial.UserSessionId,
    OfferIds: [bankOffer],
  });
  expect(preview.json.Preview).toMatchObject({
    currentTotalCents: applied.json.Order.TotalValueCents,
    totalAfterCents: initial.TotalValueCents,
    expiresAtUtc: initial.ExpiryDateUtc,
  });
  const request = {
    UserSessionId: initial.UserSessionId,
    Remove: true,
    OfferIds: [bankOffer],
    ExpectedVersion: preview.json.Preview.expectedVersion,
    ExpectedTotalCents: initial.TotalValueCents,
  };
  const wrong = await app.post("/Ticketing/Order/offers", {
    ...request,
    ExpectedTotalCents: initial.TotalValueCents + 100,
  });
  expect(wrong.json.Result).not.toBe(0);
  const done = await app.post("/Ticketing/Order/offers", request);
  const retry = await app.post("/Ticketing/Order/offers", request);
  expect(done.json.Order.TotalValueCents).toBe(initial.TotalValueCents);
  expect(retry.json.Order.Version).toBe(done.json.Order.Version);
  expect(done.json.Order.ExpiryDateUtc).toBe(initial.ExpiryDateUtc);
});
it("debits reserved partial SHARE exactly once and records full payment value, while forbidding a later bank offer", async () => {
  const order = await hold();
  const reserved = await app.post("/Ticketing/Order/loyalty-redeem", {
    UserSessionId: order.UserSessionId,
    MemberId: memberId,
    Points: 100,
    BalanceType: "SHARE_POINTS",
  });
  expect(reserved.json.Result).toBe(0);
  expect(reserved.json.Order.TotalValueCents).toBe(order.TotalValueCents - 1000);
  const incompatible = await app.post("/Ticketing/Order/offers", {
    UserSessionId: order.UserSessionId,
    OfferId: bankOffer,
    CardBin: "424242",
    MemberId: memberId,
  });
  expect(incompatible.json.Result).not.toBe(0);
  const first = await pay(reserved.json.Order);
  const retry = await pay(reserved.json.Order);
  expect(first.json.Result, JSON.stringify(first.json)).toBe(0);
  expect(retry.json.VistaBookingId).toBe(first.json.VistaBookingId);
  const [b] = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.vistaBookingId, first.json.VistaBookingId));
  expect(b?.totalValueCents).toBe(order.TotalValueCents);
  expect(b?.payments.reduce((n, p) => n + p.PaymentValueCents, 0)).toBe(order.TotalValueCents);
  const ledger = await app.db
    .select()
    .from(S.loyaltyLedger)
    .where(
      and(
        eq(S.loyaltyLedger.memberId, memberId),
        eq(S.loyaltyLedger.reference, order.UserSessionId),
        eq(S.loyaltyLedger.reason, "Ticket purchase"),
      ),
    );
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.delta).toBe(-100);
});
for (const adjustment of [-1000, 0, 1000])
  it(`exchanges atomically with ${-adjustment} cents difference and no full charge/refund`, async () => {
    const b = await booking(adjustment);
    const req = await request(b);
    const exchanged = await exchangeBooking(app.db, req, app.cfg.order);
    expect(exchanged.differenceCents).toBe(adjustment === 0 ? 0 : -adjustment);
    expect(exchanged.booking.payments.reduce((n, p) => n + p.PaymentValueCents, 0)).toBe(
      req.ExpectedTotalCents,
    );
    expect(
      exchanged.booking.payments
        .filter((p) => p.Reference === req.Reference)
        .reduce((n, p) => n + p.PaymentValueCents, 0),
    ).toBe(Math.max(0, -adjustment));
    const refunds = await app.db.select().from(S.refunds).where(eq(S.refunds.reference, req.Reference));
    expect(refunds).toHaveLength(adjustment > 0 ? 1 : 0);
    if (adjustment > 0) expect(refunds[0]?.amountCents).toBe(adjustment);
    const retry = await exchangeBooking(app.db, req, app.cfg.order);
    expect(retry.booking.vistaBookingId).toBe(exchanged.booking.vistaBookingId);
    expect(retry.idempotent).toBe(true);
    const [original] = await app.db
      .select()
      .from(S.bookings)
      .where(eq(S.bookings.vistaBookingId, b.vistaBookingId));
    expect(original?.status).toBe("swapped");
  });
it("retains the original booking, money and seats after a stale price or occupied target seat", async () => {
  const b = await booking();
  const req = await request(b);
  await expect(
    exchangeBooking(app.db, { ...req, ExpectedTotalCents: req.ExpectedTotalCents + 1 }, app.cfg.order),
  ).rejects.toThrow(/price changed/i);
  const busy = await booking();
  const busyReq = await request(busy);
  await exchangeBooking(app.db, busyReq, app.cfg.order);
  await expect(exchangeBooking(app.db, { ...req, Seats: busyReq.Seats }, app.cfg.order)).rejects.toThrow(
    /seat.*available/i,
  );
  const [original] = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.vistaBookingId, b.vistaBookingId));
  expect(original).toEqual(b);
  const refunds = await app.db.select().from(S.refunds).where(eq(S.refunds.reference, req.Reference));
  expect(refunds).toHaveLength(0);
});
it("credits a wallet refund once, spends expiring credit first and expires only its unused remainder after 90 days", async () => {
  const b = await booking();
  const reference = `wallet_${tag}`;
  const [before] = await app.db
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  const refund = () =>
    app.post("/RESTBooking.svc/booking/refund", {
      BookingId: b.vistaBookingId,
      RefundTenderCategory: "EWALLET",
      ExpectedAmountCents: b.totalValueCents,
      Reference: reference,
    });
  const results = await Promise.all([refund(), refund()]);
  expect(results.map((r) => r.json.Result)).toEqual([0, 0]);
  const lots = await app.db.select().from(S.loyaltyLedger).where(eq(S.loyaltyLedger.reference, reference));
  expect(lots).toHaveLength(1);
  expect(lots[0]?.remainingValueCents).toBe(b.totalValueCents);
  expect(lots[0]!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60_000);
  await app.db.transaction(async (tx) => {
    await expireWalletCredits(tx, memberId);
    await consumeWalletCredits(tx, memberId, 100);
    await tx
      .update(S.loyaltyAccounts)
      .set({ voxRewardsBalanceCents: before!.voxRewardsBalanceCents + b.totalValueCents - 100 })
      .where(eq(S.loyaltyAccounts.memberId, memberId));
  });
  await app.db.transaction((tx) =>
    expireWalletCredits(tx, memberId, new Date(lots[0]!.expiresAt!.getTime() - 1)),
  );
  const [notExpired] = await app.db
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  expect(notExpired?.voxRewardsBalanceCents).toBe(before!.voxRewardsBalanceCents + b.totalValueCents - 100);
  await app.db.transaction((tx) => expireWalletCredits(tx, memberId, lots[0]!.expiresAt!));
  await app.db.transaction((tx) => expireWalletCredits(tx, memberId, lots[0]!.expiresAt!));
  const [after] = await app.db
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  expect(after?.voxRewardsBalanceCents).toBe(before!.voxRewardsBalanceCents);
});

it.each([
  ["VOX_CREDIT", -1000],
  ["VOX_CREDIT", 1000],
  ["SHARE_POINTS", -1000],
  ["SHARE_POINTS", 1000],
] as const)(
  "settles only the exchange difference using %s with %i original adjustment once",
  async (method, adjustment) => {
    const b = await booking(adjustment);
    const base = await request(b);
    const req = { ...base, PaymentMethod: method, RefundMethod: method };
    const [before] = await app.db
      .select()
      .from(S.loyaltyAccounts)
      .where(eq(S.loyaltyAccounts.memberId, memberId));
    const result = await exchangeBooking(app.db, req, app.cfg.order);
    await exchangeBooking(app.db, req, app.cfg.order);
    expect(result.differenceCents).toBe(-adjustment);
    const records = await app.db
      .select()
      .from(S.loyaltyLedger)
      .where(and(eq(S.loyaltyLedger.memberId, memberId), eq(S.loyaltyLedger.reference, req.Reference)));
    expect(records).toHaveLength(1);
    expect(records[0]?.delta).toBe(method === "SHARE_POINTS" ? adjustment / 10 : adjustment);
    const [after] = await app.db
      .select()
      .from(S.loyaltyAccounts)
      .where(eq(S.loyaltyAccounts.memberId, memberId));
    expect(
      method === "SHARE_POINTS"
        ? after!.sharePointsBalance - before!.sharePointsBalance
        : after!.voxRewardsBalanceCents - before!.voxRewardsBalanceCents,
    ).toBe(method === "SHARE_POINTS" ? adjustment / 10 : adjustment);
    if (method === "VOX_CREDIT" && adjustment > 0) expect(records[0]?.expiresAt).toBeInstanceOf(Date);
  },
);
