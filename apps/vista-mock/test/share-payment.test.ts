import { schema as S, nowLocalIso } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testApp } from "./helpers.js";

const app = testApp();
const memberId = `SHR_TEST_${Date.now()}`;
const initialPoints = 100000;
beforeAll(async () => {
  await app.auth();
  await app.db
    .insert(S.loyaltyAccounts)
    .values({ memberId, customerId: "cust_sara", sharePointsBalance: initialPoints });
});
afterAll(async () => {
  await app.db.delete(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, memberId));
  await app.db.delete(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId));
  await app.close();
});

it("uses10points per AED and debits/refunds once under concurrent retries", async () => {
  const shows = await app.get(
    `/OData/Sessions?$filter=CinemaId eq '0005' and Experience eq 'Standard' and Showtime gt DATETIME'${nowLocalIso()}'&$orderby=Showtime asc&$top=100`,
  );
  const show = shows.json.value.find((row: any) => row.SeatsAvailable > 10 && row.AllowTicketSales !== false);
  expect(show).toBeTruthy();
  const types = await app.get(`/Data/Cinemas/0005/sessions/${show.SessionId}/tickets`);
  const ticket = types.json.Tickets.find(
    (row: any) => /REGULAR$/.test(row.Description) && row.AreaCategoryCode === "0000000002",
  );
  const userSessionId = `share-test-${Date.now()}`;
  const added = await app.post("/Ticketing/Order/tickets", {
    UserSessionId: userSessionId,
    CinemaId: "0005",
    SessionId: show.SessionId,
    TicketTypes: [{ TicketTypeCode: ticket.TicketTypeCode, Qty: 1 }],
  });
  expect(added.json.Result).toBe(0);
  const total = added.json.Order.TotalValueCents;
  const points = Math.round(total) / 10;
  const pay = (pointsRedeemed: number) =>
    app.post("/Ticketing/order/payment", {
      UserSessionId: userSessionId,
      CustomerEmail: "points-test@example.com",
      CustomerName: "Points Test",
      CustomerPhone: "0500000000",
      MemberId: memberId,
      PaymentInfoCollection: [
        {
          PaymentTenderCategory: "LOYALTY",
          PaymentValueCents: total,
          PointsRedeemed: pointsRedeemed,
          MemberId: memberId,
        },
      ],
    });
  const invalid = await pay(total);
  expect(invalid.json.Result).toBe(1);
  const [before] = await app.db
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  expect(before?.sharePointsBalance).toBe(initialPoints);
  const [first, repeated] = await Promise.all([pay(points), pay(points)]);
  expect(first.json.Result).toBe(0);
  expect(repeated.json.Result).toBe(0);
  expect(first.json.VistaBookingId).toBe(repeated.json.VistaBookingId);
  const debits = await app.db
    .select()
    .from(S.loyaltyLedger)
    .where(and(eq(S.loyaltyLedger.memberId, memberId), eq(S.loyaltyLedger.reason, "Ticket purchase")));
  expect(debits).toHaveLength(1);
  expect(debits[0]?.delta).toBe(-points);
  const reference = `share-refund-${Date.now()}`;
  const refund = () =>
    app.post("/RESTBooking.svc/booking/refund", {
      BookingId: first.json.VistaBookingId,
      RefundTenderCategory: "LOYALTY",
      Reference: reference,
    });
  const refunds = await Promise.all([refund(), refund()]);
  expect(refunds.map((result) => result.json.Result)).toEqual([0, 0]);
  const credits = await app.db
    .select()
    .from(S.loyaltyLedger)
    .where(and(eq(S.loyaltyLedger.memberId, memberId), eq(S.loyaltyLedger.reference, reference)));
  expect(credits).toHaveLength(1);
  expect(credits[0]?.delta).toBe(points);
  const [after] = await app.db
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId));
  expect(after?.sharePointsBalance).toBe(initialPoints + Math.round(total / 100));
});
