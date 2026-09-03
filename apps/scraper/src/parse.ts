/**
 * HTML parsers for uae.voxcinemas.com. Pure functions (cheerio) so they can be unit-tested on fixtures.
 * The same logic was used interactively to capture the frozen snapshot in `out/vox-uae-raw.json`.
 */
import * as cheerio from "cheerio";

export type RawMovieCard = { slug: string; ho: string; title: string; rating: string; language: string };
export type RawSession = {
  cinema: string;
  cinemaId: string;
  sessionId: string;
  experience: string;
  time: string; // "9:00pm"
  date: string; // YYYYMMDD
  soldOut: boolean;
};
export type RawMeta = {
  name: string;
  duration: string; // ISO 8601 e.g. PT145M
  actors: string[];
  genre: string;
  description: string;
  inLanguage: string;
  contentRating: string;
  aside: Record<string, string>;
  yt: string;
  poster: string; // "P_HO00013356"
  hero: string;
  dates: string[]; // other selectable dates (YYYYMMDD)
  director: string;
};
export type RawFilm = RawMovieCard & { status: "now_showing" | "coming_soon" | "advance"; meta: Omit<RawMeta, "dates">; sessionCount: number };
export type RawCinema = {
  href: string;
  name: string;
  geo: [string, string] | null;
  paras: string[];
  kv: Record<string, string>;
  ids: string[];
  exps: string[];
};

const txt = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

export function parseMovieList(html: string): RawMovieCard[] {
  const $ = cheerio.load(html);
  const out = new Map<string, RawMovieCard>();
  $('a[href^="/movies/"]').each((_, a) => {
    const href = ($(a).attr("href") ?? "").split("#")[0]!;
    if (/whatson|comingsoon|advance/.test(href) || href === "/movies/") return;
    const card = $(a).closest("li, article, div");
    const img = card.find("img").first();
    const src = img.attr("src") ?? img.attr("data-src") ?? "";
    const ho = src.match(/HO\d{8}/)?.[0] ?? "";
    const prev = out.get(href);
    out.set(href, {
      slug: href.replace("/movies/", ""),
      ho: ho || prev?.ho || "",
      title: txt(card.find("h3").first().text()) || prev?.title || "",
      rating: txt(card.find(".classification").first().text()) || prev?.rating || "",
      language: txt(card.find(".language").first().text()).replace(/^Language:\s*/i, "") || prev?.language || "",
    });
  });
  return [...out.values()];
}

export function parseShowtimes(html: string, dateStr: string): RawSession[] {
  const $ = cheerio.load(html);
  const rows: RawSession[] = [];
  const container = $("#showtimes .dates").first().length ? $("#showtimes .dates").first() : $("#showtimes").first();
  if (!container.length) return rows;
  let cinema = "";
  container.children().each((_, el) => {
    const tag = el.tagName.toUpperCase();
    if (tag === "H3") {
      cinema = txt($(el).text());
      return;
    }
    if (tag === "OL" && $(el).hasClass("showtimes")) {
      $(el)
        .children("li")
        .each((_, li) => {
          const exp = txt($(li).children("strong").first().text());
          $(li)
            .find("li[data-id]")
            .each((_, s) => {
              const id = $(s).attr("data-id") ?? "";
              const [cinemaId, sessionId] = id.split("-");
              if (!cinemaId || !sessionId) return;
              const a = $(s).find("a").first();
              rows.push({
                cinema,
                cinemaId,
                sessionId,
                experience: exp,
                time: txt(a.text()),
                date: dateStr,
                soldOut: /sold/i.test(`${$(s).attr("class") ?? ""} ${a.attr("class") ?? ""}`),
              });
            });
        });
    }
  });
  return rows;
}

