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
    cfg: { policy: DEFAULT_POLICY, confirmationTtlSeconds: 60, widgetJwtSecret: "swap-test-only-key" },
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

it("returns a read-only closest-match continuation and requires a separate priced preview", async () => {
  const { ctx, input } = fixture();
  const found = await prepareSwap(ctx, input);
  expect(found.data?.nextStep).toBe("preview_recommended");
  expect(found.data?.recommendedPreviewInput).toMatchObject({
    ...input,
    date: "2030-06-04",
    targetSessionKey: "standard-near",
  });
  expect(found.data).not.toHaveProperty("confirmationId");
  expect(createConfirmation).not.toHaveBeenCalled();
  const priced = await prepareSwap(ctx, found.data!.recommendedPreviewInput);
  expect(priced.data?.summary.newTotalCents).toBe(15000);
  expect(createConfirmation).toHaveBeenCalledTimes(1);
});

it("does not substitute a recommendation for an invalid customer-selected target or an empty match", async () => {
  const { ctx, input } = fixture();
  const invalid = await prepareSwap(ctx, { ...input, targetSessionKey: "missing" });
  expect(invalid.data).not.toHaveProperty("recommendedPreviewInput");
  expect(invalid.data).not.toHaveProperty("nextStep");
  ctx.catalog.sessions = async () => [];
  const empty = await prepareSwap(ctx, input);
  expect(empty.data?.alternatives).toEqual([]);
  expect(empty.data).not.toHaveProperty("recommendedPreviewInput");
  expect(createConfirmation).not.toHaveBeenCalled();
});

it.each(["en", "ar"] as const)(
  "keeps empty replacement evidence scoped and asks before widening in %s",
  async (lang) => {
    const { ctx, input, booking } = fixture();
    ctx.lang = lang;
    const original = structuredClone(booking);
    const seatRead = vi.spyOn(ctx.vista, "seatPlan");
    // Other experiences really exist on the requested day. An empty THEATRE
    // replacement cannot truthfully establish that there are no shows all day.
    const result = await prepareSwap(ctx, { ...input, experience: "THEATRE", time: "18:30" });
    expect(result.data).toMatchObject({
      bookingId: "ORIGINAL",
      needs: "swap_session",
      nextStep: "ask_before_widening",
      alternatives: [],
      sameCinemaRequired: true,
      requestedScope: {
        hoCode: "film",
        filmTitle: "Film",
        cinemaId: "cinema",
        cinemaName: "Cinema",
        date: "2030-06-04",
        dateMatch: "requested_day",
        time: "18:30",
        timeMatch: "closest_to",
        experience: "THEATRE",
        experienceMatch: "required",
      },
      availabilityScope: "closest_matches_only",
      canConcludeNoShowsAllDay: false,
      originalBookingUnchanged: true,
    });
    expect(result.ui?.meta).toMatchObject({
      requestedScope: result.data?.requestedScope,
      nextStep: "ask_before_widening",
      canConcludeNoShowsAllDay: false,
    });
    expect(result.ui?.actions).toEqual([]);
    expect(result.data).not.toHaveProperty("confirmationId");
    expect(result.data).not.toHaveProperty("recommendedPreviewInput");
    expect(result.speech).toContain(lang === "en" ? "Would you like to change" : "هل ترغب في تغيير");
    expect(result.speech).not.toMatch(/no showtimes|no shows|لا توجد عروض/);
    expect(createConfirmation).not.toHaveBeenCalled();
    expect(seatRead).not.toHaveBeenCalled();
    expect(booking).toEqual(original);
  },
);

it("keeps explicit seat-change discovery separate from an unchanged booking selection", async () => {
  const { ctx } = fixture();
  ctx.catalog.sessions = async () => [];
  const result = await prepareSwap(ctx, { bookingId: "ORIGINAL", keepSeatsIfPossible: false });
  expect(result.data?.requestedScope).toMatchObject({
    date: "2030-06-03",
    dateMatch: "original_day_preferred",
    time: "19:00",
    timeMatch: "closest_to",
    experience: "Standard",
    experienceMatch: "original_preferred",
  });
  expect(result.data?.nextStep).toBe("ask_before_widening");
  expect(createConfirmation).not.toHaveBeenCalled();
});

