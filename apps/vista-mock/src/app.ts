/**
 * Vista-shaped mock API (VOX Apigee partner API + Vista RESTBooking/RESTLoyalty + Offers Engine + Customer).
 * All routes live under BASE = /vistatickets/vista/v2 (as production) plus /v1/oauth/generate at the root.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Db } from "@voxi/db";
import { schema as S, shortId } from "@voxi/db";
import { applyBenefit, evaluateOffer, type Offer } from "@voxi/domain";
import { type AuthConfig, oauthHandler, requireAuth } from "./auth.js";
import { applyQuery, readQuery } from "./odata.js";
import { bookingJson, orderJson, seatPlanJson } from "./serialize-order.js";
import { cinemaJson, concessionJson, filmJson, sessionJson, ticketTypeJson } from "./serialize.js";
import { getBooking, markCollected, refundBooking, searchBookings } from "./services/bookings.js";
import { RC, VistaError, addConcessions, addTickets, cancelOrder, completeOrder, expireAbandonedOrders, getOrder, loadSeatState, recalc, removeConcession, setSeats, type OrderCfg } from "./services/orders.js";

export type MockConfig = { auth: AuthConfig; order: OrderCfg; basePath?: string; logging?: boolean };

/** V1 envelope: HTTP 200 even on failure; Result 0 = OK. */
const v1ok = (body: Record<string, unknown>) => ({ ExtendedResultCode: 0, ...body, Result: 0, ErrorDescription: null });
const v1err = (e: VistaError) => ({ ExtendedResultCode: e.extended, Result: e.result, ErrorDescription: e.message });

