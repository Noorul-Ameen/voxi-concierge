import { describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/services/catalog.js";
import { movieTools } from "../src/tools/movies.js";
import { orderingTools } from "../src/tools/ordering.js";
import type { ToolCtx } from "../src/tools/types.js";

const context = (lang: "en" | "ar" = "en") =>
  ({
    lang,
    db: { select: () => ({ from: async () => [] }) },
  }) as unknown as ToolCtx;

describe("classification admission evidence", () => {
  it("rechecks provider classification despite a warm discovery cache", async () => {
    const films = vi
      .fn()
      .mockResolvedValueOnce({ value: [{ ID: "film", Title: "Film", Rating: "PG" }] })
      .mockResolvedValueOnce({ value: [{ ID: "film", Title: "Film", Rating: "18TC" }] });
    const catalog = new Catalog({ films } as never);
    expect((await catalog.film("film"))?.rating).toBe("PG");
    expect((await catalog.film("film"))?.rating).toBe("PG");
    expect((await catalog.film("film", true))?.rating).toBe("18TC");
    expect(films).toHaveBeenCalledTimes(2);
  });
  it.each(["18TC", "15TC", "TBC", "", "15+", "18+", "21+"])(
    "hides legacy child ticket types for %s",
    async (rating) => {
      const ctx = {
        ...context(),
        conversation: {},
        nowLocal: "2026-09-14T12:00:00",
        catalog: {
          sessionByKey: vi.fn(async () => ({
            key: "cinema-show",
            cinemaId: "cinema",
            sessionId: "show",
            hoCode: "film",
            filmTitle: "Film",
            experience: "Standard",
            showtime: "2026-09-14T19:00:00",
          })),
          film: vi.fn(async () => ({ rating })),
        },
        vista: {
          ticketTypes: vi.fn(async () => ({
            ResponseCode: 0,
            Tickets: [
              { TicketTypeCode: "ADULT", Description: "Adult", PriceInCents: 5000 },
              { TicketTypeCode: "CHILD", Description: "Child", PriceInCents: 4000, IsChildOnlyTicket: true },
            ],
          })),
        },
      } as unknown as ToolCtx;
      const result = await orderingTools.get_ticket_types(ctx, { sessionKey: "cinema-show" });
      expect(result.data?.ticketTypes).toEqual([expect.objectContaining({ code: "ADULT" })]);
      expect(ctx.catalog.film).toHaveBeenCalledWith("film", true);
      if (/^(15|18|21)\+$/.test(rating)) {
        expect(result.speech).toContain(`ages ${Number.parseInt(rating, 10)} and over`);
        expect(result.speech).not.toContain("cannot be confirmed");
        if (rating !== "15+") expect(result.speech).toContain("adults only");
      } else {
        expect(result.speech).not.toContain("adults only");
        expect(result.speech).toContain("cannot be confirmed");
      }
    },
  );
  it.each([
    ["18TC", 7, false, 18],
    ["18TC", 17, false, 18],
    ["18TC", 18, true, 18],
    ["15+", 14, false, 15],
    ["15+", 15, true, 15],
    ["18+", 17, false, 18],
    ["21+", 20, false, 21],
    ["G", 7, true, 0],
    ["PG", 7, true, 0],
    ["15TC", 7, null, null],
    ["TBC", 7, null, null],
    ["unknown", 7, null, null],
  ] as const)(
    "checks %s at age %i without treating missing rules as all-ages",
    async (rating, childAge, allowed, minimumAge) => {
      const result = await movieTools.get_age_rules(context(), { rating, childAge });
      expect(result.data).toMatchObject({ allowed, minimumAge, classificationKnown: minimumAge != null });
      if (allowed === null) expect(result.speech).toContain("cannot confirm admission");
      else expect(result.speech).toMatch(allowed ? /^Yes/ : /^No/);
    },
  );
  it("keeps provisional denial in Arabic and guidance age boundaries explicit", async () => {
    const ar = await movieTools.get_age_rules(context("ar"), { rating: "18TC", childAge: 7 });
    expect(ar.data).toMatchObject({ allowed: false, provisional: true });
    expect(ar.speech).toMatch(/^لا/);
    for (const [rating, age] of [
      ["PG 13", 13],
      ["PG15", 15],
    ] as const) {
      const child = await movieTools.get_age_rules(context(), { rating, childAge: age });
      const older = await movieTools.get_age_rules(context(), { rating, childAge: age + 1 });
      expect(child.speech).toContain(`accompanied by someone aged ${age} or older`);
      expect(older.speech).not.toContain("accompanied");
    }
  });
});
