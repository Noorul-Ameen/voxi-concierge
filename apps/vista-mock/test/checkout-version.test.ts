import { schema as S, nowLocalIso } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testApp } from "./helpers.js";

const app = testApp();
beforeAll(async () => {
  await app.auth();
});
afterAll(async () => {
  await app.close();
});

it("refuses a same-total order revision at payment and preserves already-paid retry idempotency", async () => {
  const shows = await app.get(
    `/OData/Sessions?$filter=Showtime gt DATETIME'${nowLocalIso()}'&$orderby=Showtime asc&$top=100`,
  );
  const show = shows.json.value.find((row: any) => row.SeatsAvailable > 10 && row.AllowTicketSales !== false);
  expect(show).toBeTruthy();
  const types = await app.get(`/Data/Cinemas/${show.CinemaId}/sessions/${show.SessionId}/tickets`);
  const ticket = types.json.Tickets.find(
    (row: any) => !row.IsChildOnlyTicket && !row.IsAvailableForLoyaltyMembersOnly,
  );
  const userSessionId = `checkout-version-${Date.now()}`;
  const added = await app.post("/Ticketing/Order/tickets", {
    UserSessionId: userSessionId,
    CinemaId: show.CinemaId,
    SessionId: show.SessionId,
    TicketTypes: [{ TicketTypeCode: ticket.TicketTypeCode, Qty: 1 }],
  });
  expect(added.json.Result).toBe(0);
  const version = added.json.Order.Version;
  const total = added.json.Order.TotalValueCents;
  // An independent edit arrives after the middleware's review/read, without a price change.
  await app.db
    .update(S.orders)
    .set({ version: version + 1 })
    .where(eq(S.orders.userSessionId, userSessionId));
  const pay = (expectedVersion: number) =>
    app.post("/Ticketing/order/payment", {
      UserSessionId: userSessionId,
      ExpectedVersion: expectedVersion,
      CustomerEmail: "checkout-test@example.com",
      CustomerName: "Checkout Test",
      CustomerPhone: "0500000000",
      PaymentInfoCollection: [
        {
          PaymentTenderCategory: "CREDIT",
          PaymentValueCents: total,
          PaymentToken: "tok_visa_424242_4242_test",
        },
      ],
    });
  const stale = await pay(version);
  expect(stale.json.Result).not.toBe(0);
  expect(stale.json.ErrorDescription).toMatch(/order changed/i);
  const [unpaid] = await app.db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId));
  expect(unpaid?.state).not.toBe("paid");
  expect(unpaid?.completedBookingId).toBeNull();
  const fresh = await pay(version + 1);
  expect(fresh.json.Result).toBe(0);
  const retry = await pay(version);
  expect(retry.json.Result).toBe(0);
  expect(retry.json.VistaBookingId).toBe(fresh.json.VistaBookingId);
});
