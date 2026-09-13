import { randomUUID } from "node:crypto";
import { schema as S, nowLocalIso } from "@voxi/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { RC } from "../src/services/orders.js";
import { testApp } from "./helpers.js";

const app = testApp();
const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
const memberId = `VOX_SPLIT_${suffix}`;
const filmId = `VS${suffix}`;
const sessionId = `vsplit-${suffix}`;
const ticketCode = suffix;
const orderIds: string[] = [];
let cinemaId: string;
const gross = 14550;

beforeAll(async () => {
  await app.auth();
  const [source] = await app.db
    .select()
    .from(S.sessions)
    .where(
      and(
        eq(S.sessions.experience, "Standard"),
        eq(S.sessions.allowTicketSales, true),
        gt(S.sessions.seatsAvailable, 30),
        gt(S.sessions.showtime, new Date(`${nowLocalIso()}Z`)),
      ),
    )
    .limit(1);
  expect(source).toBeDefined();
  cinemaId = source!.cinemaId;
  const [ticket] = await app.db
    .select()
    .from(S.ticketTypes)
    .where(
      and(
        eq(S.ticketTypes.cinemaId, cinemaId),
        eq(S.ticketTypes.experience, "Standard"),
        eq(S.ticketTypes.isChildOnlyTicket, false),
        eq(S.ticketTypes.isAvailableForLoyaltyMembersOnly, false),
      ),
    )
    .limit(1);
  expect(ticket).toBeDefined();
  await app.db
    .insert(S.films)
    .values({ hoCode: filmId, title: "VOX split regression", rating: "PG", slug: `vox-split-${suffix}` });
  await app.db.insert(S.sessions).values({ ...source!, sessionId, hoCode: filmId });
  await app.db.insert(S.ticketTypes).values({
    ...ticket!,
    id: `split-${suffix}`,
    ticketTypeCode: ticketCode,
    priceInCents: gross - app.cfg.order.bookingFeeCentsPerTicket,
  });
  await app.db
    .insert(S.loyaltyAccounts)
    .values({ memberId, customerId: "cust_sara", sharePointsBalance: 100000, voxRewardsBalanceCents: 12000 });
});
beforeEach(async () => {
  await app.db
    .update(S.loyaltyAccounts)
    .set({ sharePointsBalance: 100000, voxRewardsBalanceCents: 12000 })
    .where(eq(S.loyaltyAccounts.memberId, memberId));
});
afterEach(async () => {
  for (const id of orderIds) await app.post("/Ticketing/order/cancel", { UserSessionId: id });
  const bookings = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.source, `split-${suffix}`));
  if (bookings.length) {
    const ids = bookings.map((b) => b.vistaBookingId);
    await app.db.delete(S.refunds).where(inArray(S.refunds.bookingId, ids));
    await app.db.delete(S.bookings).where(inArray(S.bookings.vistaBookingId, ids));
  }
  if (orderIds.length) await app.db.delete(S.orders).where(inArray(S.orders.userSessionId, orderIds));
  orderIds.length = 0;
  await app.db.delete(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, memberId));
});
afterAll(async () => {
  await app.db.delete(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId));
  await app.db.delete(S.ticketTypes).where(eq(S.ticketTypes.id, `split-${suffix}`));
  await app.db
    .delete(S.sessionSeatState)
    .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)));
  await app.db
    .delete(S.sessions)
    .where(and(eq(S.sessions.cinemaId, cinemaId), eq(S.sessions.sessionId, sessionId)));
  await app.db.delete(S.films).where(eq(S.films.hoCode, filmId));
  await app.close();
});

async function hold() {
  const id = `split-${randomUUID()}`;
  orderIds.push(id);
  const result = await app.post("/Ticketing/Order/tickets", {
    UserSessionId: id,
    CinemaId: cinemaId,
    SessionId: sessionId,
    TicketTypes: [{ TicketTypeCode: ticketCode, Qty: 1 }],
  });
  expect(result.json.Result).toBe(0);
  expect(result.json.Order.TotalValueCents).toBe(gross);
  return id;
}
async function order(id: string) {
  return (await app.db.select().from(S.orders).where(eq(S.orders.userSessionId, id)))[0]!;
}
async function account() {
  return (await app.db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId)))[0]!;
}
const ledger = () => app.db.select().from(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, memberId));
const redeem = (id: string, params: Record<string, unknown>) =>
  app.post("/Ticketing/Order/loyalty-redeem", { UserSessionId: id, MemberId: memberId, ...params });