it("keeps an omitted-date recommendation usable when the original day has no replacement", async () => {
  const { ctx, input, booking } = fixture();
  const original = structuredClone(booking);
  const found = await prepareSwap(ctx, { ...input, date: undefined, time: "19:30" });
  expect(found.data?.recommendedPreviewInput).toMatchObject({
    bookingId: "ORIGINAL",
    date: "2030-06-04",
    time: "19:30",
    targetSessionKey: "standard-near",
    keepSeatsIfPossible: true,
  });
  expect(booking.Showtime).toBe("2030-06-03T19:00:00");
  expect(createConfirmation).not.toHaveBeenCalled();
  const priced = await prepareSwap(ctx, found.data!.recommendedPreviewInput);
  expect(priced.ok).toBe(true);
  expect(priced.data?.summary).toMatchObject({
    bookingId: "ORIGINAL",
    targetCinemaId: "cinema",
    targetSessionKey: "standard-near",
    targetShowtime: "2030-06-04T19:15:00",
    targetExperience: "Standard",
    differenceCents: 0,
  });
  expect(priced.data?.confirmationId).toBe("swap-review");
  expect(createConfirmation).toHaveBeenCalledTimes(1);
  expect(booking).toEqual(original);
});

it.each([undefined, "today", "2030-06-03"])(
  "asks for an actual change before finding replacements for unchanged date %s",
  async (date) => {
    const { ctx, input, booking } = fixture();
    const read = vi.spyOn(ctx.catalog, "sessions");
    const original = structuredClone(booking);
    const result = await prepareSwap(ctx, { ...input, date, time: "19:00", experience: "Standard" });
    expect(result.data).toMatchObject({
      needs: "swap_change",
      bookingId: "ORIGINAL",
      originalBookingUnchanged: true,
    });
    expect(result.data).not.toHaveProperty("confirmationId");
    expect(result.data).not.toHaveProperty("recommendedPreviewInput");
    expect(read).not.toHaveBeenCalled();
    expect(createConfirmation).not.toHaveBeenCalled();
    expect(booking).toEqual(original);
  },
);

it("treats tomorrow as unchanged when that is already the original booking day", async () => {
  const { ctx, input, booking } = fixture();
  booking.Showtime = "2030-06-04T19:00:00";
  const result = await prepareSwap(ctx, input);
  expect(result.data?.needs).toBe("swap_change");
  expect(createConfirmation).not.toHaveBeenCalled();
});

function cheaperFixture() {
  const f = fixture();
  f.ctx.vista.ticketTypes = async () =>
    ({
      BookingFeeCentsPerTicket: 0,
      Tickets: [{ TicketTypeCode: "TARGET-1001", AreaCategoryCode: "regular", PriceInCents: 4000 }],
    }) as any;
  return { ...f, input: { ...f.input, targetSessionKey: "standard-near" } };
}

it.each(["en", "ar"] as const)(
  "requires refund destination before a cheaper exchange confirmation in %s",
  async (lang) => {
    const { ctx, input, booking } = cheaperFixture();
    ctx.lang = lang;
    const original = structuredClone(booking);
    const result = await prepareSwap(ctx, input);
    expect(result.data).toMatchObject({
      needs: "swap_refund_method",
      requestedMethodAllowed: true,
      summary: {
        originalTotalCents: 15000,
        newTotalCents: 12000,
        differenceCents: -3000,
        refundMethodSelected: false,
      },
      refundMethods: [
        { method: "VOX_CREDIT", amountCents: 3000, validityDays: 90 },
        { method: "ORIGINAL_PAYMENT", amountCents: 3000, cardLast4: "1234" },
      ],
    });
    expect(result.data?.summary.refundMethod).toBeUndefined();
    expect(result.data).not.toHaveProperty("confirmationId");
    expect(result.ui).toMatchObject({
      type: "refund_options",
      actions: [],
      meta: { journey: "swap", targetSessionKey: input.targetSessionKey, keepSeatsIfPossible: true },
    });
    expect(result.ui?.meta?.refundChoiceProof).toEqual(expect.any(String));
    expect(result.speech).toContain("5–10");
    expect(result.speech).toContain("90");
    expect(createConfirmation).not.toHaveBeenCalled();
    expect(booking).toEqual(original);
  },
);

