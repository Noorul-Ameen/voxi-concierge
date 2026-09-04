import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "./helpers.js";

const t = testApp();
beforeAll(async () => {
  await t.auth();
});
afterAll(async () => {
  await t.close();
});

describe("auth (Apigee)", () => {
  it("rejects missing api key with fault envelope", async () => {
    const res = await t.app.request("/vistatickets/vista/v2/OData/Cinemas");
    expect(res.status).toBe(401);
    expect((await res.json()).fault.detail.errorcode).toBe("steps.oauth.v2.FailedToResolveAPIKey");
  });
  it("rejects expired token with the documented fault", async () => {
    const cfg = { ...t.cfg.auth, tokenTtlSeconds: -10 };
    const { issueToken } = await import("../src/auth.js");
    const tok = issueToken(cfg).access_token;
    const res = await t.app.request("/vistatickets/vista/v2/OData/Cinemas", {
      headers: { "x-api-key": t.cfg.auth.apiKey, authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).fault.detail.errorcode).toBe("keymanagement.service.access_token_expired");
  });
});

describe("OData reference data", () => {
  it("lists cinemas filtered by currency", async () => {
    const r = await t.get("/OData/Cinemas?$format=json&$filter=CurrencyCode eq 'AED'");
    expect(r.status).toBe(200);
    expect(r.json.value.length).toBeGreaterThan(20);
    expect(r.json.value[0]).toHaveProperty("ID");
    expect(r.json.value.find((c: any) => c.ID === "0002").Name).toMatch(/Mall of the Emirates/);
  });
  it("supports $select and $top", async () => {
    const r = await t.get("/OData/CinemaOperators?$format=json&$select=ID,Code,Name,ShortName&$top=3");
    expect(r.json.value).toHaveLength(3);
    expect(Object.keys(r.json.value[0])).toEqual(["ID", "Code", "Name", "ShortName"]);
  });
  it("filters films with the documented now-showing/coming-soon expression", async () => {
    const r = await t.get(
      "/OData/Films?$format=json&$filter=IsScheduledAtCinema eq true or OpeningDate gt DATETIME '2026-09-01T00:00:00'",
    );
    expect(r.json.value.length).toBeGreaterThan(40);
    expect(r.json.value[0].Cast).toBeUndefined(); // not expanded
  });
  it("returns sessions for a cinema with $expand=Attributes", async () => {
    const r = await t.get(
      "/OData/Sessions?$format=json&$filter=CinemaId eq '0002'&$expand=Attributes&$top=5",
    );
    expect(r.json.value).toHaveLength(5);
    expect(r.json.value[0].Attributes[0].ShortName).toBeDefined();
    expect(r.json.value[0].Showtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
  it("rejects a malformed filter with an OData error", async () => {
    const r = await t.get("/OData/Sessions?$filter=CinemaId eq");
    expect(r.status).toBe(400);
  });
});

describe("order lifecycle with seat holds", () => {
  const cinemaId = "0005";
  let sessionId = "";
  let ticketCode = "";
  it("finds an upcoming session and ticket types", async () => {
    const { nowLocalIso } = await import("@voxi/db");
    const from = new Date(new Date(`${nowLocalIso()}Z`).getTime() + 2 * 3600000).toISOString().slice(0, 19);
    const r = await t.get(
      `/OData/Sessions?$format=json&$filter=CinemaId eq '${cinemaId}' and Experience eq 'Standard' and SoldoutStatus eq 0 and Showtime gt DATETIME'${from}'&$orderby=Showtime asc&$top=50`,
    );
    const s = r.json.value.find((x: any) => x.SeatsAvailable > 20);
    sessionId = s.SessionId;
    const tt = await t.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/tickets?salesChannel=WWW`);
    expect(tt.json.ResponseCode).toBe(0);
    ticketCode = tt.json.Tickets.find(
      (x: any) => /REGULAR$/.test(x.Description) && x.AreaCategoryCode === "0000000002",
    ).TicketTypeCode;
  });
  it("adds tickets with auto-allocation, then re-selects seats, adds F&B, pays and returns a booking", async () => {
    const usid = `test-${Date.now()}`;
    const add = await t.post("/Ticketing/Order/tickets", {
      UserSessionId: usid,
      CinemaId: cinemaId,
      SessionId: sessionId,
      TicketTypes: [{ TicketTypeCode: ticketCode, Qty: 2 }],
      ReturnOrder: true,
    });
    expect(add.json.Result).toBe(0);
    const tickets = add.json.Order.Sessions[0].Tickets;
    expect(tickets).toHaveLength(2);
    expect(tickets[0].SeatRowId).toBeTruthy();
    // seat plan shows held seats as status 2 for this session
    const plan = await t.get(
      `/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan?userSessionId=${usid}`,
    );
    const all = plan.json.SeatLayoutData.Areas.flatMap((a: any) =>
      a.Rows.flatMap((r: any) => r.Seats.map((s: any) => ({ ...s, row: r.PhysicalName }))),
    );
    expect(all.filter((s: any) => s.Status === 2)).toHaveLength(2);
    // pick two other free seats explicitly
    const free = all.filter((s: any) => s.Status === 0 && s.SeatStyle === 0).slice(10, 12);
    const seats = await t.post("/Ticketing/Order/seats", {
      UserSessionId: usid,
      CinemaId: cinemaId,
      SessionId: sessionId,
      SelectedSeats: free.map((s: any) => ({ Row: s.row, Number: s.Id })),
    });
    expect(seats.json.Result).toBe(0);
    expect(seats.json.Order.Sessions[0].Tickets.map((x: any) => x.SeatData).sort()).toEqual(
      free.map((s: any) => `${s.row}${s.Id}`).sort(),
    );
    const fnb = await t.post("/Ticketing/Order/concessions", {
      UserSessionId: usid,
      CinemaId: cinemaId,
      Concessions: [{ ItemId: "7747", Quantity: 1, Modifiers: ["DIET"] }],
    });
    expect(fnb.json.Order.Concessions).toHaveLength(1);
    const order = await t.post("/Ticketing/order", { UserSessionId: usid });
    const total = order.json.Order.TotalValueCents;
    expect(total).toBeGreaterThan(0);
    const declined = await t.post("/Ticketing/order/payment", {
      UserSessionId: usid,
      CustomerEmail: "qa@example.com",
      CustomerName: "QA Tester",
      CustomerPhone: "0500000000",
      PaymentInfoCollection: [
        {
          PaymentValueCents: total,
          PaymentTenderCategory: "CREDIT",
          CardNumber: "4000000000000002",
          CardExpiryMonth: "12",
          CardExpiryYear: "30",
        },
      ],
    });
    expect(declined.status).toBe(200);
    expect(declined.json.Result).toBe(1);
    expect(declined.json.ErrorDescription).toMatch(/declined/);
    const pay = await t.post("/Ticketing/order/payment", {
      UserSessionId: usid,
      CustomerEmail: "qa@example.com",
      CustomerName: "QA Tester",
      CustomerPhone: "0500000000",
      PaymentInfoCollection: [
        {
          PaymentValueCents: total,
          PaymentTenderCategory: "CREDIT",
          CardNumber: "4111111111111111",
          CardExpiryMonth: "12",
          CardExpiryYear: "30",
        },
      ],
    });
    expect(pay.json.Result).toBe(0);
    expect(pay.json.VistaBookingId).toHaveLength(7);
    // idempotent re-pay returns the same booking
    const again = await t.post("/Ticketing/order/payment", {
      UserSessionId: usid,
      CustomerEmail: "qa@example.com",
      CustomerName: "QA Tester",
      CustomerPhone: "0500000000",
      PaymentInfoCollection: [
        { PaymentValueCents: total, PaymentTenderCategory: "CREDIT", CardNumber: "4111111111111111" },
      ],
    });
    expect(again.json.VistaBookingId).toBe(pay.json.VistaBookingId);
    expect(again.json.AlreadyCompleted).toBe(true);
    // booking searchable
    const found = await t.post("/RESTBooking.svc/booking/search", { Email: "qa@example.com" });
    expect(found.json.Bookings.some((b: any) => b.VistaBookingId === pay.json.VistaBookingId)).toBe(true);
    // seats now sold
    const plan2 = await t.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan`);
    const sold = plan2.json.SeatLayoutData.Areas.flatMap((a: any) =>
      a.Rows.flatMap((r: any) =>
        r.Seats.filter((s: any) => free.some((f: any) => f.row === r.PhysicalName && f.Id === s.Id)),
      ),
    );
    expect(sold.every((s: any) => s.Status === 1)).toBe(true);
  });
  it("prevents two orders from holding the same seat concurrently", async () => {
    const plan = await t.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan`);
    const all = plan.json.SeatLayoutData.Areas.flatMap((a: any) =>
      a.Rows.flatMap((r: any) => r.Seats.map((s: any) => ({ ...s, row: r.PhysicalName }))),
    );
    const free = all.filter((s: any) => s.Status === 0 && s.SeatStyle === 0)[20];
    const mk = async (usid: string) => {
      await t.post("/Ticketing/Order/tickets", {
        UserSessionId: usid,
        CinemaId: cinemaId,
        SessionId: sessionId,
        TicketTypes: [{ TicketTypeCode: ticketCode, Qty: 1 }],
        UserSelectedSeatingSupported: true,
      });
      return t.post("/Ticketing/Order/seats", {
        UserSessionId: usid,
        CinemaId: cinemaId,
        SessionId: sessionId,
        SelectedSeats: [{ Row: free.row, Number: free.Id }],
      });
    };
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => mk(`race-${Date.now()}-${i}`)));
    const ok = results.filter((r) => r.json.Result === 0);
    expect(ok).toHaveLength(1);
    expect(
      results
        .filter((r) => r.json.Result !== 0)
        .every((r) => /no longer available|concurrently/.test(r.json.ErrorDescription)),
    ).toBe(true);
  });
  it("cancel order releases seats", async () => {
    const usid = `cancel-${Date.now()}`;
    const add = await t.post("/Ticketing/Order/tickets", {
      UserSessionId: usid,
      CinemaId: cinemaId,
      SessionId: sessionId,
      TicketTypes: [{ TicketTypeCode: ticketCode, Qty: 1 }],
    });
    const seat = add.json.Order.Sessions[0].Tickets[0];
    const cancel = await t.post("/Ticketing/order/cancel", { UserSessionId: usid });
    expect(cancel.json.OrderNotFound).toBe(false);
    const plan = await t.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan`);
    const s = plan.json.SeatLayoutData.Areas.flatMap((a: any) =>
      a.Rows.filter((r: any) => r.PhysicalName === seat.SeatRowId).flatMap((r: any) => r.Seats),
    ).find((x: any) => x.Id === seat.SeatNumber);
    expect(s.Status).toBe(0);
  });
});

describe("offers engine", () => {
  it("applies a promo code and rejects combining with a bank offer", async () => {
    const r = await t.get(
      "/OData/Sessions?$format=json&$filter=CinemaId eq '0005' and Experience eq 'Standard'&$orderby=Showtime asc&$top=2000",
    );
    const { nowLocalIso } = await import("@voxi/db");
    const monday = r.json.value.find(
      (x: any) =>
        new Date(`${x.Showtime}Z`).getUTCDay() === 1 && x.SeatsAvailable > 10 && x.Showtime > nowLocalIso(),
    );
    expect(monday).toBeTruthy();
    const usid = `offer-${Date.now()}`;
    const tt = await t.get(`/Data/Cinemas/0005/sessions/${monday.SessionId}/tickets`);
    const code = tt.json.Tickets.find(
      (x: any) => /REGULAR$/.test(x.Description) && x.AreaCategoryCode === "0000000002",
    ).TicketTypeCode;
    const add = await t.post("/Ticketing/Order/tickets", {
      UserSessionId: usid,
      CinemaId: "0005",
      SessionId: monday.SessionId,
      TicketTypes: [{ TicketTypeCode: code, Qty: 2 }],
    });
    const before = add.json.Order.TotalValueCents;
    const applied = await t.post("/Ticketing/Order/offers", { UserSessionId: usid, PromoCode: "MONDAY30" });
    expect(applied.json.Result).toBe(0);
    expect(applied.json.Order.TotalValueCents).toBeLessThan(before);
    expect(applied.json.AppliedOffer.Id).toBe("PROMO-MOVIEMONDAY");
    const bank = await t.post("/Ticketing/Order/offers", { UserSessionId: usid, CardBin: "455533" });
    expect(bank.json.Result).toBe(1);
    expect(bank.json.ErrorDescription).toMatch(/cannot be combined/);
  });
  it("lists offers with eligibility and requirements", async () => {
    const r = await t.get("/offers/v1/offers?cinemaId=0002&experience=GOLD");
    const share = r.json.offers.find((o: any) => o.id === "SHARE-MEMBER-10");
    expect(share.eligibility.requires).toContain("member");
    const gold = r.json.offers.find((o: any) => o.id === "BANK-CBD-50");
    expect(gold.eligibility.eligible).toBe(false);
  });
});

describe("bookings & refunds", () => {
  it("searches by booking id, phone and email", async () => {
    const byId = await t.post("/RESTBooking.svc/booking/search", { BookingId: "vxa7k2m" });
    expect(byId.json.Bookings[0].VistaBookingId).toBe("VXA7K2M");
    const byPhone = await t.post("/RESTBooking.svc/booking/search", { Phone: "050 123 4567" });
    expect(byPhone.json.Bookings.length).toBeGreaterThan(0);
    const byEmail = await t.post("/RESTBooking.svc/booking/search", {
      Email: "James.Whitfield@example.com",
      UpcomingOnly: true,
    });
    expect(byEmail.json.Bookings.every((b: any) => b.Customer.Email === "james.whitfield@example.com")).toBe(
      true,
    );
  });
  it("refunds to VOX credit idempotently and rejects a second refund", async () => {
    const b = (await t.get("/RESTBooking.svc/booking/OKGRP33")).json.Booking;
    expect(b.Status).toBe("confirmed");
    const bal0 = (await t.get("/RESTLoyalty.svc/member/SHR400551/balances")).json.Balances.find(
      (x: any) => x.BalanceTypeId === "VOX_REWARDS",
    ).ValueCents;
    const ref = `TEST-${Date.now()}`;
    const r1 = await t.post("/RESTBooking.svc/booking/refund", {
      BookingId: "OKGRP33",
      RefundTenderCategory: "EWALLET",
      Reference: ref,
      TicketIds: ["1"],
    });
    expect(r1.json.Result).toBe(0);
    expect(r1.json.Booking.Status).toBe("partially_refunded");
    const r2 = await t.post("/RESTBooking.svc/booking/refund", {
      BookingId: "OKGRP33",
      RefundTenderCategory: "EWALLET",
      Reference: ref,
      TicketIds: ["1"],
    });
    expect(r2.json.Idempotent).toBe(true);
    expect(r2.json.Refund.Reference).toBe(ref);
    const bal1 = (await t.get("/RESTLoyalty.svc/member/SHR400551/balances")).json.Balances.find(
      (x: any) => x.BalanceTypeId === "VOX_REWARDS",
    ).ValueCents;
    expect(bal1 - bal0).toBe(r1.json.Refund.AmountCents);
    const full = await t.post("/RESTBooking.svc/booking/cancel", {
      BookingId: "OKGRP33",
      RefundTenderCategory: "EWALLET",
    });
    expect(full.json.Booking.Status).toBe("refunded");
    const again = await t.post("/RESTBooking.svc/booking/cancel", {
      BookingId: "OKGRP33",
      RefundTenderCategory: "EWALLET",
    });
    expect(again.json.Result).toBe(1);
    expect(again.json.ExtendedResultCode).toBe(101);
  });
});
