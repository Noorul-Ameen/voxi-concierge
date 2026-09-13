import { randomUUID } from "node:crypto";
import { schema as S, nowLocalIso } from "@voxi/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RC } from "../src/services/orders.js";
import { testApp } from "./helpers.js";

const app = testApp();
const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
const filmId = `TEST${suffix}`;
const sessionId = `age-${suffix}`;
let cinemaId: string;
let adultCode: string;
let childCode: string;
const orderIds: string[] = [];

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
  await app.db.insert(S.films).values({
    hoCode: filmId,
    title: "Classification regression",
    rating: "PG15",
    slug: `classification-${suffix}`,
  });
  await app.db.insert(S.sessions).values({ ...source!, sessionId, hoCode: filmId });
  const types = await app.db
    .select()
    .from(S.ticketTypes)
    .where(and(eq(S.ticketTypes.cinemaId, cinemaId), eq(S.ticketTypes.experience, "Standard")));
  adultCode = types.find(
    (type) => !type.isChildOnlyTicket && !type.isAvailableForLoyaltyMembersOnly,
  )!.ticketTypeCode;
  childCode = types.find(
    (type) => type.isChildOnlyTicket && !type.isAvailableForLoyaltyMembersOnly,
  )!.ticketTypeCode;
  // Start with a real map so rejected requests must preserve its version and exact seats.
  const plan = await app.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan`);
  expect(plan.json.SeatLayoutData).toBeDefined();
});

afterEach(async () => {
  for (const id of orderIds) await app.post("/Ticketing/order/cancel", { UserSessionId: id });
  if (orderIds.length) await app.db.delete(S.orders).where(inArray(S.orders.userSessionId, orderIds));
  orderIds.length = 0;
});
afterAll(async () => {
  if (cinemaId) {
    await app.db
      .delete(S.sessionSeatState)
      .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)));
    await app.db
      .delete(S.sessions)
      .where(and(eq(S.sessions.cinemaId, cinemaId), eq(S.sessions.sessionId, sessionId)));
  }
  await app.db.delete(S.films).where(eq(S.films.hoCode, filmId));
  await app.close();
});

const setRating = (rating: string | null) =>
  app.db.update(S.films).set({ rating }).where(eq(S.films.hoCode, filmId));
const seatState = () =>
  app.db
    .select()
    .from(S.sessionSeatState)
    .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)));
const storedOrder = (id: string) => app.db.select().from(S.orders).where(eq(S.orders.userSessionId, id));
function add(children: boolean, existingId?: string) {
  const id = existingId ?? `classification-${randomUUID()}`;
  if (!orderIds.includes(id)) orderIds.push(id);
  return {
    id,
    response: app.post("/Ticketing/Order/tickets", {
      UserSessionId: id,
      CinemaId: cinemaId,
      SessionId: sessionId,
      TicketTypes: [
        { TicketTypeCode: adultCode, Qty: 1 },
        ...(children ? [{ TicketTypeCode: childCode, Qty: 1 }] : []),
      ],
      ReorderSessionTickets: true,
    }),
  };
}

describe("provider child-ticket classification boundary", () => {
  it.each(["18TC", "15TC", "TBC", "", null, "15+", "18+", "21+"])(
    "rejects child ticket codes for %s without creating an order or changing seats",
    async (rating) => {
      await setRating(rating);
      const before = await seatState();
      const { id, response } = add(true);
      const result = await response;
      expect(result.json.Result).not.toBe(0);
      expect(result.json.ExtendedResultCode).toBe(RC.TICKET_TYPE_INVALID);
      expect(await storedOrder(id)).toEqual([]);
      expect(await seatState()).toEqual(before);
    },
  );

  it.each(["G", "PG", "PG 13", "PG15"])(
    "preserves child-ticket availability for confirmed guidance rating %s",
    async (rating) => {
      await setRating(rating);
      const { response } = add(true);
      const result = await response;
      expect(result.json.Result).toBe(0);
      expect(
        result.json.Order.Sessions[0].Tickets.map(
          (ticket: { TicketTypeCode: string }) => ticket.TicketTypeCode,
        ).sort(),
      ).toEqual([adultCode, childCode].sort());
      expect(result.json.Order.Sessions[0].SeatsAllocated).toBe(true);
    },
  );

  it.each(["18TC", "15TC", "TBC", "", null, "15+", "18+", "21+"])(
    "does not restrict adult-only ticket requests for %s",
    async (rating) => {
      await setRating(rating);
      const { response } = add(false);
      const result = await response;
      expect(result.json.Result).toBe(0);
      expect(result.json.Order.Sessions[0].Tickets).toHaveLength(1);
      expect(result.json.Order.Sessions[0].Tickets[0].TicketTypeCode).toBe(adultCode);
    },
  );

  it("rechecks a changed classification and preserves the prior hold on a rejected child-ticket edit", async () => {
    await setRating("PG15");
    const { id, response } = add(true);
    expect((await response).json.Result).toBe(0);
    const beforeOrder = await storedOrder(id);
    const beforeSeats = await seatState();
    await setRating("18TC");
    const changed = await add(true, id).response;
    expect(changed.json.ExtendedResultCode).toBe(RC.TICKET_TYPE_INVALID);
    expect(await storedOrder(id)).toEqual(beforeOrder);
    expect(await seatState()).toEqual(beforeSeats);
  });
});
