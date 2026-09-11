/** Explicit simulator fixtures. Never resets a touched fixture or modifies a real booking/held session. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import * as S from "../schema/index.js";
import { generateSeatState, pickAdjacentSeats, seatKey } from "../seats.js";
import { demoScheduleEnabled } from "./refresh-demo-schedule.js";
import { nowLocalDate } from "./util.js";

export const JOURNEY_FIXTURE_SOURCE = "demo-journey-v1";
const fixtures = [
  {
    id: "JYSARA1",
    customerId: "cust_sara",
    cinemaId: "0002",
    language: "Arabic",
    children: 1,
    food: ["9540", "7747"],
    bank: false,
  },
  {
    id: "JYRAHL1",
    customerId: "cust_rahul",
    cinemaId: "0013",
    language: "Tamil",
    children: 0,
    food: [],
    bank: false,
  },
  {
    id: "JYJAMB1",
    customerId: "cust_james",
    cinemaId: "0002",
    language: "English",
    children: 0,
    food: [],
    bank: true,
  },
  {
    id: "JYJAMN1",
    customerId: "cust_james",
    cinemaId: "0002",
    language: "English",
    children: 0,
    food: [],
    bank: false,
  },
];
const obsolete = ["WXA7K2M", "WM3PQ9X", "WMB6GQ2", "WKGRP33", "WK4DXC9", "WJG8LD7", "WJMX42R"];
export async function refreshDemoJourneyFixtures(db: Db, env = process.env, now = nowLocalDate()) {
  if (!demoScheduleEnabled(env)) return { enabled: false, inserted: 0, archived: 0 };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('demo-journey-fixtures-v1'))`);
    let inserted = 0;
    for (const [index, fixture] of fixtures.entries()) {
      if ((await tx.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, fixture.id))).length)
        continue;
      const [customer] = await tx.select().from(S.customers).where(eq(S.customers.id, fixture.customerId));
      if (!customer) continue;
      const candidates = await tx
        .select({ session: S.sessions, film: S.films })
        .from(S.sessions)
        .innerJoin(S.films, eq(S.films.hoCode, S.sessions.hoCode))
        .where(and(eq(S.sessions.cinemaId, fixture.cinemaId), eq(S.films.status, "now_showing")));
      const suitable = candidates
        .sort(
          (a, b) =>
            Number(b.session.experience === (fixture.children ? "KIDS" : "Premier")) -
            Number(a.session.experience === (fixture.children ? "KIDS" : "Premier")),
        )
        .filter(({ film }) => !fixture.children || !/^(15|18|21)/.test(film.rating ?? ""));
      const candidate =
        suitable.find(({ film }) => film.language === fixture.language) ??
        (fixture.children
          ? suitable.find(({ film }) => film.genreNames?.some((g) => /family|animation/i.test(g)))
          : undefined);
      if (!candidate) throw new Error(`No catalogue template for demo journey ${fixture.id}`);
      const { session: template, film } = candidate;
      const [layout] = await tx
        .select()
        .from(S.seatLayoutTemplates)
        .where(eq(S.seatLayoutTemplates.id, template.seatLayoutTemplateId ?? "STD-M"));
      if (!layout) throw new Error("Demo journey seat template missing");
      const showtime = new Date(now);
      showtime.setUTCDate(showtime.getUTCDate() + 1 + (index % 2));
      showtime.setUTCHours(fixture.customerId === "cust_sara" ? 16 : 20, 0, 0, 0);
      const sessionId = `D${fixture.id}`;
      const session = {
        ...template,
        sessionId,
        showtime,
        sessionBusinessDate: showtime.toISOString().slice(0, 10),
        allowTicketSales: true,
        soldoutStatus: 0,
        sourceHash: `demo-journey:v1:${fixture.id}`,
      };
      await tx.insert(S.sessions).values(session).onConflictDoNothing();
      // A separate later synthetic slot makes same-film exchanges possible without editing a booked session.
      await tx
        .insert(S.sessions)
        .values({
          ...session,
          sessionId: `${sessionId}N`,
          showtime: new Date(showtime.getTime() + 120 * 60_000),
          sourceHash: `demo-journey:v1:${fixture.id}:alternative`,
        })
        .onConflictDoNothing();
      const state = generateSeatState(session.cinemaId, session.sessionId, layout.layout, {
        occupancy: 0.15,
      });
      const types = await tx
        .select()
        .from(S.ticketTypes)
        .where(
          and(
            eq(S.ticketTypes.cinemaId, fixture.cinemaId),
            eq(S.ticketTypes.experience, template.experience),
          ),
        );
      const adult = types.find(
        (t) =>
          t.areaCategoryCode === "0000000002" && !t.isChildOnlyTicket && !t.isAvailableForLoyaltyMembersOnly,
      )!;
      const child = types.find((t) => t.areaCategoryCode === adult?.areaCategoryCode && t.isChildOnlyTicket);
      if (!adult || (fixture.children && !child)) throw new Error("Demo journey ticket types missing");
      const seats = pickAdjacentSeats(
        layout.layout,
        state,
        2,
        customer.preferences?.seatPreference ?? "middle",
        adult.areaCategoryCode,
      );
      if (seats.length !== 2) throw new Error("Demo journey seats unavailable");
      const [offer] = fixture.bank
        ? await tx.select().from(S.offers).where(eq(S.offers.id, "BANK-MASHREQ-50"))
        : [];
      if (fixture.bank && offer?.benefit.type !== "percent_off")
        throw new Error("Demo bank fixture offer unavailable");
      const tickets: S.BookingTicket[] = seats.map((seat, i) => {
        const type = fixture.children && i === 1 ? child! : adult;
        const discount =
          offer?.benefit.type === "percent_off"
            ? Math.round((type.priceInCents * offer.benefit.percent) / 100)
            : 0;
        const final = type.priceInCents - discount;
        state[seatKey(seat.row, seat.number)] = { status: 1, bookingId: fixture.id };
        return {
          Id: String(i + 1),
          TicketTypeCode: type.ticketTypeCode,
          Description: type.description,
          DescriptionAlt: type.descriptionAlt ?? "",
          PriceCents: type.priceInCents,
          FinalPriceCents: final,
          DiscountPriceCents: discount,
          TaxCents: Math.round(final - final / 1.05),
          AreaCategoryCode: type.areaCategoryCode,
          SeatRowId: seat.row,
          SeatNumber: seat.number,
          SeatRowIndex: seat.rowIndex,
          SeatColumnIndex: seat.columnIndex,
          SeatAreaNumber: seat.areaNumber,
          DealDefinitionId: offer?.id ?? null,
          DealDescription: offer?.title ?? null,
          LoyaltyRecognitionId: null,
          Barcode: `${fixture.id}${i + 1}`,
          Status: "valid",
        };
      });
      const food = fixture.food.length
        ? await tx.select().from(S.concessionItems).where(inArray(S.concessionItems.id, fixture.food))
        : [];
      const concessions = food.map((item, i) => ({
        Id: String(i + 1),
        ItemId: item.id,
        Description: item.description,
        Quantity: 1,
        PriceCents: item.priceInCents,
        DealPriceCents: item.priceInCents,
        FinalPriceCents: item.priceInCents,
        TaxCents: Math.round(item.priceInCents - item.priceInCents / 1.05),
        DeliveryOption: 2,
        Modifiers: [],
        DealDefinitionId: null,
        DealDescription: null,
      }));
      const fee = 500;
      const total =
        tickets.reduce((n, t) => n + t.FinalPriceCents, 0) +
        concessions.reduce((n, c) => n + c.FinalPriceCents, 0) +
        fee;
      const card =
        customer.savedCards?.find((c) => !fixture.bank || c.first6 === "472937") ?? customer.savedCards?.[0];
      if (!card) throw new Error("Demo fixture requires an actual saved card");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('booking-reference-sequence'))`);
      const [numbers] = await tx
        .select({
          number: sql<number>`coalesce(max(${S.bookings.vistaBookingNumber}),100000)+1`,
          transaction: sql<number>`coalesce(max(${S.bookings.vistaTransNumber}),500000)+1`,
        })
        .from(S.bookings);
      await tx.insert(S.bookings).values({
        vistaBookingId: fixture.id,
        vistaBookingNumber: Number(numbers!.number),
        vistaTransNumber: Number(numbers!.transaction),
        cinemaId: fixture.cinemaId,
        sessionId,
        hoCode: film.hoCode,
        filmTitle: film.title,
        filmTitleAlt: film.titleAlt,
        filmClassification: film.rating,
        experience: template.experience,
        screenName: session.screenName,
        showtime,
        status: "confirmed",
        customerId: customer.id,
        customer: {
          FirstName: customer.firstName,
          LastName: customer.lastName,
          Email: customer.email,
          Phone: customer.phone,
          ...(customer.memberId ? { MemberId: customer.memberId } : {}),
        },
        tickets,
        concessions,
        appliedOffers: offer
          ? [
              {
                offerId: offer.id,
                title: offer.title,
                type: "bank",
                discountCents: tickets.reduce((n, t) => n + t.DiscountPriceCents, 0),
                cardBin: card.first6,
                bankBins: offer.rules.bankBins,
                bankName: offer.rules.bankName,
              },
            ]
          : [],
        payments: [
          {
            PaymentTenderCategory: "CREDIT",
            PaymentValueCents: total,
            CardNumberMasked: `${card.first6}** **** ${card.last4}`,
            CardType: card.brand,
            Reference: `demo:${fixture.id}`,
          },
        ],
        totalValueCents: total,
        bookingFeeValueCents: fee,
        taxValueCents: Math.round(total - fee - (total - fee) / 1.05),
        source: JOURNEY_FIXTURE_SOURCE,
        qrPayload: `VOX|${fixture.id}|${fixture.cinemaId}|${sessionId}`,
      });
      await tx
        .insert(S.sessionSeatState)
        .values({ cinemaId: fixture.cinemaId, sessionId, seats: state, version: 1 });
      await tx
        .update(S.sessions)
        .set({ seatsAvailable: Object.values(state).filter((s) => s.status === 0).length })
        .where(and(eq(S.sessions.cinemaId, fixture.cinemaId), eq(S.sessions.sessionId, sessionId)));
      inserted++;
    }
    // Archive only explicitly identified pristine seed examples; no status, payment, seat or history is rewritten.
    const archived = await tx
      .update(S.bookings)
      .set({ source: "demo-archived" })
      .where(
        and(
          inArray(S.bookings.vistaBookingId, obsolete),
          eq(S.bookings.source, "seed"),
          eq(S.bookings.version, 1),
          eq(S.bookings.refundedValueCents, 0),
          sql`not exists(select 1 from ${S.actions} where ${S.actions.resourceKey} = 'booking:' || ${S.bookings.vistaBookingId})`,
        ),
      )
      .returning({ id: S.bookings.vistaBookingId });
    return { enabled: true, inserted, archived: archived.length };
  });
}
