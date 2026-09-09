import { schema as S } from "@voxi/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quickTools } from "../src/tools/quick.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/conversation.js", () => ({ updateConversation: vi.fn() }));
vi.mock("../src/events.js", () => ({ appendEvent: vi.fn() }));
vi.mock("../src/tools/customer.js", () => ({ loadCustomer: vi.fn(async () => null) }));

const session = {
  key: "0002-123",
  cinemaId: "0002",
  sessionId: "123",
  hoCode: "film",
  filmTitle: "Film",
  showtime: "2026-09-10T20:00:00",
  experience: "Standard",
  soldOut: false,
  allowTicketSales: true,
};
const cinema = { id: "0002", name: "Mall of the Emirates" };
function order(overrides: Record<string, unknown> = {}) {
  return {
    UserSessionId: "old-hold",
    State: "seats_selected",
    CinemaId: "0002",
    ExpiryDateUtc: "2050-09-10T16:06:00Z",
    TotalValueCents: 5000,
    Sessions: [
      {
        SessionId: "123",
        FilmTitle: "Film",
        ShowingRealDateTimeOffset: "2026-09-10T20:00:00+04:00",
        SeatsAllocated: true,
        Tickets: [
          {
            Id: "1",
            TicketTypeCode: "ADULT",
            Description: "Adult",
            SeatRowId: "G",
            SeatNumber: "8",
            SeatData: "G8",
            PriceCents: 5000,
            FinalPriceCents: 5000,
          },
        ],
      },
    ],
    Concessions: [],
    ...overrides,
  };
}

function context(metadata: Record<string, unknown> = {}) {
  const ctx = {
    conversation: { id: "test-conversation", metadata },
    lang: "en",
    nowLocal: "2026-09-10T16:40:00",
    toolCallId: "call-one",
    correlationId: "correlation",
    cfg: { orderExpiryMinutes: 6 },
    events: {},
    catalog: {
      cinemas: vi.fn(async () => [cinema]),
      cinema: vi.fn(async () => cinema),
      sessionByKey: vi.fn(async () => session),
      sessions: vi.fn(async () => [session]),
      film: vi.fn(async () => ({
        hoCode: "film",
        title: "Film",
        rating: "PG",
        language: "English",
        genres: [],
      })),
      invalidateSessions: vi.fn(),
    },
    vista: {
      getOrder: vi.fn(async () => ({ Order: null as ReturnType<typeof order> | null })),
      ticketTypes: vi.fn(async () => ({ Tickets: [{ TicketTypeCode: "ADULT", PriceInCents: 5000 }] })),
      addTickets: vi.fn(async (request: any) => ({ Order: order({ UserSessionId: request.UserSessionId }) })),
      setSeats: vi.fn(),
      cancelOrder: vi.fn(),
      addConcessions: vi.fn(),
    },
  } as unknown as ToolCtx;
  const tx = {
    execute: vi.fn(),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === S.conversations ? [ctx.conversation] : []),
      }),
    }),
    insert: () => ({ values: vi.fn() }),
  };
  ctx.db = { transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as ToolCtx["db"];
  return ctx;
}

beforeEach(() => vi.clearAllMocks());

describe("booking decisions and holds", () => {
  it("asks quantity after a showtime click without holding a default ticket", async () => {
    const ctx = context();
    const result = await quickTools.quick_book(ctx, { sessionKey: session.key });
    expect(result.data).toMatchObject({ needs: "tickets", sessionKey: session.key });
    expect(result.ui).toMatchObject({ type: "quantity", meta: { sessionKey: session.key } });
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
    expect(ctx.conversation.metadata?.pendingBooking).toMatchObject({ sessionKey: session.key });
  });
  it("retains the selected showtime when the next response supplies quantity", async () => {
    const ctx = context({ pendingBooking: { sessionKey: session.key } });
    const result = await quickTools.quick_book(ctx, { tickets: 2 });
    expect(ctx.vista.addTickets).toHaveBeenCalledWith(
      expect.objectContaining({ SessionId: "123", TicketTypes: [{ TicketTypeCode: "ADULT", Qty: 2 }] }),
    );
    expect(result.ui?.type).toBe("order");
    expect(result.ui?.actions?.map((action) => action.value)).toContain("fnb:suggest");
  });
  it("offers a later show instead of booking a selected show that already started", async () => {
    const ctx = context();
    vi.mocked(ctx.catalog.sessionByKey).mockResolvedValue({
      ...session,
      showtime: "2026-09-10T16:35:00",
    } as any);
    const result = await quickTools.quick_book(ctx, { sessionKey: session.key, tickets: 2 });
    expect(result.data).toMatchObject({ reason: "show_started", needs: "alternative" });
    expect(result.ui?.type).toBe("showtimes");
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  });
  it("does not recreate an expired hold on resume or without explicit recovery consent", async () => {
    const ctx = context({ activeOrder: "old-hold", activeSessionKey: session.key });
    vi.mocked(ctx.vista.getOrder).mockResolvedValue({ Order: order({ State: "expired" }) } as any);
    expect((await quickTools.resume_order(ctx, {})).data).toMatchObject({ active: false, expired: true });
    expect((await quickTools.recover_order(ctx, {})).data).toMatchObject({ needs: "recovery_confirmation" });
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  });
  it("rejects recovery of a show that has started even with explicit consent", async () => {
    const ctx = context({ activeOrder: "old-hold", activeSessionKey: session.key });
    vi.mocked(ctx.vista.getOrder).mockResolvedValue({ Order: order({ State: "expired" }) } as any);
    vi.mocked(ctx.catalog.sessionByKey).mockResolvedValue({
      ...session,
      showtime: "2026-09-10T16:35:00",
    } as any);
    const result = await quickTools.recover_order(ctx, { confirmed: true });
    expect(result.data?.reason).toBe("show_started");
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  });
  it("keeps snacks in the unpaid ticket order for one checkout", async () => {
    const ctx = context({ activeOrder: "old-hold", activeSessionKey: session.key });
    vi.mocked(ctx.vista.getOrder).mockResolvedValue({ Order: order() } as any);
    vi.mocked(ctx.vista.addConcessions).mockResolvedValue({
      Order: order({
        TotalValueCents: 7000,
        Concessions: [
          { ItemId: "popcorn", Quantity: 1, Description: "Popcorn", PriceCents: 2000, FinalPriceCents: 2000 },
        ],
      }),
    } as any);
    const result = await quickTools.order_fnb(ctx, { items: [{ itemId: "popcorn", quantity: 1 }] });
    expect(ctx.vista.addConcessions).toHaveBeenCalledWith(
      expect.objectContaining({ UserSessionId: "old-hold", Replace: true }),
    );
    expect(result.data).toMatchObject({ combinedCheckout: true, order: { totalCents: 7000 } });
    expect(ctx.vista.cancelOrder).not.toHaveBeenCalled();
  });
});
