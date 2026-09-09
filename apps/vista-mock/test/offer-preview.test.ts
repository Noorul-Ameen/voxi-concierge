import { randomUUID } from "node:crypto";
import { schema as S, nowLocalIso } from "@voxi/db";
import type { Offer } from "@voxi/domain";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { previewOffer } from "../../../packages/concierge-core/src/services/offer-preview.js";
import { testApp } from "./helpers.js";

const app = testApp();
const offerIds: string[] = [];
const orderIds: string[] = [];
beforeAll(async () => {
  await app.auth();
});
afterAll(async () => {
  for (const id of orderIds) await app.post("/Ticketing/order/cancel", { UserSessionId: id });
  if (offerIds.length) {
    await app.db.delete(S.offerRedemptions).where(inArray(S.offerRedemptions.offerId, offerIds));
    await app.db.delete(S.offers).where(inArray(S.offers.id, offerIds));
  }
  if (orderIds.length) await app.db.delete(S.orders).where(inArray(S.orders.userSessionId, orderIds));
  await app.close();
});
for (const benefit of [
  { type: "percent_off", percent: 20, appliesTo: "tickets" },
  { type: "bogo", buy: 1, get: 1 },
] as Offer["benefit"][]) {
  it(`matches real mock application for ${benefit.type} including food and fees`, async () => {
    const id = `preview_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    offerIds.push(id);
    const offer: Offer = {
      id,
      title: "Preview verification",
      type: "promo",
      rules: {},
      benefit,
      active: true,
    };
    await app.db.insert(S.offers).values({ ...offer, shortDescription: "Local test" });
    const shows = await app.get(
      `/OData/Sessions?$filter=CinemaId eq '0005' and Experience eq 'Standard' and Showtime gt DATETIME'${nowLocalIso()}'&$orderby=Showtime asc&$top=100`,
    );
    const show = shows.json.value.find(
      (row: { SeatsAvailable: number; AllowTicketSales?: boolean }) =>
        row.SeatsAvailable > 10 && row.AllowTicketSales !== false,
    );
    expect(show).toBeTruthy();
    const types = await app.get(`/Data/Cinemas/0005/sessions/${show.SessionId}/tickets`);
    const ticket = types.json.Tickets.find(
      (row: { Description: string; AreaCategoryCode: string }) =>
        /REGULAR$/.test(row.Description) && row.AreaCategoryCode === "0000000002",
    );
    const userSessionId = `preview-order-${randomUUID()}`;
    orderIds.push(userSessionId);
    const added = await app.post("/Ticketing/Order/tickets", {
      UserSessionId: userSessionId,
      CinemaId: "0005",
      SessionId: show.SessionId,
      TicketTypes: [{ TicketTypeCode: ticket.TicketTypeCode, Qty: 2 }],
    });
    expect(added.json.Result).toBe(0);
    const food = await app.post("/Ticketing/Order/concessions", {
      UserSessionId: userSessionId,
      CinemaId: "0005",
      Concessions: [{ ItemId: "7747", Quantity: 1, Modifiers: ["DIET"] }],
    });
    expect(food.json.Result).toBe(0);
    const [before] = await app.db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId));
    const preview = previewOffer(offer, food.json.Order, { eligible: true, reasons: [], requires: [] });
    expect(preview.discountCents).toBeGreaterThan(0);
    expect(
      (await app.db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId)))[0],
    ).toEqual(before);
    const applied = await app.post("/Ticketing/Order/offers", { UserSessionId: userSessionId, OfferId: id });
    expect(applied.json.Result).toBe(0);
    expect(applied.json.Order.TotalValueCents).toBe(preview.totalAfterOfferCents);
    expect(food.json.Order.TotalValueCents - applied.json.Order.TotalValueCents).toBe(preview.discountCents);
    expect(applied.json.Order.BookingFeeValueCents).toBe(food.json.Order.BookingFeeValueCents);
    expect(applied.json.Order.Concessions).toEqual(food.json.Order.Concessions);
  });
}
