import { schema as S, nowLocalIso } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.js";

const app = testApp();
const startedAt = Date.now();
const orderIds: string[] = [];
let cinemaId: string;
let sessionId: string;
let ticketCode: string;
let itemId: string;
let memberId: string;

beforeAll(async () => {
  await app.auth();
  const shows = await app.get(
    `/OData/Sessions?$filter=Experience eq 'Standard' and Showtime gt DATETIME'${nowLocalIso()}'&$orderby=Showtime asc&$top=100`,
  );
  const show = shows.json.value.find(
    (row: { SeatsAvailable: number; AllowTicketSales?: boolean }) =>
      row.SeatsAvailable > 30 && row.AllowTicketSales !== false,
  );
  expect(show).toBeTruthy();
  cinemaId = show.CinemaId;
  sessionId = show.SessionId;
  const types = await app.get(`/Data/Cinemas/${cinemaId}/sessions/${sessionId}/tickets`);
  ticketCode = types.json.Tickets.find(
    (row: { IsChildOnlyTicket: boolean; IsAvailableForLoyaltyMembersOnly: boolean }) =>
      !row.IsChildOnlyTicket && !row.IsAvailableForLoyaltyMembersOnly,
  ).TicketTypeCode;
  const [item] = await app.db.select().from(S.concessionItems).where(eq(S.concessionItems.active, true));
  itemId = item!.id;
  const accounts = await app.db.select().from(S.loyaltyAccounts);
  memberId = accounts.find((row) => row.sharePointsBalance >= 10)!.memberId;
});
beforeEach(() => {
  // Fake Date only: network/database scheduling continues on the real clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startedAt);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const userSessionId of orderIds.splice(0))
    await app.post("/Ticketing/order/cancel", { UserSessionId: userSessionId });
});
afterAll(async () => {
  await app.close();
});

async function hold() {
  const userSessionId = `hold-deadline-${crypto.randomUUID()}`;
  orderIds.push(userSessionId);
  const response = await changeTickets(userSessionId, 2);
  expect(response.json.Result).toBe(0);
  const expiry = response.json.Order.ExpiryDateUtc as string;
  expect(new Date(expiry).getTime()).toBe(Date.now() + app.cfg.order.expiryMinutes * 60_000);
  return { userSessionId, expiry, order: response.json.Order };
}

function changeTickets(userSessionId: string, quantity: number) {
  return app.post("/Ticketing/Order/tickets", {
    UserSessionId: userSessionId,
    CinemaId: cinemaId,
    SessionId: sessionId,
    TicketTypes: [{ TicketTypeCode: ticketCode, Qty: quantity }],
    ReorderSessionTickets: true,
  });
}

function addFood(userSessionId: string) {
  return app.post("/Ticketing/Order/concessions", {
    UserSessionId: userSessionId,
    CinemaId: cinemaId,
    Concessions: [{ ItemId: itemId, Quantity: 1 }],
  });
}

async function seatState() {
  const [state] = await app.db
    .select()
    .from(S.sessionSeatState)
    .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)));
  return state!.seats;
}