it.each(["VOX_CREDIT", "ORIGINAL_PAYMENT"] as const)(
  "binds only the explicitly chosen %s destination in a separate confirmation",
  async (method) => {
    const { ctx, input } = cheaperFixture();
    const result = await prepareSwap(ctx, { ...input, refundMethodForDifference: method });
    expect(result.data?.confirmationId).toBe("swap-review");
    expect(result.data?.summary).toMatchObject({
      refundMethod: method,
      refundMethodSelected: true,
      differenceCents: -3000,
      permittedRefundMethods: ["VOX_CREDIT", "ORIGINAL_PAYMENT"],
    });
    expect(result.data?.summary.refundEta).toContain(method === "VOX_CREDIT" ? "90" : "5–10");
    expect(createConfirmation).toHaveBeenCalledTimes(1);
  },
);

it("does not default or bind an unavailable refund method", async () => {
  const { ctx, input } = cheaperFixture();
  const result = await prepareSwap(ctx, { ...input, refundMethodForDifference: "SHARE_POINTS" });
  expect(result.data).toMatchObject({ needs: "swap_refund_method", requestedMethodAllowed: false });
  expect(result.data?.summary.refundMethod).toBeUndefined();
  expect(createConfirmation).not.toHaveBeenCalled();
});

it("normalizes omitted keep-seats before signing a widget choice", async () => {
  const { ctx, input } = cheaperFixture();
  const options = await prepareSwap(ctx, { ...input, keepSeatsIfPossible: undefined } as any);
  expect(options.ui?.meta?.keepSeatsIfPossible).toBe(true);
  ctx.refundChoiceProof = options.ui!.meta!.refundChoiceProof as string;
  const reviewed = await prepareSwap(ctx, {
    ...input,
    keepSeatsIfPossible: true,
    refundMethodForDifference: "ORIGINAL_PAYMENT",
  });
  expect(reviewed.data?.confirmationId).toBe("swap-review");
});

it("carries verified guest ownership across only the exact refund-choice click", async () => {
  const { ctx, booking, input } = cheaperFixture();
  (booking.Customer as any).MemberId = undefined;
  ctx.conversation.isLoggedIn = false;
  ctx.conversation.customerId = null;
  ctx.conversation.memberId = null;
  const options = await prepareSwap(ctx, { ...input, verification: { email: "guest@example.com" } });
  expect(options.data?.refundMethods.map((m: any) => m.method)).toEqual(["ORIGINAL_PAYMENT"]);
  ctx.refundChoiceProof = options.ui!.meta!.refundChoiceProof as string;
  const selected = { ...input, refundMethodForDifference: "ORIGINAL_PAYMENT" as const };
  expect((await prepareSwap(ctx, selected)).data?.confirmationId).toBe("swap-review");
  vi.mocked(createConfirmation).mockClear();
  for (const changed of [
    { ...selected, targetSessionKey: "standard-later" },
    { ...selected, keepSeatsIfPossible: false },
  ])
    expect((await prepareSwap(ctx, changed)).error?.code).toBe("CONFIRMATION_EXPIRED");
  booking.Version++;
  expect((await prepareSwap(ctx, selected)).error?.code).toBe("CONFIRMATION_EXPIRED");
  booking.Version--;
  ctx.conversation.metadata = { widgetAuthGeneration: 1 };
  expect((await prepareSwap(ctx, selected)).error?.code).toBe("CONFIRMATION_EXPIRED");
  expect(createConfirmation).not.toHaveBeenCalled();
});

it("keeps extra-charge reviews unchanged and does not require a refund choice", async () => {
  const { ctx, input, booking } = fixture();
  booking.TotalValueCents = 14000;
  const result = await prepareSwap(ctx, { ...input, targetSessionKey: "standard-near" });
  expect(result.data?.summary).toMatchObject({
    differenceCents: 1000,
    chargeCents: 1000,
    paymentMethod: "CARD",
  });
  expect(result.data?.confirmationId).toBe("swap-review");
});
