import { expect, it, vi } from "vitest";
import { customerTools } from "../src/tools/customer.js";
import { orderingTools } from "../src/tools/ordering.js";
import { quickTools } from "../src/tools/quick.js";
import type { ToolCtx } from "../src/tools/types.js";

it("rebuilds safe booking choices from the actual order on a new connection before and after expiry", async () => {
  const expiry = "2070-09-10T16:06:00Z";
  const order = {
    UserSessionId: "held-order",
    State: "seats_selected",
    CinemaId: "0002",
    ExpiryDateUtc: expiry,
    TotalValueCents: 10500,
    DiscountValueCents: 1000,
    Customer: { Email: "private@example.com", Phone: "private-phone" },
    Payments: [{ CardToken: "private-payment-token" }],
    Sessions: [
      {
        SessionId: "123",
        FilmTitle: "Spider-Man",
        ShowingRealDateTimeOffset: "2070-09-10T20:00:00+04:00",
        SeatsAllocated: true,
        Tickets: ["8", "9"].map((seat) => ({
          Id: seat,
          TicketTypeCode: "ADULT",
          Description: "Adult",
          SeatRowId: "G",
          SeatNumber: seat,
          SeatData: `G${seat}`,
          PriceCents: 5000,
          FinalPriceCents: 4500,
        })),
      },
    ],
    Concessions: [
      {
        Id: "food-line",
        ItemId: "POPCORN",
        Description: "Popcorn",
        Quantity: 1,
        PriceCents: 1500,
        FinalPriceCents: 1500,
        Modifiers: [{ Description: "Salted" }],
      },
    ],
    AppliedOffers: [
      {
        offerId: "offer",
        title: "Card discount",
        discountCents: 1000,
        type: "bank",
        cardBin: "private-bin",
        cardToken: "private-offer-token",
      },
    ],
  };
  const getOrder = vi.fn(async () => ({ Order: order }));
  const newContext = () =>
    ({
      conversation: {
        id: "new-elevenlabs-conversation",
        isLoggedIn: false,
        metadata: {
          activeOrder: "held-order",
          activeSessionKey: "stale-session-key",
          bookingState: { selectedMovie: "stale cached movie" },
        },
      },
      lang: "en",
      nowLocal: "2070-09-10T16:00:00",
      cfg: { market: "AE" },
      vista: { getOrder, addTickets: vi.fn() },
      catalog: { cinema: vi.fn(async () => ({ id: "0002", name: "Mall of the Emirates" })) },
    }) as unknown as ToolCtx;
  const before = await customerTools.get_session_context(newContext(), {});
  const activeBefore = before.data?.activeOrder as {
    summary: Record<string, unknown>;
    bookingState: Record<string, unknown>;
  };
  expect(activeBefore).toMatchObject({
    sessionKey: "0002-123",
    requiresFreshHold: false,
    summary: { filmTitle: "Spider-Man", cinemaName: "Mall of the Emirates", totalCents: 10500 },
    bookingState: {
      selectedMovie: "Spider-Man",
      ticketQuantity: 2,
      selectedSeats: "G8, G9",
      seatHoldExpiry: expiry,
      currentJourneyStage: "seats",
    },
  });
  order.State = "expired";
  const after = await customerTools.get_session_context(newContext(), {});
  const activeAfter = after.data?.activeOrder as {
    summary: Record<string, unknown>;
    bookingState: Record<string, unknown>;
  };
  expect(activeAfter).toMatchObject({
    requiresFreshHold: true,
    bookingState: { currentJourneyStage: "expired" },
  });
  for (const field of [
    "selectedMovie",
    "selectedCinema",
    "selectedShowtime",
    "ticketQuantity",
    "selectedSeats",
    "foodCart",
    "offers",
    "totalCents",
    "seatHoldExpiry",
  ])
    expect(activeAfter.bookingState[field]).toEqual(activeBefore.bookingState[field]);
  const resumedContext = newContext();
  const resumed = await quickTools.resume_order(resumedContext, {});
  expect(resumed.data).toMatchObject({
    active: false,
    expired: true,
    needs: "recovery_confirmation",
    summary: activeAfter.summary,
    bookingState: activeAfter.bookingState,
  });
  expect(resumedContext.vista.addTickets).not.toHaveBeenCalled();
  const checked = await orderingTools.get_order(newContext(), { userSessionId: "held-order" });
  expect(checked.data).toMatchObject({
    summary: activeAfter.summary,
    bookingState: activeAfter.bookingState,
  });
  for (const result of [before, after, resumed, checked])
    expect(JSON.stringify(result)).not.toContain("private-");
  expect(JSON.stringify(after)).not.toContain("private@example.com");
});
