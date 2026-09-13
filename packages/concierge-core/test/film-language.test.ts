import { GetFilmInput, SearchFilmsInput, SearchSessionsInput } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import type { Film, Session } from "../src/services/catalog.js";
import { movieTools } from "../src/tools/movies.js";
import type { ToolCtx } from "../src/tools/types.js";

function film(hoCode: string, language: string): Film {
  return {
    hoCode,
    title: "Shared title",
    titleAlt: "عنوان",
    language,
    rating: "PG",
    ratingDescription: "",
    synopsis: "A fixture film.",
    synopsisAlt: "",
    runTime: 110,
    trailerUrl: "",
    genres: [],
    cast: [],
    director: "",
    subtitles: "",
    posterUrl: "",
    heroUrl: "",
    websiteUrl: "",
    status: "now_showing",
    openingDate: null,
  };
}
const english = film("english-print", "English");
const tamil = film("tamil-print", "Tamil");
const films = [english, tamil];
function fixture(): ToolCtx {
  const sessions: Session[] = films.map((f) => ({
    key: `cinema-${f.hoCode}`,
    sessionId: f.hoCode,
    cinemaId: "cinema",
    hoCode: f.hoCode,
    filmTitle: f.title,
    showtime: "2030-06-04T19:00:00",
    businessDate: "2030-06-04",
    screenName: "Screen 1",
    experience: "Standard",
    attributes: [],
    seatsAvailable: 30,
    totalSeats: 60,
    soldOut: false,
    allowTicketSales: true,
    bookingUrl: "",
    language: f.language,
  }));
  return {
    lang: "ar",
    nowLocal: "2030-06-04T12:00:00",
    conversation: {},
    catalog: {
      films: async () => films,
      film: async (id: string) => films.find((f) => f.hoCode === id) ?? null,
      resolveFilms: async () => films.map((f) => ({ film: f, score: 1 })),
      cinemas: async () => [{ id: "cinema", name: "Fixture cinema", nameAlt: "سينما" }],
      sessions: async () => sessions,
    },
  } as unknown as ToolCtx;
}

describe("film language is independent of Arabic conversation language", () => {
  it.each([
    { language: "English" },
    { filmLanguage: "English" },
    { filmLanguage: "English", language: "ar" },
  ])("searches the same English prints for %j", async (filter) => {
    const result = await movieTools.search_films(fixture(), SearchFilmsInput.parse(filter));
    expect(result.data?.films).toEqual([
      expect.objectContaining({ hoCode: english.hoCode, language: "English" }),
    ]);
    expect(result.speech).toContain("تصنيف");
  });

  it.each([
    { language: "English" },
    { filmLanguage: "English" },
    { filmLanguage: "English", language: "ar" },
  ])("returns English showtimes even in Arabic UI for %j", async (filter) => {
    const result = await movieTools.search_sessions(
      fixture(),
      SearchSessionsInput.parse({
        ...filter,
        hoCode: english.hoCode,
        cinemaId: "cinema",
        date: "today",
        suggestAlternatives: false,
      }),
    );
    expect(result.data?.sessions).toEqual([
      expect.objectContaining({ sessionKey: `cinema-${english.hoCode}`, filmLanguage: "English" }),
    ]);
  });

  it("does not silently satisfy a mismatched explicit film language with an English print", async () => {
    const result = await movieTools.search_sessions(
      fixture(),
      SearchSessionsInput.parse({
        hoCode: english.hoCode,
        filmLanguage: "Arabic",
        cinemaId: "cinema",
        date: "today",
        suggestAlternatives: false,
      }),
    );
    expect(result.data?.sessions).toEqual([]);
  });

  it("filters untitled discovery using the canonical field before its legacy alias", async () => {
    const result = await movieTools.search_sessions(
      fixture(),
      SearchSessionsInput.parse({
        filmLanguage: "Tamil",
        language: "English",
        cinemaId: "cinema",
        date: "today",
        suggestAlternatives: false,
      }),
    );
    expect(result.data?.sessions).toEqual([
      expect.objectContaining({ sessionKey: `cinema-${tamil.hoCode}`, filmLanguage: "Tamil" }),
    ]);
  });

  it("keeps existing get_film Arabic UI hints from filtering the known English movie", async () => {
    const input = GetFilmInput.parse({ hoCode: english.hoCode, language: "ar" });
    expect(input).toEqual({ hoCode: english.hoCode });
    const result = await movieTools.get_film(fixture(), input);
    expect(result.data?.film).toMatchObject({ hoCode: english.hoCode, language: "English" });
  });

  it("resolves an explicitly requested same-title language version in get_film", async () => {
    const result = await movieTools.get_film(
      fixture(),
      GetFilmInput.parse({
        hoCode: english.hoCode,
        filmLanguage: "Tamil",
        language: "ar",
      }),
    );
    expect(result.data?.film).toMatchObject({ hoCode: tamil.hoCode, language: "Tamil" });
  });

  it("does not invent a get_film version in an unavailable explicit language", async () => {
    const result = await movieTools.get_film(
      fixture(),
      GetFilmInput.parse({
        title: english.title,
        filmLanguage: "Arabic",
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
