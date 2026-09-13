import { DEFAULT_POLICY } from "@voxi/domain";
import { beforeEach, expect, it, vi } from "vitest";
import { createConfirmation } from "../src/services/confirmations.js";
import { prepareSwap } from "../src/tools/swap.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/confirmations.js", () => ({
  createConfirmation: vi.fn(async () => ({ id: "swap-review" })),
}));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const booking = {
    VistaBookingId: "ORIGINAL",
    CinemaId: "cinema",
    SessionId: "original",
    ScheduledFilmId: "film",
    FilmTitle: "Film",
    Experience: "Standard",
    Showtime: "2030-06-03T19:00:00",
    Status: "confirmed",
    Version: 1,
    Customer: { ID: "customer", MemberId: "member", Email: "guest@example.com" },
    Tickets: [8, 9, 10].map((number) => ({
      Id: String(number),
      TicketTypeCode: "ORIGINAL-1001",
      Description: "Adult",
      SeatAreaCatCode: "regular",
      SeatRowId: "P",
      SeatNumber: String(number),
      FinalPriceCents: 5000,
      Status: "valid",
    })),
    Concessions: [],
    AppliedOffers: [],
    TotalValueCents: 15000,
    PaymentInfoCollection: [
      { PaymentTenderCategory: "CREDIT", PaymentValueCents: 15000, CardNumber: "1234" },
    ],
  };
  const session = (key: string, experience: string, time: string) => ({
    key,
    cinemaId: "cinema",
    sessionId: key,
    hoCode: "film",
    filmTitle: "Film",
    showtime: `2030-06-04T${time}:00`,
    experience,
    allowTicketSales: true,
    soldOut: false,
    seatsAvailable: 20,
  });
  const sessions = [
    session("imax", "IMAX", "19:00"),
    session("premier", "Premier", "19:01"),
    session("gold", "GOLD", "19:02"),
    session("standard-later", "Standard", "20:00"),
    session("standard-near", "Standard", "19:15"),
  ];
  const row = (name: string, index: number, numbers = [9, 10, 11]) => ({
    PhysicalName: name,
    RowIndexZeroBased: index,
    Seats: numbers.map((number) => ({ Id: number, Status: 0, Position: { ColumnIndex: number - 1 } })),
  });
  const layout = {
    ColumnCount: 20,
    Areas: [{ AreaCategoryCode: "regular", Rows: [row("A", 0), row("D", 3), row("G", 6)] }],
  };
  const ctx = {
    conversation: { id: "conversation", isLoggedIn: true, customerId: "customer", memberId: "member" },
    nowLocal: "2030-06-03T12:00:00",
    lang: "en",
    cfg: { policy: DEFAULT_POLICY, confirmationTtlSeconds: 60 },
    catalog: {
      cinema: async () => ({ name: "Cinema" }),
      sessions: async () => sessions,
      sessionByKey: async (key: string) => sessions.find((s) => s.key === key),
    },
    vista: {
      getBooking: async () => ({ Booking: booking }),
      customer: vi.fn(async () => ({ profile: { seatPreference: "back" } })),
      seatPlan: async () => ({ SeatLayoutData: layout }),
      ticketTypes: async () => ({
        BookingFeeCentsPerTicket: 0,
        Tickets: [{ TicketTypeCode: "TARGET-1001", AreaCategoryCode: "regular", PriceInCents: 5000 }],
      }),
      concessions: async () => ({ ConcessionTabs: [] }),
    },
  } as unknown as ToolCtx;
  const input = { bookingId: "ORIGINAL", date: "tomorrow", time: "19:00", keepSeatsIfPossible: true };
  return { ctx, booking, layout, row, input };
}

it("uses saved back seats when original rows do not exist, without changing tier or money", async () => {
  const { ctx, input } = fixture();
  const result = await prepareSwap(ctx, { ...input, targetSessionKey: "standard-near" });
  expect(result.ok).toBe(true);
  expect(result.data?.summary).toMatchObject({
    originalSeats: ["P8", "P9", "P10"],
    selectedSeats: [9, 10, 11].map((number) => ({
      Row: "G",
      Number: String(number),
      TicketTypeCode: "TARGET-1001",
    })),
    originalTotalCents: 15000,
    newTotalCents: 15000,
    differenceCents: 0,
    targetCinemaId: "cinema",
  });
  expect(createConfirmation).toHaveBeenCalledTimes(1);
});

it("keeps exact original seats before applying saved preferences when they remain available", async () => {
  const { ctx, booking, input } = fixture();
  booking.Tickets.forEach((ticket, index) => {
    ticket.SeatRowId = "D";
    ticket.SeatNumber = String(index + 9);
  });
  const result = await prepareSwap(ctx, { ...input, targetSessionKey: "standard-near" });
  expect(result.data?.summary.selectedSeats.map((s: { Row: string }) => s.Row)).toEqual(["D", "D", "D"]);
});

it("does not move into a different ticket tier to satisfy the back preference", async () => {
  const { ctx, layout, row, input } = fixture();
  layout.Areas[0]!.Rows = [row("A", 0), row("D", 3)];
  layout.Areas.push({ AreaCategoryCode: "premium", Rows: [row("G", 6)] });
  const result = await prepareSwap(ctx, { ...input, targetSessionKey: "standard-near" });
  expect(result.data?.summary.selectedSeats.map((s: { Row: string }) => s.Row)).toEqual(["D", "D", "D"]);
  expect(result.data?.summary.newTotalCents).toBe(15000);
});

it("does not borrow saved account preferences for a verified guest booking", async () => {
  const { ctx, input } = fixture();
  ctx.conversation.isLoggedIn = false;
  ctx.conversation.customerId = null;
  ctx.conversation.memberId = null;
  const result = await prepareSwap(ctx, {
    ...input,
    targetSessionKey: "standard-near",
    verification: { email: "guest@example.com" },
  });
  expect(result.data?.summary.selectedSeats.map((s: { Row: string }) => s.Row)).toEqual(["D", "D", "D"]);
  expect(ctx.vista.customer).not.toHaveBeenCalled();
});

it("ranks original experience first on the requested day, then its closest time", async () => {
  const { ctx, input } = fixture();
  const result = await prepareSwap(ctx, input);
  expect(result.data?.alternatives.map((s: { sessionKey: string }) => s.sessionKey)).toEqual([
    "standard-near",
    "standard-later",
    "imax",
  ]);
  expect(createConfirmation).not.toHaveBeenCalled();
});

it("preserves an explicit different experience choice", async () => {
  const { ctx, input } = fixture();
  const result = await prepareSwap(ctx, { ...input, experience: "IMAX" });
  expect(result.data?.alternatives.map((s: { sessionKey: string }) => s.sessionKey)).toEqual(["imax"]);
  expect(createConfirmation).not.toHaveBeenCalled();
});
