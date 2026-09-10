import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CinemaPage, filterDemoFilms, type DemoFilm } from "./CinemaPage";

const films: DemoFilm[] = [
  { hoCode: "one", title: "The Journey", titleAlt: "الرحلة", language: "Arabic", status: "now_showing" },
  { hoCode: "two", title: "A New Day", language: "Tamil", status: "now_showing" },
  { hoCode: "three", title: "The Journey Returns", language: "Arabic", status: "coming_soon" },
  { hoCode: "four", title: "Tomorrow", language: "English", status: "advance" },
];

describe("native cinema page", () => {
  it("filters actual catalogue status, language and titles together", () => {
    expect(filterDemoFilms(films, "now_showing", "Arabic", " journey ").map((film) => film.hoCode)).toEqual(["one"]);
    expect(filterDemoFilms(films, "coming_soon", "", "").map((film) => film.hoCode)).toEqual(["three", "four"]);
    expect(filterDemoFilms(films, "now_showing", "", "الرحلة").map((film) => film.hoCode)).toEqual(["one"]);
    expect(filterDemoFilms(films, "coming_soon", "Tamil", "")).toEqual([]);
  });

  it("keeps older public catalogue responses usable without inventing language or coming-soon films", () => {
    const legacy = [{ hoCode: "legacy", title: "Movie", posterUrl: "poster.png", rating: "PG" }];
    expect(filterDemoFilms(legacy, "now_showing", "", "")).toEqual(legacy);
    expect(filterDemoFilms(legacy, "now_showing", "Arabic", "")).toEqual([]);
    expect(filterDemoFilms(legacy, "coming_soon", "", "")).toEqual([]);
  });

  it("renders the reference page sections and independent account entry without legacy login fields", () => {
    const html = renderToStaticMarkup(<CinemaPage lang="en" onLanguage={() => undefined} onAccount={() => undefined}><div id="shared-widget" /></CinemaPage>);
    for (const id of ["booking", "movies", "experiences", "food", "offers", "cinemas", "shared-widget"]) expect(html).toContain(`id="${id}"`);
    for (const text of ["ODYSSEY", "What&#x27;s On", "COMING SOON", "FIND TIMES AND BOOK", "Sign in", "THEATRE", "4DX", "SHARE"]) expect(html).toContain(text);
    expect(html).not.toContain("PIN");
    expect(html).not.toContain("member ID");
    expect(html).not.toContain("Virtual Assistant");
    expect(html).not.toContain("ready when you arrive");
    expect(html).not.toContain("have them ready");
  });

  it("localizes the native page and shows only the supplied account name", () => {
    const html = renderToStaticMarkup(<CinemaPage lang="ar" onLanguage={() => undefined} onAccount={() => undefined} customerName="Sara">{null}</CinemaPage>);
    expect(html).toContain("Sara");
    expect(html).toContain("اختر السينما");
    expect(html).toContain("اعرض المواعيد واحجز");
    expect(html).toContain("قريباً");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("password");
  });
});