export function createApp(db: Db, cfg: MockConfig) {
  const app = new Hono();
  const BASE = cfg.basePath ?? "/vistatickets/vista/v2";
  if (cfg.logging) app.use("*", logger());
  app.use("*", cors());
  app.get("/healthz", (c) => c.json({ ok: true, service: "vista-mock" }));
  app.get("/readyz", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  });
  app.get("/v1/oauth/generate", oauthHandler(cfg.auth));
  app.post("/v1/oauth/generate", oauthHandler(cfg.auth));

  const api = new Hono();
  api.use("*", requireAuth(cfg.auth));

  // V1 error → HTTP 200 + Result body (the documented Vista quirk). Non-Vista errors → 500.
  api.onError((err, c) => {
    if (err instanceof VistaError) return c.json(v1err(err), 200);
    console.error(err);
    return c.json({ Result: 1, ExtendedResultCode: 999, ErrorDescription: "Internal error" }, 500);
  });

  // ---------------- OData (reference data) ----------------
  const odata = (rows: Record<string, unknown>[], c: Context, expandable?: string[]) => {
    const q = readQuery(c.req.query());
    try {
      return c.json({ value: applyQuery(rows, q, { expandable }) });
    } catch (e) {
      return c.json({ error: { code: "BadRequest", message: { lang: "en-US", value: (e as Error).message } } }, 400);
    }
  };

  api.get("/OData/Cinemas", async (c) => {
    const rows = await db.select().from(S.cinemas).where(eq(S.cinemas.active, true));
    return odata(rows.map(cinemaJson), c);
  });
  api.get("/OData/CinemaOperators", async (c) => {
    const rows = await db.select().from(S.cinemaOperators);
    return odata(
      rows.map((r) => ({ ID: `${r.cinemaId}-${r.code}`, CinemaId: r.cinemaId, Code: r.code, Name: r.name, ShortName: r.shortName, Experience: r.experience })),
      c,
    );
  });
  api.get("/OData/FilmGenres", async (c) => {
    const rows = await db.select().from(S.filmGenres);
    return odata(rows.map((r) => ({ ID: r.id, Name: r.name, NameTranslations: r.nameTranslations ?? [], Description: r.description ?? "", DescriptionTranslations: [] })), c);
  });
  api.get("/OData/SessionAttributes", async (c) => {
    const rows = await db.select().from(S.sessionAttributes);
    return odata(rows.map((r) => ({ ID: r.id, Description: r.description, ShortName: r.shortName, AltDescription: r.altDescription })), c);
  });
  api.get("/OData/Films", async (c) => {
    const rows = await db.select().from(S.films);
    return odata(rows.map((f) => filmJson(f)), c, ["Cast"]);
  });
  api.get("/OData/ScheduledFilms", async (c) => {
    const rows = await db
      .select({ f: S.films, sf: S.scheduledFilms })
      .from(S.scheduledFilms)
      .innerJoin(S.films, eq(S.films.hoCode, S.scheduledFilms.hoCode));
    return odata(
      rows.map(({ f, sf }) => ({ ...filmJson(f, sf.cinemaId), FirstShowtime: sf.firstShowtime?.toISOString().slice(0, 19), LastShowtime: sf.lastShowtime?.toISOString().slice(0, 19) })),
      c,
      ["Cast"],
    );
  });
  api.get("/OData/Sessions", async (c) => {
    // The real API returns everything for a cinema; we pre-filter on CinemaId/ScheduledFilmId/business date when present for speed.
    const q = readQuery(c.req.query());
    const conds = [];
    const cin = q.filter?.match(/CinemaId\s+eq\s+'([^']+)'/i)?.[1];
    const film = q.filter?.match(/ScheduledFilmId\s+eq\s+'([^']+)'/i)?.[1];
    if (cin) conds.push(eq(S.sessions.cinemaId, cin));
    if (film) conds.push(eq(S.sessions.hoCode, film));
    const rows = await db.select().from(S.sessions).where(conds.length ? and(...conds) : undefined);
    const attrs = await db.select().from(S.sessionAttributes);
    const films = await db.select().from(S.films).where(rows.length ? inArray(S.films.hoCode, [...new Set(rows.map((r) => r.hoCode))]) : sql`false`);
    return odata(
      rows.map((r) => sessionJson(r, attrs, films.find((f) => f.hoCode === r.hoCode))),
      c,
      ["Attributes"],
    );
  });

  // ---------------- Data (tickets, seat plan, concessions) ----------------
  api.get("/Data/Cinemas/:cinemaId/sessions/:sessionId/tickets", async (c) => {
    const { cinemaId, sessionId } = c.req.param();
    const sess = (await db.select().from(S.sessions).where(and(eq(S.sessions.cinemaId, cinemaId), eq(S.sessions.sessionId, sessionId))))[0];
    if (!sess) return c.json({ ResponseCode: 1, ErrorDescription: `Session ${sessionId} not found for Cinema ${cinemaId}`, Tickets: [] });
    const rows = await db.select().from(S.ticketTypes).where(and(eq(S.ticketTypes.cinemaId, cinemaId), eq(S.ticketTypes.experience, sess.experience)));
    const channel = c.req.query("salesChannel") ?? "WWW";
    return c.json({ ResponseCode: 0, Tickets: rows.filter((t) => (t.salesChannels ?? []).includes(channel)).map(ticketTypeJson) });
  });

  api.get("/Data/Cinemas/:cinemaId/sessions/:sessionId/seat-plan", async (c) => {
    const { cinemaId, sessionId } = c.req.param();
    const usid = c.req.query("userSessionId");
    try {
      const { tpl, state } = await db.transaction((tx) => loadSeatState(tx, cinemaId, sessionId));
      return c.json(seatPlanJson(tpl.layout, state.seats, usid));
    } catch (e) {
      if (e instanceof VistaError) return c.json({ SeatLayoutData: null, ResponseCode: e.extended, ErrorDescription: e.message });
      throw e;
    }
  });

  api.get("/Data/concession-items-grouped-by-tabs", async (c) => {
    const cinemaId = c.req.query("cinemaId");
    const rows = await db.select().from(S.concessionItems).where(eq(S.concessionItems.active, true));
    const items = rows.filter((r) => !r.cinemaId || r.cinemaId === cinemaId).sort((a, b) => (a.displaySequence ?? 0) - (b.displaySequence ?? 0));
    const tabs = [...new Set(items.map((i) => i.tab))].map((tab) => ({ Name: tab, NameAlt: tab, Items: items.filter((i) => i.tab === tab).map(concessionJson) }));
    return c.json({ ResponseCode: 0, ErrorDescription: null, ConcessionTabs: tabs });
  });

  // ---------------- Ticketing (order lifecycle) ----------------
  const orderResponse = async (userSessionId: string) => {
    const order = await getOrder(db, userSessionId, cfg.order);
    if (!order) return v1ok({ Order: null, OrderNotFound: true });
    const session = order.sessionId ? (await db.select().from(S.sessions).where(and(eq(S.sessions.cinemaId, order.cinemaId), eq(S.sessions.sessionId, order.sessionId))))[0] ?? null : null;
    const film = session ? (await db.select().from(S.films).where(eq(S.films.hoCode, session.hoCode)))[0] ?? null : null;
    return v1ok({ Order: orderJson(order, session, film), SessionStatuses: session ? [{ SessionId: session.sessionId, NumberOfSeatsAvailable: session.seatsAvailable, MaximumNumberOfSeatsPerRow: 0 }] : [] });
  };

  api.post("/Ticketing/Order/tickets", async (c) => {
    const body = await c.req.json();
    const r = await addTickets(db, { ...body, UserSessionId: String(body.UserSessionId), SessionId: String(body.SessionId) }, cfg.order);
    const film = (await db.select().from(S.films).where(eq(S.films.hoCode, r.session.hoCode)))[0] ?? null;
    return c.json(v1ok({ Order: body.ReturnOrder === false ? undefined : orderJson(r.order, r.session, film), SeatData: "", AreaSummaryData: "", SeatDataLength: 0, SeatsNotAllocated: !r.order.seatsAllocated, AvailableSeats: r.availableSeats, MaxSeatsPerRow: 0, SeatLayoutData: null, SessionStatuses: [{ SessionId: r.session.sessionId, NumberOfSeatsAvailable: r.availableSeats, MaximumNumberOfSeatsPerRow: 0 }], RedemptionsRemainingForVouchers: [] }));
  });

  api.post("/Ticketing/Order/seats", async (c) => {
    const body = await c.req.json();
    const selected = Array.isArray(body.SelectedSeats) ? body.SelectedSeats : body.SelectedSeats ? [body.SelectedSeats] : [];
    const r = await setSeats(db, { UserSessionId: String(body.UserSessionId), CinemaId: body.CinemaId, SessionId: String(body.SessionId), SelectedSeats: selected }, cfg.order);
    const film = (await db.select().from(S.films).where(eq(S.films.hoCode, r.session.hoCode)))[0] ?? null;
    return c.json(v1ok({ Order: orderJson(r.order, r.session, film) }));
  });

  api.post("/Ticketing/Order/concessions", async (c) => {
    const body = await c.req.json();
    const r = await addConcessions(db, { UserSessionId: String(body.UserSessionId), CinemaId: body.CinemaId, Concessions: body.Concessions ?? [], Replace: body.Replace }, cfg.order);
    return c.json({ ...(await orderResponse(r.order.userSessionId)), FailedConcessions: r.failed.length ? r.failed : null });
  });
  api.delete("/Ticketing/Order/concessions/:lineId", async (c) => {
    const usid = c.req.query("userSessionId") ?? "";
    await removeConcession(db, { UserSessionId: usid, LineId: c.req.param("lineId") }, cfg.order);
    return c.json(await orderResponse(usid));
  });

  api.post("/Ticketing/order", async (c) => {
    const body = await c.req.json();
    return c.json(await orderResponse(String(body.UserSessionId)));
  });
  api.get("/Ticketing/order/:userSessionId", async (c) => c.json(await orderResponse(c.req.param("userSessionId"))));

  api.post("/Ticketing/order/cancel", async (c) => {
    const body = await c.req.json();
    const r = await cancelOrder(db, String(body.UserSessionId));
    return c.json(v1ok({ OrderNotFound: r.OrderNotFound }));
  });

  /** Offers Engine → order application (not in Vista; modelled as a Ticketing extension). */
  api.post("/Ticketing/Order/offers", async (c) => {
    const body = (await c.req.json()) as { UserSessionId: string; OfferId?: string; PromoCode?: string; CardBin?: string; MemberId?: string; Remove?: boolean };
    const order = await getOrder(db, String(body.UserSessionId), cfg.order);
    if (!order) throw new VistaError(RC.GENERAL, RC.ORDER_NOT_FOUND, "Order not found");
    if (order.state === "expired") throw new VistaError(RC.GENERAL, RC.ORDER_EXPIRED, "Order has expired");
    if (body.Remove) {
      const reset = { tickets: order.tickets.map((t) => ({ ...t, DiscountPriceCents: 0, FinalPriceCents: t.PriceCents, DealDefinitionId: null, DealDescription: null })), concessions: order.concessions.map((x) => ({ ...x, FinalPriceCents: x.PriceCents * x.Quantity, DealDefinitionId: null, DealDescription: null })), appliedOffers: [] };
      const totals = recalc({ ...order, ...reset }, cfg.order);
      await db.update(S.orders).set({ ...reset, ...totals, version: order.version + 1, lastUpdatedAt: new Date() }).where(eq(S.orders.userSessionId, order.userSessionId));
      await db.update(S.offerRedemptions).set({ status: "released" }).where(eq(S.offerRedemptions.orderUserSessionId, order.userSessionId));
      return c.json(await orderResponse(order.userSessionId));
    }
    const offers = await db.select().from(S.offers).where(eq(S.offers.active, true));
    let offer = body.OfferId ? offers.find((o) => o.id === body.OfferId) : undefined;
    if (!offer && body.PromoCode) offer = offers.find((o) => o.rules.promoCode?.toUpperCase() === body.PromoCode!.toUpperCase());
    if (!offer && body.CardBin) offer = offers.filter((o) => o.rules.bankBins?.some((b) => body.CardBin!.startsWith(b))).sort((a, b) => a.priority - b.priority)[0];
    if (!offer) throw new VistaError(RC.GENERAL, RC.OFFER_NOT_ELIGIBLE, "Offer not found or no offer matches");
    const session = order.sessionId ? (await db.select().from(S.sessions).where(and(eq(S.sessions.cinemaId, order.cinemaId), eq(S.sessions.sessionId, order.sessionId))))[0] : undefined;
    const acct = body.MemberId ? (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, body.MemberId)))[0] : undefined;
    const redemptions = body.MemberId ? (await db.select({ n: sql<number>`count(*)` }).from(S.offerRedemptions).where(and(eq(S.offerRedemptions.offerId, offer.id), eq(S.offerRedemptions.memberId, body.MemberId), eq(S.offerRedemptions.status, "committed"))))[0]?.n : 0;
    const elig = evaluateOffer(offer as unknown as Offer, { cinemaId: order.cinemaId, experience: session?.experience, hoCode: session?.hoCode, showtime: session ? session.showtime.toISOString().slice(0, 19) : undefined, ticketCount: order.tickets.length, ticketTypeCodes: order.tickets.map((t) => t.TicketTypeCode), memberId: body.MemberId, tier: acct?.tier, cardBin: body.CardBin, promoCode: body.PromoCode, channel: "WWW", memberRedemptions: Number(redemptions ?? 0) });
    if (!elig.eligible) throw new VistaError(RC.GENERAL, RC.OFFER_NOT_ELIGIBLE, [...elig.reasons, ...elig.requires.map((r) => `requires ${r}`)].join("; "));
    if (order.appliedOffers.some((a) => a.type === "bank" || a.type === "promo") && (offer.type === "bank" || offer.type === "promo")) throw new VistaError(RC.GENERAL, RC.OFFER_NOT_ELIGIBLE, "Bank and promo offers cannot be combined");
    const applied = applyBenefit(offer.benefit, order.tickets, order.concessions, offer.rules.maxTicketsPerRedemption);
    const tickets = order.tickets.map((t, i) => ({ ...t, DiscountPriceCents: applied.tickets[i]!.DiscountPriceCents, FinalPriceCents: applied.tickets[i]!.FinalPriceCents, DealDefinitionId: applied.tickets[i]!.DiscountPriceCents ? offer.id : t.DealDefinitionId, DealDescription: applied.tickets[i]!.DiscountPriceCents ? offer.title : t.DealDescription }));
    let concessions = order.concessions.map((x, i) => ({ ...x, FinalPriceCents: applied.concessions[i]!.FinalPriceCents, DealDefinitionId: applied.concessions[i]!.FinalPriceCents !== x.PriceCents * x.Quantity ? offer.id : x.DealDefinitionId, DealDescription: applied.concessions[i]!.FinalPriceCents !== x.PriceCents * x.Quantity ? offer.title : x.DealDescription }));
    if (applied.freeItemId) {
      const item = (await db.select().from(S.concessionItems).where(eq(S.concessionItems.id, applied.freeItemId)))[0];
      if (item && !concessions.some((x) => x.ItemId === item.id && x.FinalPriceCents === 0)) concessions = [...concessions, { Id: String(concessions.length + 1), ItemId: item.id, Description: item.description, Quantity: 1, PriceCents: item.priceInCents, DealPriceCents: 0, FinalPriceCents: 0, TaxCents: 0, DeliveryOption: 2, Modifiers: [], DealDefinitionId: offer.id, DealDescription: offer.title }];
    }
    const appliedOffers = [...order.appliedOffers.filter((a) => a.offerId !== offer.id), { offerId: offer.id, title: offer.title, type: offer.type, discountCents: applied.discountCents + (applied.freeItemId ? (concessions.find((x) => x.ItemId === applied.freeItemId)?.PriceCents ?? 0) : 0), reference: applied.pointsMultiplier ? "points_multiplier" : undefined }];
    const totals = recalc({ ...order, tickets, concessions, appliedOffers }, cfg.order);
    await db.update(S.orders).set({ tickets, concessions, appliedOffers, ...totals, version: order.version + 1, lastUpdatedAt: new Date() }).where(eq(S.orders.userSessionId, order.userSessionId));
    await db.insert(S.offerRedemptions).values({ id: `rd_${shortId(10)}`, offerId: offer.id, memberId: body.MemberId ?? null, orderUserSessionId: order.userSessionId, discountCents: applied.discountCents, status: "applied" });
    return c.json({ ...(await orderResponse(order.userSessionId)), AppliedOffer: { Id: offer.id, Title: offer.title, DiscountCents: applied.discountCents } });
  });

  /** Redeem Share Points / VOX credit against the order total (pre-payment). */
  api.post("/Ticketing/Order/loyalty-redeem", async (c) => {
    const body = (await c.req.json()) as { UserSessionId: string; MemberId: string; Points?: number; BalanceType?: "SHARE_POINTS" | "VOX_REWARDS" };
    const order = await getOrder(db, String(body.UserSessionId), cfg.order);
    if (!order) throw new VistaError(RC.GENERAL, RC.ORDER_NOT_FOUND, "Order not found");
    const acct = (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, body.MemberId)))[0];
    if (!acct) throw new VistaError(RC.GENERAL, RC.INSUFFICIENT_FUNDS, "Loyalty account not found");
    const gross = recalc({ ...order, loyaltyPointsPayableValueInCents: 0 }, cfg.order).totalValueCents;
    const type = body.BalanceType ?? "SHARE_POINTS";
    const available = type === "SHARE_POINTS" ? acct.sharePointsBalance : acct.voxRewardsBalanceCents;
    const want = Math.min(body.Points ?? available, available, gross);
    if (want <= 0) throw new VistaError(RC.GENERAL, RC.INSUFFICIENT_FUNDS, `No ${type === "SHARE_POINTS" ? "Share Points" : "VOX credit"} available`);
    const appliedOffers = [...order.appliedOffers.filter((a) => a.type !== "loyalty_redeem"), { offerId: type, title: type === "SHARE_POINTS" ? "Share Points redemption" : "VOX credit", type: "loyalty_redeem", discountCents: want, pointsRedeemed: want }];
    const totals = recalc({ ...order, appliedOffers, loyaltyPointsPayableValueInCents: want }, cfg.order);
    await db.update(S.orders).set({ appliedOffers, loyaltyPointsPayableValueInCents: want, ...totals, version: order.version + 1, lastUpdatedAt: new Date() }).where(eq(S.orders.userSessionId, order.userSessionId));
    return c.json({ ...(await orderResponse(order.userSessionId)), Redeemed: { Type: type, Amount: want } });
  });

  api.post("/Ticketing/order/payment", async (c) => {
    const body = await c.req.json();
    const r = await completeOrder(db, { ...body, UserSessionId: String(body.UserSessionId) }, cfg.order);
    const b = r.booking;
    return c.json(
      v1ok({
        CinemaID: b.cinemaId,
        VistaBookingNumber: String(b.vistaBookingNumber),
        VistaBookingId: b.vistaBookingId,
        VistaTransNumber: String(b.vistaTransNumber),
        HistoryID: String(b.vistaTransNumber + 7000000),
        PrintStream: "",
        PrintStreamCollection: null,
        PaymentInfoCollection: b.payments.map((p) => ({ CardNumber: p.CardNumberMasked ?? "", CardType: p.CardType ?? "", PaymentValueCents: p.PaymentValueCents, PaymentTenderCategory: p.PaymentTenderCategory, PaymentStatus: "", BillingValueCents: p.PaymentValueCents, BankReference: p.BankReference ?? null, PointsRedeemed: p.PointsRedeemed ?? null, Reference: p.Reference })),
        BalanceList: null,
        PassCollection: null,
        BackgroundJobUrl: null,
        LoyaltyPointsCost: null,
        OrderEmails: [b.customer.Email],
        ParentBookingId: null,
        JourneyReference: crypto.randomUUID(),
        QrPayload: b.qrPayload,
        AlreadyCompleted: r.alreadyCompleted,
        Booking: bookingJson(b),
      }),
    );
  });

  // ---------------- Bookings (RESTBooking.svc) ----------------
  api.post("/RESTBooking.svc/booking/search", async (c) => {
    const body = await c.req.json();
    const rows = await searchBookings(db, body);
    return c.json(v1ok({ Bookings: rows.map(bookingJson), Count: rows.length }));
  });
  api.get("/RESTBooking.svc/booking/:bookingId", async (c) => {
    const b = await getBooking(db, c.req.param("bookingId"));
    return c.json(v1ok({ Booking: bookingJson(b) }));
  });
  api.post("/RESTBooking.svc/booking/refund", async (c) => {
    const body = await c.req.json();
    const r = await refundBooking(db, body);
    return c.json(v1ok({ Refund: { Id: r.refund.id, Reference: r.refund.reference, AmountCents: r.refund.amountCents, Method: r.refund.method, TenderCategory: r.refund.tenderCategory, TicketIds: r.refund.ticketIds, Status: r.refund.status, CreatedUtc: r.refund.createdAt.toISOString() }, Booking: bookingJson(r.booking), Idempotent: r.idempotent }));
  });
  api.post("/RESTBooking.svc/booking/cancel", async (c) => {
    // Vista "cancel booking" = full refund to the given tender
    const body = await c.req.json();
    const r = await refundBooking(db, { BookingId: body.BookingId, RefundTenderCategory: body.RefundTenderCategory ?? "EWALLET", Reference: body.Reference, Reason: body.Reason ?? "Customer cancellation", InitiatedBy: body.InitiatedBy, ConversationId: body.ConversationId, ExpectedVersion: body.ExpectedVersion });
    return c.json(v1ok({ Booking: bookingJson(r.booking), Refund: { Reference: r.refund.reference, AmountCents: r.refund.amountCents, Method: r.refund.method }, Idempotent: r.idempotent }));
  });
  api.post("/RESTBooking.svc/booking/collect", async (c) => {
    const body = await c.req.json();
    return c.json(v1ok({ Booking: bookingJson(await markCollected(db, body.BookingId)) }));
  });
  api.post("/RESTBooking.svc/booking/link", async (c) => {
    // record swap relationship between bookings
    const body = (await c.req.json()) as { FromBookingId: string; ToBookingId: string };
    await db.update(S.bookings).set({ swappedToBookingId: body.ToBookingId, status: "swapped", updatedAt: new Date() }).where(eq(S.bookings.vistaBookingId, body.FromBookingId));
    await db.update(S.bookings).set({ swappedFromBookingId: body.FromBookingId, updatedAt: new Date() }).where(eq(S.bookings.vistaBookingId, body.ToBookingId));
    return c.json(v1ok({}));
  });

  // ---------------- Loyalty (RESTLoyalty.svc) ----------------
  api.post("/RESTLoyalty.svc/member/validate", async (c) => {
    const body = (await c.req.json()) as { MemberId?: string; Email?: string; Phone?: string; Pin?: string };
    const conds = [];
    if (body.MemberId) conds.push(eq(S.customers.memberId, body.MemberId));
    if (body.Email) conds.push(sql`lower(${S.customers.email}) = ${body.Email.toLowerCase()}`);
    if (body.Phone) conds.push(sql`regexp_replace(${S.customers.phone}, '\\D', '', 'g') like ${`%${body.Phone.replace(/\D/g, "").slice(-9)}`}`);
    if (!conds.length) throw new VistaError(RC.GENERAL, RC.GENERAL, "Provide MemberId, Email or Phone");
    const cust = (await db.select().from(S.customers).where(and(...conds)))[0];
    if (!cust) return c.json({ Result: 1, ExtendedResultCode: 404, ErrorDescription: "Member not found" });
    if (body.Pin && cust.demoPin !== body.Pin) return c.json({ Result: 1, ExtendedResultCode: 401, ErrorDescription: "Invalid PIN" });
    const acct = cust.memberId ? (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, cust.memberId)))[0] : undefined;
    return c.json(v1ok({ Member: { MemberId: cust.memberId, CustomerId: cust.id, FirstName: cust.firstName, LastName: cust.lastName, Email: cust.email, Phone: cust.phone, PreferredLanguage: cust.preferredLanguage, Tier: acct?.tier ?? null, HomeCinemaId: cust.homeCinemaId }, LoyaltySessionToken: `lst_${shortId(16)}` }));
  });
  api.get("/RESTLoyalty.svc/member/:memberId/balances", async (c) => {
    const acct = (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, c.req.param("memberId"))))[0];
    if (!acct) return c.json({ Result: 1, ExtendedResultCode: 404, ErrorDescription: "Member not found" });
    return c.json(v1ok({ MemberId: acct.memberId, Tier: acct.tier, Balances: [{ BalanceTypeId: "SHARE_POINTS", Name: "Share Points", Points: acct.sharePointsBalance, ValueCents: acct.sharePointsBalance }, { BalanceTypeId: "VOX_REWARDS", Name: "VOX credit", Points: null, ValueCents: acct.voxRewardsBalanceCents }] }));
  });
  api.get("/RESTLoyalty.svc/member/:memberId/ledger", async (c) => {
    const rows = await db.select().from(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, c.req.param("memberId"))).orderBy(desc(S.loyaltyLedger.createdAt)).limit(20);
    return c.json(v1ok({ Entries: rows.map((r) => ({ Type: r.balanceType, Delta: r.delta, Reason: r.reason, Reference: r.reference, At: r.createdAt.toISOString() })) }));
  });

  // ---------------- Offers Engine ----------------
  api.get("/offers/v1/offers", async (c) => {
    const q = c.req.query();
    const rows = await db.select().from(S.offers).where(eq(S.offers.active, true)).orderBy(S.offers.priority);
    let session: typeof S.sessions.$inferSelect | undefined;
    if (q.sessionKey) {
      const [cinemaId, sessionId] = q.sessionKey.split("-");
      session = (await db.select().from(S.sessions).where(and(eq(S.sessions.cinemaId, cinemaId!), eq(S.sessions.sessionId, sessionId!))))[0];
    }
    const acct = q.memberId ? (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, q.memberId)))[0] : undefined;
    const out = rows
      .filter((o) => !q.type || q.type === "any" || o.type === q.type)
      .map((o) => {
        const e = evaluateOffer(o as unknown as Offer, { cinemaId: q.cinemaId ?? session?.cinemaId, experience: q.experience ?? session?.experience, hoCode: session?.hoCode, showtime: session ? session.showtime.toISOString().slice(0, 19) : undefined, memberId: q.memberId, tier: acct?.tier, channel: "WWW" });
        return { ...o, eligibility: e };
      })
      .filter((o) => !q.eligibleOnly || o.eligibility.eligible || o.eligibility.requires.length);
    return c.json({ offers: out.map((o) => ({ id: o.id, title: o.title, titleAlt: o.titleAlt, shortDescription: o.shortDescription, shortDescriptionAlt: o.shortDescriptionAlt, terms: o.terms, type: o.type, imageUrl: o.imageUrl, rules: o.rules, benefit: o.benefit, remainingBudget: o.remainingBudget, perMemberLimit: o.perMemberLimit, howToRedeem: o.howToRedeem, eligibility: o.eligibility })) });
  });
  api.post("/offers/v1/offers/:id/eligibility", async (c) => {
    const o = (await db.select().from(S.offers).where(eq(S.offers.id, c.req.param("id"))))[0];
    if (!o) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json();
    let session: typeof S.sessions.$inferSelect | undefined;
    if (body.sessionKey) {
      const [cinemaId, sessionId] = String(body.sessionKey).split("-");
      session = (await db.select().from(S.sessions).where(and(eq(S.sessions.cinemaId, cinemaId!), eq(S.sessions.sessionId, sessionId!))))[0];
    }
    const acct = body.memberId ? (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, body.memberId)))[0] : undefined;
    const e = evaluateOffer(o as unknown as Offer, { cinemaId: session?.cinemaId ?? body.cinemaId, experience: session?.experience ?? body.experience, hoCode: session?.hoCode, showtime: session ? session.showtime.toISOString().slice(0, 19) : body.showtime, ticketCount: body.ticketCount, memberId: body.memberId, tier: acct?.tier, cardBin: body.cardBin, promoCode: body.promoCode, channel: "WWW" });
    return c.json({ offerId: o.id, ...e });
  });

  // ---------------- Customer profile ----------------
  api.get("/customer/v1/customers/:id", async (c) => {
    const cust = (await db.select().from(S.customers).where(eq(S.customers.id, c.req.param("id"))))[0];
    if (!cust) return c.json({ error: "not_found" }, 404);
    const acct = cust.memberId ? (await db.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, cust.memberId)))[0] : undefined;
    return c.json({ id: cust.id, firstName: cust.firstName, lastName: cust.lastName, email: cust.email, phone: cust.phone, memberId: cust.memberId, preferredLanguage: cust.preferredLanguage, preferences: cust.preferences, homeCinemaId: cust.homeCinemaId, tier: acct?.tier ?? null, sharePoints: acct?.sharePointsBalance ?? 0, voxRewardsCents: acct?.voxRewardsBalanceCents ?? 0, persona: cust.persona });
  });
  api.get("/customer/v1/customers/:id/history", async (c) => {
    const rows = await db.select().from(S.purchaseHistory).where(eq(S.purchaseHistory.customerId, c.req.param("id"))).orderBy(desc(S.purchaseHistory.showtime)).limit(50);
    return c.json({ history: rows.map((r) => ({ bookingId: r.bookingId, cinemaId: r.cinemaId, hoCode: r.hoCode, filmTitle: r.filmTitle, genres: r.genres, language: r.language, experience: r.experience, showtime: r.showtime.toISOString().slice(0, 19), ticketCount: r.ticketCount, concessionItemIds: r.concessionItemIds, spendCents: r.spendCents })) });
  });

  // ---------------- Admin / maintenance ----------------
  api.post("/admin/expire-orders", async (c) => c.json({ expired: await expireAbandonedOrders(db) }));

  app.route(BASE, api);
  return app;
}