it("replaces SHARE with one VOX reservation and clears it without spending or extending the hold", async () => {
  const id = await hold();
  const initial = await order(id);
  const initialAccount = await account();
  expect((await redeem(id, { BalanceType: "SHARE_POINTS", Points: 500 })).json.Redeemed.Amount).toBe(5000);
  expect((await redeem(id, { BalanceType: "VOX_REWARDS", Points: 12000 })).json.Redeemed.Amount).toBe(12000);
  const reserved = await order(id);
  expect(reserved.appliedOffers.filter((o) => o.type === "loyalty_redeem")).toEqual([
    expect.objectContaining({ offerId: "VOX_REWARDS", discountCents: 12000, pointsRedeemed: 12000 }),
  ]);
  expect(reserved.totalValueCents).toBe(2550);
  expect(reserved.expiryAt).toEqual(initial.expiryAt);
  expect(reserved.version).toBe(initial.version + 2);
  expect(await account()).toEqual(initialAccount);
  expect(await ledger()).toEqual([]);
  expect((await redeem(id, { BalanceType: "VOX_REWARDS", Points: 0 })).json.Redeemed.Amount).toBe(0);
  const cleared = await order(id);
  expect(cleared.loyaltyPointsPayableValueInCents).toBe(0);
  expect(cleared.appliedOffers).toEqual([]);
  expect(cleared.totalValueCents).toBe(gross);
  expect(cleared.version).toBe(reserved.version + 1);
  expect(cleared.expiryAt).toEqual(initial.expiryAt);
  expect(await account()).toEqual(initialAccount);
  expect(await ledger()).toEqual([]);
});

it("pays12000VOX plus2550card exactly once, rejects stale review, and refunds only a supported destination", async () => {
  const id = await hold();
  const initial = await order(id);
  await redeem(id, { BalanceType: "VOX_REWARDS", Points: 12000 });
  const reserved = await order(id);
  const pay = (version: number) =>
    app.post("/Ticketing/order/payment", {
      UserSessionId: id,
      ExpectedVersion: version,
      MemberId: memberId,
      CustomerEmail: "split-test@example.com",
      CustomerName: "Split Test",
      CustomerPhone: "0500000000",
      Source: `split-${suffix}`,
      PaymentInfoCollection: [
        {
          PaymentTenderCategory: "CREDIT",
          PaymentValueCents: 2550,
          PaymentToken: "tok_visa_4242_regression",
        },
      ],
    });
  expect((await pay(initial.version)).json.ExtendedResultCode).toBe(RC.INVALID_STATE);
  expect((await account()).voxRewardsBalanceCents).toBe(12000);
  expect(await ledger()).toEqual([]);
  const [first, retry] = await Promise.all([pay(reserved.version), pay(reserved.version)]);
  expect(first.json.Result).toBe(0);
  expect(retry.json.Result).toBe(0);
  expect(first.json.VistaBookingId).toBe(retry.json.VistaBookingId);
  const bookingId = first.json.VistaBookingId;
  const [booking] = await app.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, bookingId));
  expect(booking!.totalValueCents).toBe(gross);
  expect(
    booking!.payments.map((p) => ({ type: p.PaymentTenderCategory, value: p.PaymentValueCents })),
  ).toEqual([
    { type: "CREDIT", value: 2550 },
    { type: "EWALLET", value: 12000 },
  ]);
  expect((await order(id)).expiryAt).toEqual(initial.expiryAt);
  expect((await account()).voxRewardsBalanceCents).toBe(0);
  const paidLedger = await ledger();
  expect(paidLedger.filter((l) => l.reason === "Ticket purchase")).toEqual([
    expect.objectContaining({ balanceType: "VOX_REWARDS", delta: -12000, reference: id }),
  ]);
  expect(paidLedger.some((l) => l.balanceType === "SHARE_POINTS" && l.delta < 0)).toBe(false);
  const unsupported = await app.post("/RESTBooking.svc/booking/refund", {
    BookingId: bookingId,
    RefundTenderCategory: "CREDIT",
    Reference: `card-${suffix}`,
  });
  expect(unsupported.json.ExtendedResultCode).toBe(RC.BOOKING_NOT_REFUNDABLE);
  expect(await ledger()).toEqual(paidLedger);
  const reference = `wallet-${suffix}`;
  const refund = () =>
    app.post("/RESTBooking.svc/booking/refund", {
      BookingId: bookingId,
      RefundTenderCategory: "EWALLET",
      Reference: reference,
    });
  expect((await Promise.all([refund(), refund()])).map((r) => r.json.Result)).toEqual([0, 0]);
  expect((await ledger()).filter((l) => l.reference === reference)).toEqual([
    expect.objectContaining({
      balanceType: "VOX_REWARDS",
      delta: gross,
      remainingValueCents: gross,
      expiresAt: expect.any(Date),
    }),
  ]);
  expect((await account()).voxRewardsBalanceCents).toBe(gross);
});

