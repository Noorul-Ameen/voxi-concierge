import { describe, expect, it } from "vitest";
import {
  capturedFilmClassification,
  capturedFilmRatings,
  readCapturedFilmSnapshot,
} from "../src/seed/film-ratings.js";

const film = {
  hoCode: "HO00013575",
  title: "Red Flag",
  slug: "red-flag-arabic",
  websiteUrl: "https://uae.voxcinemas.com/movies/red-flag-arabic",
  rating: "PG15",
};
const snapshot = (films: unknown[], capturedAt: unknown = "2026-09-13T19:25:13.655Z") => ({
  capturedAt,
  films,
});

describe("captured film classification sources", () => {
  it("reads the packaged capture and resolves Red Flag's captured PG15 classification", async () => {
    const rows = capturedFilmRatings(await readCapturedFilmSnapshot());
    expect(rows.find((row) => row.hoCode === film.hoCode)).toMatchObject({
      title: "Red Flag",
      rating: "PG15",
    });
  });

  it("normalizes only supported classification codes and derives matching descriptions", () => {
    expect(capturedFilmClassification(" pg 15 ")).toMatchObject({
      rating: "PG15",
      ratingDescription: expect.stringContaining("15"),
    });
    expect(capturedFilmClassification("18 tc")).toMatchObject({
      rating: "18TC",
      ratingDescription: expect.stringContaining("18+"),
    });
  });

  it.each([undefined, null, "", " ", "TBC", "15TC", "All ages", 15])(
    "skips absent or unsupported source rating %s",
    (rating) => {
      expect(capturedFilmClassification(rating)).toBeNull();
      expect(capturedFilmRatings(snapshot([{ ...film, rating }]))).toEqual([]);
    },
  );

  it.each([
    { hoCode: "wrong-id" },
    { title: " " },
    { slug: "" },
    { websiteUrl: "https://example.com/movies/red-flag-arabic" },
    { websiteUrl: "https://uae.voxcinemas.com/movies/another-film" },
  ])("rejects an incomplete or inconsistent captured identity %j", (change) => {
    expect(capturedFilmRatings(snapshot([{ ...film, ...change }]))).toEqual([]);
  });

  it("rejects ambiguous duplicate IDs and unverified capture timestamps", () => {
    expect(capturedFilmRatings(snapshot([film, { ...film, rating: "18TC" }]))).toEqual([]);
    expect(capturedFilmRatings(snapshot([film], "unknown"))).toEqual([]);
    expect(capturedFilmRatings({ films: [film] })).toEqual([]);
  });
});