it.each(["food", "seats", "tickets"])("keeps the original hold deadline after changing %s", async (edit) => {
  const { userSessionId, expiry } = await hold();
  vi.setSystemTime(startedAt + 158_000); // 3:22 remains on the six-minute hold seen in the live regression.
  let changed: Awaited<ReturnType<typeof app.post>>;
  if (edit === "food") {
    changed = await addFood(userSessionId);
    expect(changed.json.Order.Concessions).toHaveLength(1);
  } else if (edit === "tickets") {
    changed = await changeTickets(userSessionId, 3);
    expect(changed.json.Order.Sessions[0].Tickets).toHaveLength(3);
  } else {
    const plan = await app.get(
      `/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan?userSessionId=${userSessionId}`,
    );
    type Area = {
      Rows: { PhysicalName: string; Seats: { Id: string; Status: number; SeatStyle: number }[] }[];
    };
    const free = (plan.json.SeatLayoutData.Areas as Area[])
      .flatMap((area) =>
        area.Rows.flatMap((row) => row.Seats.map((seat) => ({ ...seat, row: row.PhysicalName }))),
      )
      .filter((seat) => seat.Status === 0 && seat.SeatStyle === 0)
      .slice(0, 2);
    changed = await app.post("/Ticketing/Order/seats", {
      UserSessionId: userSessionId,
      CinemaId: cinemaId,
      SessionId: sessionId,
      SelectedSeats: free.map((seat) => ({ Row: seat.row, Number: seat.Id })),
    });
    expect(
      changed.json.Order.Sessions[0].Tickets.map((ticket: { SeatData: string }) => ticket.SeatData).sort(),
    ).toEqual(free.map((seat) => `${seat.row}${seat.Id}`).sort());
  }
  expect(changed.json.Result).toBe(0);
  expect(changed.json.Order.ExpiryDateUtc).toBe(expiry);
  const held = Object.entries(await seatState()).filter(([, seat]) => seat.orderId === userSessionId);
  expect(held).toHaveLength(edit === "tickets" ? 3 : 2);
  expect(held.every(([, seat]) => seat.status === 2)).toBe(true);

  vi.setSystemTime(new Date(expiry).getTime());
  const expired = await app.get(`/Ticketing/order/${userSessionId}`);
  expect(expired.json.Order.ExpiryDateUtc).toBe(expiry);
  const [stored] = await app.db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId));
  expect(stored?.state).toBe("expired");
  const released = await seatState();
  expect(held.every(([key]) => released[key]?.status === 0)).toBe(true);
});

it("preserves the hold while applying rewards and removing offers or food", async () => {
  const { userSessionId, expiry } = await hold();
  const food = await addFood(userSessionId);
  vi.setSystemTime(startedAt + 158_000);
  const reward = await app.post("/Ticketing/Order/loyalty-redeem", {
    UserSessionId: userSessionId,
    MemberId: memberId,
    Points: 10,
  });
  expect(reward.json.Result).toBe(0);
  expect(reward.json.Redeemed.Amount).toBe(100);
  expect(reward.json.Order.ExpiryDateUtc).toBe(expiry);
  const offer = await app.post("/Ticketing/Order/offers", { UserSessionId: userSessionId, Remove: true });
  expect(offer.json.Result).toBe(0);
  expect(offer.json.Order.ExpiryDateUtc).toBe(expiry);
  const removed = await app.call(
    "DELETE",
    `/Ticketing/Order/concessions/${food.json.Order.Concessions[0].Id}?userSessionId=${userSessionId}`,
  );
  expect(removed.json.Result).toBe(0);
  expect(removed.json.Order.Concessions ?? []).toHaveLength(0);
  expect(removed.json.Order.ExpiryDateUtc).toBe(expiry);
});

it("refuses edits at the deadline and only gives a new order a fresh hold", async () => {
  const { userSessionId, expiry } = await hold();
  vi.setSystemTime(new Date(expiry).getTime());
  const food = await addFood(userSessionId);
  expect(food.json.Result).not.toBe(0);
  expect(food.json.ErrorDescription).toMatch(/expired/i);
  const tickets = await changeTickets(userSessionId, 2);
  expect(tickets.json.Result).not.toBe(0);
  expect(tickets.json.ErrorDescription).toMatch(/expired/i);
  const original = await app.get(`/Ticketing/order/${userSessionId}`);
  expect(original.json.Order.ExpiryDateUtc).toBe(expiry);
  expect(Object.values(await seatState()).some((seat) => seat.orderId === userSessionId)).toBe(false);
  // Explicit recovery in concierge-core creates a new UserSessionId; edits never do.
  const renewed = await hold();
  expect(renewed.userSessionId).not.toBe(userSessionId);
  expect(new Date(renewed.expiry).getTime()).toBe(
    new Date(expiry).getTime() + app.cfg.order.expiryMinutes * 60_000,
  );
});