it("explicit zero clears prior SHARE even with an empty wallet and card offer, without removing that offer", async () => {
  const id = await hold();
  await redeem(id, { BalanceType: "SHARE_POINTS", Points: 500 });
  const reserved = await order(id);
  const bank = { offerId: "regression-bank", type: "bank", title: "Bank offer", discountCents: 0 };
  await app.db
    .update(S.orders)
    .set({ appliedOffers: [...reserved.appliedOffers, bank] })
    .where(eq(S.orders.userSessionId, id));
  await app.db
    .update(S.loyaltyAccounts)
    .set({ voxRewardsBalanceCents: 0, sharePointsBalance: 0 })
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  const before = await account();
  expect((await redeem(id, { BalanceType: "VOX_REWARDS", Points: 0 })).json.Result).toBe(0);
  expect((await order(id)).appliedOffers).toEqual([bank]);
  expect((await order(id)).totalValueCents).toBe(gross);
  expect((await order(id)).expiryAt).toEqual(reserved.expiryAt);
  expect(await account()).toEqual(before);
  expect(await ledger()).toEqual([]);
});

it("omitted amount with no available VOX credit still fails and does not clear SHARE", async () => {
  const id = await hold();
  await redeem(id, { BalanceType: "SHARE_POINTS", Points: 500 });
  await app.db
    .update(S.loyaltyAccounts)
    .set({ voxRewardsBalanceCents: 0 })
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  const before = await order(id);
  expect((await redeem(id, { BalanceType: "VOX_REWARDS" })).json.ExtendedResultCode).toBe(
    RC.INSUFFICIENT_FUNDS,
  );
  expect(await order(id)).toEqual(before);
});

it.each([
  { BalanceType: "OTHER", Points: 0 },
  { BalanceType: null, Points: 0 },
  { BalanceType: "VOX_REWARDS", Points: -1 },
  { BalanceType: "VOX_REWARDS", Points: 1.5 },
  { BalanceType: "VOX_REWARDS", Points: "0" },
  { BalanceType: "VOX_REWARDS", Points: null },
  { BalanceType: "SHARE_POINTS", Points: 0.01 },
])("rejects malformed redemption %j without mutation", async (params) => {
  const id = await hold();
  const before = await order(id);
  const beforeAccount = await account();
  expect((await redeem(id, params)).json.ExtendedResultCode).toBe(RC.INVALID_STATE);
  expect(await order(id)).toEqual(before);
  expect(await account()).toEqual(beforeAccount);
  expect(await ledger()).toEqual([]);
});

it("retains valid fractional SHARE points corresponding to whole fils", async () => {
  const id = await hold();
  expect((await redeem(id, { BalanceType: "SHARE_POINTS", Points: 105.8 })).json.Redeemed.Amount).toBe(1058);
  expect((await order(id)).totalValueCents).toBe(gross - 1058);
});

it.each(["paid", "cancelled", "expired"] as const)("cannot clear a %s order", async (state) => {
  const id = await hold();
  await app.db.update(S.orders).set({ state }).where(eq(S.orders.userSessionId, id));
  const before = await order(id);
  expect((await redeem(id, { BalanceType: "VOX_REWARDS", Points: 0 })).json.Result).not.toBe(0);
  expect(await order(id)).toEqual(before);
});

it("requires an existing member and rejects a mismatching bound customer before clearing", async () => {
  const id = await hold();
  await redeem(id, { BalanceType: "SHARE_POINTS", Points: 500 });
  const before = await order(id);
  expect((await redeem(id, { MemberId: "missing-regression-member", Points: 0 })).json.Result).not.toBe(0);
  expect(await order(id)).toEqual(before);
  await app.db.update(S.orders).set({ customerId: "cust_james" }).where(eq(S.orders.userSessionId, id));
  const bound = await order(id);
  expect((await redeem(id, { Points: 0 })).json.ExtendedResultCode).toBe(RC.INVALID_STATE);
  expect(await order(id)).toEqual(bound);
});