export function parseMovieMeta(html: string): RawMeta {
  const $ = cheerio.load(html);
  let ld: Record<string, unknown> = {};
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).text());
      if (j && j["@type"] === "Movie") ld = j;
    } catch {
      /* ignore */
    }
  });
  const aside: Record<string, string> = {};
  $("aside p").each((_, p) => {
    const st = $(p).find("strong").first();
    if (st.length) aside[txt(st.text()).replace(/:$/, "")] = txt($(p).text().replace(st.text(), ""));
  });
  const yt = html.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,})/)?.[1] ?? "";
  const dates = [
    ...new Set(
      $('#showtimes nav a[href*="d="]')
        .map((_, a) => $(a).attr("href")?.match(/d=(\d{8})/)?.[1] ?? "")
        .get()
        .filter(Boolean),
    ),
  ];
  const actor = (ld.actor as { name: string }[] | undefined) ?? [];
  const director = ld.director as { name: string } | { name: string }[] | undefined;
  return {
    name: (ld.name as string) ?? "",
    duration: (ld.duration as string) ?? "",
    actors: actor.map((a) => a.name),
    genre: (ld.genre as string) ?? "",
    description: (ld.description as string) ?? "",
    inLanguage: (ld.inLanguage as string) ?? "",
    contentRating: (ld.contentRating as string) ?? "",
    aside,
    yt,
    poster: html.match(/P_HO\d{8}/)?.[0] ?? "",
    hero: html.match(/B_HO\d{8}/)?.[0] ?? "",
    dates,
    director: Array.isArray(director) ? director.map((d) => d.name).join(", ") : (director?.name ?? ""),
  };
}

export function parseCinemaPage(href: string, html: string): RawCinema {
  const $ = cheerio.load(html);
  const h1 = $("h1").first();
  const paras: string[] = [];
  const kv: Record<string, string> = {};
  let el = h1.next();
  while (el.length && el.prop("tagName") === "P") {
    if (el.find("strong").length) {
      for (const part of (el.html() ?? "").split(/<br\s*\/?>/i)) {
        const $$ = cheerio.load(`<div>${part}</div>`);
        const st = $$("strong").first();
        if (st.length) {
          const label = txt(st.text()).replace(/:$/, "");
          $$("strong").remove();
          kv[label] = txt($$("div").text()).replace(/^:\s*/, "");
        }
      }
    } else paras.push(txt(el.text()));
    el = el.next();
  }
  const geo = html.match(/(?:maps\?q=|q=|@)(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) ?? html.match(/"latitude"\s*:\s*"?(-?\d+\.\d+)"?\s*,\s*"longitude"\s*:\s*"?(-?\d+\.\d+)/);
  const ids = [...new Set([...html.matchAll(/data-id="(\d{4})-\d+"/g)].map((m) => m[1]!))];
  const exps = [...new Set($("ol.showtimes > li > strong").map((_, e) => txt($(e).text())).get())];
  return {
    href,
    name: txt(h1.text()).replace(/^VOX Cinemas at\s*/i, ""),
    geo: geo ? [geo[1]!, geo[2]!] : null,
    paras: paras.filter((p) => p && p !== "SHOWTIMES MAP"),
    kv,
    ids,
    exps,
  };
}

/** Convert "9:05pm" + "20260905" to a local ISO string "2026-09-05T21:05:00". */
export function toLocalIso(date: string, time: string): string {
  const m = time.toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)/);
  if (!m) throw new Error(`bad time ${time}`);
  let h = Number(m[1]);
  const min = m[2];
  if (m[3] === "pm" && h !== 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${String(h).padStart(2, "0")}:${min}:00`;
}

/** ISO-8601 duration (PT145M / PT2H25M) or "145 min" → minutes. */
export function toMinutes(duration: string, fallback = ""): number {
  const iso = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (iso && (iso[1] || iso[2])) return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
  const m = fallback.match(/(\d+)\s*min/);
  return m ? Number(m[1]) : 0;
}

/** "30 July 2026" → "2026-07-30T00:00:00" */
export function parseReleaseDate(s: string): string | null {
  const d = new Date(`${s} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}
