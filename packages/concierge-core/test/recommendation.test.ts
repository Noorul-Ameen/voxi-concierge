import { describe, expect, it, vi } from "vitest";
import type { Film, Session } from "../src/services/catalog.js";
import { customerTools } from "../src/tools/customer.js";
import type { ToolCtx } from "../src/tools/types.js";

const film = (id: string, language: string): Film => ({
  hoCode: id,
  title: id,
  titleAlt: "",
  rating: "PG",
  ratingDescription: "",
  synopsis: "A fixture film.",
  synopsisAlt: "",
  runTime: 110,
  trailerUrl: "",
  genres: ["Drama"],
  cast: [],
  director: "",
  language,
  subtitles: "",
  posterUrl: "",
  heroUrl: "",
  websiteUrl: "",
  status: "now_showing",
  openingDate: null,
});
const show = (film: Film, time: string, cinemaId = "0013", date = "2026-09-10"): Session => ({
  key: `${cinemaId}-${film.hoCode}-${time}`,
  cinemaId,
  sessionId: `${film.hoCode}-${time}`,
  hoCode: film.hoCode,
  showtime: `${date}T${time}:00`,
  businessDate: date,
  screenName: "Screen 1",
  experience: "Standard",
  attributes: [],
  seatsAvailable: 30,
  totalSeats: 60,
  soldOut: false,
  allowTicketSales: true,
  bookingUrl: "",
  language: film.language,
  filmTitle: film.title,
});
const tamil = film("Tamil film", "Tamil");
const english = film("English film", "English");
function fixture() {
  const sessions = [
    show(tamil, "17:00"),
    show(tamil, "21:00"),
    show(english, "22:00"),
    show(english, "18:00", "0005"),
    show(tamil, "21:00", "0013", "2026-09-11"),
    { ...show(tamil, "11:00"), soldOut: true },
  ];
  const customer = vi.fn(async () => ({
    id: "cust_rahul",
    firstName: "Rahul",
    homeCinemaId: "0013",
    preferences: { languages: ["Tamil"], cinemas: ["0013"] },
  }));
  const ctx = {
    lang: "en",
    nowLocal: "2026-09-10T12:00:00",
    conversation: { id: "fixture", customerId: "cust_rahul", isLoggedIn: true },
    vista: {
      customer,
      customerHistory: async () => ({
        history: [
          {
            cinemaId: "0013",
            language: "Tamil",
            showtime: "2026-09-07T21:00:00",
            genres: [],
            experience: "Standard",
            seatPreference: "back",
          },
          {
            cinemaId: "0013",
            language: "Tamil",
            showtime: "2026-09-05T17:00:00",
            genres: [],
            experience: "Standard",
            seatPreference: "back",
          },
        ],
      }),
    },
    catalog: {
      films: async () => [tamil, english],
      cinemas: async () => [
        { id: "0013", name: "Burjuman" },
        { id: "0005", name: "Mirdif" },
      ],
      sessions: async (id: string) => sessions.filter((s) => s.cinemaId === id),
      resolveCinema: async () => ({ cinema: { id: "0005" }, score: 1 }),
    },
  } as unknown as ToolCtx;
  return { ctx, customer };
}
type Recommendation = { language: string; suggestedSession: { cinemaId: string; showtime: string } };
const movies = (result: Awaited<ReturnType<typeof customerTools.get_recommendations>>) =>
  result.data?.movies as Recommendation[];

describe("recommendation precedence and available results", () => {
  it("offers one nearest future alternative when the requested window is empty without changing cinema, language or date", async () => {
    const { ctx } = fixture();
    const result = await customerTools.get_recommendations(ctx, {
      kind: "movies",
      limit: 4,
      cinemaId: "0013",
      language: "Tamil",
      timeFrom: "18:30",
      timeTo: "20:00",
    });
    expect(movies(result)).toHaveLength(1);
    expect(movies(result)[0]).toMatchObject({
      language: "Tamil",
      isAlternative: true,
      suggestedSession: { cinemaId: "0013", showtime: "2026-09-10T21:00:00" },
    });
    expect(result.data).toMatchObject({
      isAlternative: true,
      alternativeReason: "outside_requested_time_window",
      requestedTimeFrom: "18:30",
      requestedTimeTo: "20:00",
      date: "2026-09-10",
    });
    expect(result.speech).toContain("nearest option");
  });
  it("uses usual cinema/language/weekday timing without an extra profile question", async () => {
    const { ctx } = fixture();
    const result = await customerTools.get_recommendations(ctx, { kind: "movies", limit: 1 });
    expect(movies(result)[0]).toMatchObject({
      language: "Tamil",
      suggestedSession: { cinemaId: "0013", showtime: "2026-09-10T21:00:00" },
    });
    expect(result.data?.askChildren).toBeUndefined();
    expect(result.ui?.items).toHaveLength(1);
  });
  it("honours film language and never silently falls back to the profile language", async () => {
    const { ctx } = fixture();
    expect(
      movies(
        await customerTools.get_recommendations(ctx, { kind: "movies", limit: 4, language: "English" }),
      ).every((m) => m.language === "English"),
    ).toBe(true);
    expect(
      movies(
        await customerTools.get_recommendations(ctx, { kind: "movies", limit: 4, language: "Japanese" }),
      ),
    ).toHaveLength(0);
  });
  it("respects explicit cinema and target time ahead of preferences", async () => {
    const { ctx } = fixture();
    expect(
      movies(
        await customerTools.get_recommendations(ctx, { kind: "movies", limit: 1, cinemaName: "Mirdif" }),
      )[0]?.suggestedSession.cinemaId,
    ).toBe("0005");
    expect(
      movies(await customerTools.get_recommendations(ctx, { kind: "movies", limit: 1, time: "22:00" }))[0]
        ?.language,
    ).toBe("English");
  });
  it("filters a time window and the requested date exactly", async () => {
    const { ctx } = fixture();
    const result = await customerTools.get_recommendations(ctx, {
      kind: "movies",
      limit: 8,
      timeFrom: "16:00",
      timeTo: "18:00",
    });
    expect(
      movies(result).every(
        (m) =>
          m.suggestedSession.showtime >= "2026-09-10T16:00:00" &&
          m.suggestedSession.showtime <= "2026-09-10T18:00:00",
      ),
    ).toBe(true);
    const tomorrow = await customerTools.get_recommendations(ctx, {
      kind: "movies",
      limit: 8,
      date: "tomorrow",
    });
    expect(movies(tomorrow).every((m) => m.suggestedSession.showtime.startsWith("2026-09-11"))).toBe(true);
  });
  it("does not use client-supplied customer identity", async () => {
    const { ctx, customer } = fixture();
    await customerTools.get_recommendations(ctx, {
      kind: "movies",
      limit: 1,
      customerId: "another-customer",
    });
    expect(customer).toHaveBeenCalledWith("cust_rahul");
    customer.mockClear();
    ctx.conversation.isLoggedIn = false;
    await customerTools.get_recommendations(ctx, { kind: "movies", limit: 1, customerId: "cust_rahul" });
    expect(customer).not.toHaveBeenCalled();
  });
});
