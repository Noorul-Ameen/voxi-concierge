import type { Experience } from "@voxi/contracts";
import {
  asEmirate,
  normaliseFilmLanguage,
  resolveSpokenDate,
  similarity,
  spokenDateRangeEnd,
} from "@voxi/domain";
import type { Film, Session } from "../services/catalog.js";
import { fmtDate, fmtDateTime, fmtMinutes, fmtTime, joinList, t } from "../services/format.js";
import { type ToolCtx, type ToolHandlers, err, ok } from "./types.js";

const RATING_ORDER = ["G", "PG", "PG13", "PG15", "15+", "18+", "18TC", "21+"];
const ratingMinAge: Record<string, number> = {
  G: 0,
  PG: 0,
  PG13: 0,
  PG15: 0,
  "15+": 15,
  "18+": 18,
  "18TC": 18,
  "21+": 21,
};

/** Arabic count phrases: dual, 3–10 plural, 11+ singular accusative ("و20 موعداً آخر"). */
function arMore(n: number, kind: "film" | "showtime") {
  const f =
    kind === "film"
      ? ["فيلم آخر", "فيلمان آخران", "أفلام أخرى", "فيلماً آخر"]
      : ["موعد آخر", "موعدان آخران", "مواعيد أخرى", "موعداً آخر"];
  if (n === 1) return f[0];
  if (n === 2) return f[1];
  if (n <= 10) return `${n} ${f[2]}`;
  return `${n} ${f[3]}`;
}

export function filmCard(f: Film, lang: "en" | "ar") {
  return {
    hoCode: f.hoCode,
    title: lang === "ar" && f.titleAlt ? f.titleAlt : f.title,
    titleEn: f.title,
    rating: f.rating,
    genres: f.genres,
    runTime: f.runTime,
    language: f.language,
    subtitles: f.subtitles,
    posterUrl: f.posterUrl,
    heroUrl: f.heroUrl,
    trailerUrl: f.trailerUrl,
    youtubeId: f.trailerUrl.match(/v=([A-Za-z0-9_-]{6,})/)?.[1] ?? "",
    status: f.status,
    synopsis: (lang === "ar" && f.synopsisAlt ? f.synopsisAlt : f.synopsis).slice(0, 280),
    websiteUrl: f.websiteUrl,
    cast: f.cast.slice(0, 4),
  };
}

export function sessionCard(s: Session, lang: "en" | "ar", todayIso: string, cinemaName?: string) {
  return {
    sessionKey: s.key,
    cinemaId: s.cinemaId,
    cinemaName,
    sessionId: s.sessionId,
    hoCode: s.hoCode,
    filmTitle: s.filmTitle,
    showtime: s.showtime,
    date: s.showtime.slice(0, 10),
    dateLabel: fmtDate(s.showtime, lang, todayIso),
    time: fmtTime(s.showtime, lang),
    experience: s.experience,
    attributes: s.attributes,
    seatsAvailable: s.seatsAvailable,
    soldOut: s.soldOut,
    bookingUrl: s.bookingUrl,
    language: s.language,
    screenName: s.screenName,
  };
}

function matchFilm(
  f: Film,
  q: { query?: string; genre?: string; language?: string; rating?: string; maxAge?: number; status: string },
): number {
  if (q.status !== "any" && f.status !== q.status) return -1;
  if (q.genre && !f.genres.some((g) => similarity(g, q.genre!) > 0.7)) return -1;
  if (q.language && similarity(f.language, normaliseFilmLanguage(q.language) ?? q.language) < 0.7) return -1;
  if (q.rating && f.rating.toUpperCase() !== q.rating.toUpperCase()) return -1;
  if (q.maxAge != null && (ratingMinAge[f.rating] ?? 0) > q.maxAge) return -1;
  if (!q.query) return 1;
  return Math.max(
    similarity(q.query, f.title),
    similarity(q.query, f.titleAlt),
    ...f.cast.map((c) => similarity(q.query!, c) * 0.9),
    ...f.genres.map((g) => similarity(q.query!, g) * 0.8),
  );
}

async function sessionsFor(ctx: ToolCtx, cinemaIds: string[]) {
  const all = await Promise.all(cinemaIds.map((id) => ctx.catalog.sessions(id)));
  return all.flat();
}

export const movieTools: Pick<
  ToolHandlers,
  "search_films" | "get_film" | "search_sessions" | "how_to_book" | "get_age_rules"
> = {
  async search_films(ctx, input) {
    const films = await ctx.catalog.films();
    let scored = films
      .map((f) => ({ f, s: matchFilm(f, input) }))
      .filter((x) => x.s >= (input.query ? 0.45 : 0));
    if (input.cinemaId) {
      const at = new Set(
        (await ctx.catalog.sessions(input.cinemaId))
          .filter((s) => s.showtime >= ctx.nowLocal)
          .map((s) => s.hoCode),
      );
      scored = scored.filter((x) => at.has(x.f.hoCode));
    }
    scored.sort((a, b) => b.s - a.s || a.f.title.localeCompare(b.f.title));
    const top = scored.slice(0, input.limit).map((x) => x.f);
    if (!top.length) {
      // relaxed alternatives: drop filters one at a time
      const alt = films
        .filter((f) => f.status === (input.status === "any" ? f.status : input.status))
        .slice(0, 5);
      return ok(
        { films: [], alternatives: alt.map((f) => filmCard(f, ctx.lang)) },
        t(
          ctx.lang,
          "I couldn't find a movie matching that. Here are some other titles showing now.",
          "لم أجد فيلماً يطابق ذلك. إليك بعض الأفلام المعروضة حالياً.",
        ),
        {
          type: "movie",
          title: t(ctx.lang, "You might like", "قد يعجبك"),
          items: alt.map((f) => filmCard(f, ctx.lang)),
        },
      );
    }
    const names = joinList(
      top.slice(0, 4).map((f) => (ctx.lang === "ar" && f.titleAlt ? f.titleAlt : f.title)),
      ctx.lang,
    );
    const speech =
      top.length === 1
        ? t(
            ctx.lang,
            `${top[0]!.title} — rated ${top[0]!.rating}, ${fmtMinutes(top[0]!.runTime)}, ${top[0]!.language}. Want showtimes?`,
            `${top[0]!.title} — تصنيف ${top[0]!.rating}، ${fmtMinutes(top[0]!.runTime, "ar")}. هل تريد مواعيد العرض؟`,
          )
        : t(
            ctx.lang,
            `I found ${top.length} movies: ${names}. Which one interests you?`,
            `وجدت ${top.length} أفلام: ${names}. أيها يهمك؟`,
          );
    return ok(
      { films: top.map((f) => filmCard(f, ctx.lang)) },
      speech,
      {
        type: "movie",
        title: t(ctx.lang, "Movies", "الأفلام"),
        items: top.map((f) => filmCard(f, ctx.lang)),
        actions: top.slice(0, 4).map((f) => ({ label: f.title, value: `showtimes:${f.hoCode}` })),
      },
      { name: "movie_info", status: "completed" },
    );
  },

  async get_film(ctx, input) {
    let film = input.hoCode ? await ctx.catalog.film(input.hoCode) : null;
    if (!film && input.title) film = (await ctx.catalog.resolveFilms(input.title, 1))[0]?.film ?? null;
    if (!film)
      return err(
        "NOT_FOUND",
        t(ctx.lang, "I couldn't find that movie.", "لم أتمكن من العثور على هذا الفيلم."),
      );
    const card = filmCard(film, ctx.lang);
    const speech = t(
      ctx.lang,
      `${film.title} is ${film.genres.join("/") || "a movie"} rated ${film.rating}, running ${fmtMinutes(film.runTime)} in ${film.language}${film.subtitles ? ` with ${film.subtitles} subtitles` : ""}. ${film.cast.length ? `Starring ${joinList(film.cast.slice(0, 3))}. ` : ""}${film.synopsis.slice(0, 200)}`,
      `${film.title} فيلم ${film.genres.join("/")} بتصنيف ${film.rating}، مدته ${fmtMinutes(film.runTime, "ar")} باللغة ${film.language}. ${film.cast.length ? `بطولة ${joinList(film.cast.slice(0, 3), "ar")}.` : ""}`,
    );
    return ok(
      {
        film: {
          ...card,
          synopsis: film.synopsis,
          cast: film.cast,
          director: film.director,
          ratingDescription: film.ratingDescription,
          openingDate: film.openingDate,
        },
      },
      speech,
      {
        type: "movie",
        items: [card],
        actions: [
          {
            label: t(ctx.lang, "Showtimes", "مواعيد العرض"),
            value: `showtimes:${film.hoCode}`,
            style: "primary",
          },
          ...(card.youtubeId
            ? [{ label: t(ctx.lang, "Trailer", "الإعلان"), value: `trailer:${card.youtubeId}` }]
            : []),
        ],
      },
    );
  },

  async search_sessions(ctx, input) {
    // ---- resolve film ----
    let film: Film | null = input.hoCode ? await ctx.catalog.film(input.hoCode) : null;
    if (!film && input.title) {
      const cands = await ctx.catalog.resolveFilms(input.title, 3);
      if (cands.length > 1 && cands[0]!.score < 0.8 && cands[1]!.score > 0.6) {
        return ok(
          { ambiguous: cands.map((c) => filmCard(c.film, ctx.lang)) },
          t(
            ctx.lang,
            `Did you mean ${joinList(cands.map((c) => c.film.title))}?`,
            `هل تقصد ${joinList(
              cands.map((c) => c.film.title),
              "ar",
            )}؟`,
          ),
          {
            type: "movie",
            items: cands.map((c) => filmCard(c.film, ctx.lang)),
            actions: cands.map((c) => ({ label: c.film.title, value: `showtimes:${c.film.hoCode}` })),
          },
        );
      }
      film = cands[0]?.film ?? null;
      if (!film)
        return err(
          "NOT_FOUND",
          t(ctx.lang, `I couldn't find a movie called ${input.title}.`, `لم أجد فيلماً باسم ${input.title}.`),
        );
    }
    // The same title can exist as several language versions (e.g. Tamil + Malayalam prints). Unless the guest
    // asked for a language, show every version's showtimes and let the cards carry the language tag.
    const wantLangForVersions = normaliseFilmLanguage(input.language);
    const versionCodes = new Set<string>();
    if (film) {
      const sameTitle = (await ctx.catalog.films()).filter(
        (f) =>
          f.title.toLowerCase() === film!.title.toLowerCase() &&
          (!wantLangForVersions || similarity(f.language, wantLangForVersions) >= 0.7),
      );
      for (const f of sameTitle.length ? sameTitle : [film]) versionCodes.add(f.hoCode);
      if (wantLangForVersions && sameTitle.length) film = sameTitle[0]!;
    }
    // ---- resolve cinema(s) ----
    let cinemaIds: string[] = [];
    let cinemaLabel = "";
    let nearby: { id: string; distanceKm: number }[] = [];
    const emirate = asEmirate(input.cinemaName);
    if (input.cinemaId) cinemaIds = [input.cinemaId];
    else if (emirate) {
      // "in Dubai" is an emirate, not a cinema — search every VOX cinema there
      cinemaIds = (await ctx.catalog.cinemas()).filter((c) => c.emirate === emirate).map((c) => c.id);
      cinemaLabel = emirate;
    } else if (input.cinemaName) {
      const r = await ctx.catalog.resolveCinema(input.cinemaName);
      if (!r)
        return err(
          "NOT_FOUND",
          t(
            ctx.lang,
            `I don't recognise a VOX cinema called ${input.cinemaName}. Which mall is it in?`,
            `لا أعرف سينما فوكس باسم ${input.cinemaName}. في أي مول؟`,
          ),
        );
      cinemaIds = [r.cinema.id];
      cinemaLabel = ctx.lang === "ar" ? r.cinema.nameAlt || r.cinema.name : r.cinema.name;
    } else if (input.nearMe && !ctx.conversation.geo) {
      return err(
        "LOCATION_REQUIRED",
        t(
          ctx.lang,
          "I don't have your location yet — tap the location button in the chat to share it or pick an area, or tell me which area you're in.",
          "ليس لدي موقعك بعد — اضغط زر الموقع في المحادثة لمشاركته أو اختيار منطقة، أو أخبرني بالمنطقة التي أنت فيها.",
        ),
      );
    } else if (ctx.conversation.geo) {
      // the guest shared or picked a location in the widget — nearest cinemas win over booking history
      nearby = await ctx.catalog.nearestCinemas(ctx.conversation.geo.lat, ctx.conversation.geo.lng, 3);
      cinemaIds = nearby.map((c) => c.id);
      cinemaLabel = ctx.conversation.geo.label
        ? t(ctx.lang, `near ${ctx.conversation.geo.label}`, `قرب ${ctx.conversation.geo.label}`)
        : t(ctx.lang, "near you", "بالقرب منك");
    } else if (film) cinemaIds = (await ctx.catalog.cinemas()).map((c) => c.id);
    else
      return err(
        "VALIDATION",
        t(
          ctx.lang,
          "Which movie or which cinema would you like showtimes for?",
          "لأي فيلم أو أي سينما تريد مواعيد العرض؟",
        ),
      );

    const cinemas = await ctx.catalog.cinemas();
    const cname = (id: string) => {
      const c = cinemas.find((x) => x.id === id);
      return c ? (ctx.lang === "ar" ? c.nameAlt || c.name : c.name) : id;
    };
    const date = resolveSpokenDate(input.date, ctx.nowLocal);
    const dateTo = input.dateTo
      ? resolveSpokenDate(input.dateTo, ctx.nowLocal)
      : spokenDateRangeEnd(input.date, date);
    // Language is a film attribute: once the guest has named the film, don't second-guess it per session
    // (dubbed/subtitled sessions may carry a different language tag than the film itself).
    const wantLang = film ? undefined : normaliseFilmLanguage(input.language);
    const base = (await sessionsFor(ctx, cinemaIds)).filter(
      (s) => (!film || versionCodes.has(s.hoCode)) && s.showtime >= ctx.nowLocal,
    );
    const apply = (rows: Session[], f: { date?: boolean; time?: boolean; exp?: boolean; lang?: boolean }) =>
      rows.filter((s) => {
        const d = s.showtime.slice(0, 10);
        const hm = s.showtime.slice(11, 16);
        if (f.date !== false && (d < date || d > dateTo)) return false;
        if (f.time !== false && input.timeFrom && hm < input.timeFrom) return false;
        if (f.time !== false && input.timeTo && hm > input.timeTo) return false;
        if (f.exp !== false && input.experience && s.experience !== input.experience) return false;
        if (f.lang !== false && wantLang && similarity(s.language, wantLang) < 0.7) return false;
        return true;
      });
    let rows = apply(base, {});
    let relaxed: string | null = null;
    if (!rows.length && input.suggestAlternatives) {
      // Relax ONE constraint at a time (never several at once, so "Arabic tomorrow at Deira" can't turn into
      // "Hindi today"). A named language or film is what the guest wants — look at other cinemas (nearest
      // first) before other days, and only fall back to other languages as a last resort.
      const allCinemaIds = cinemas.map((c) => c.id);
      const otherCinemaRows = async () => {
        if (cinemaIds.length >= allCinemaIds.length) return [] as Session[];
        const all = (await sessionsFor(ctx, allCinemaIds)).filter(
          (s) =>
            (!film || versionCodes.has(s.hoCode)) &&
            s.showtime >= ctx.nowLocal &&
            !cinemaIds.includes(s.cinemaId),
        );
        let r = apply(all, {});
        if (!r.length && (input.timeFrom || input.timeTo)) r = apply(all, { time: false });
        if (r.length && ctx.conversation.geo) {
          const near = await ctx.catalog.nearestCinemas(
            ctx.conversation.geo.lat,
            ctx.conversation.geo.lng,
            22,
          );
          const dist = new Map(near.map((c) => [c.id, c.distanceKm]));
          const closest = [...new Set(r.map((x) => x.cinemaId))]
            .sort((a, b) => (dist.get(a) ?? 99) - (dist.get(b) ?? 99))
            .slice(0, 3);
          r = r.filter((x) => closest.includes(x.cinemaId));
          nearby = near.filter((c) => closest.includes(c.id));
        }
        return r;
      };
      const single = (flag: string) => apply(base, { [flag]: false });
      const steps: (() => Promise<[Session[], string]>)[] = [
        async () => [single("time"), t(ctx.lang, "at other times", "في أوقات أخرى")],
        async () => [single("exp"), t(ctx.lang, "in other experiences", "في تجارب أخرى")],
        ...((wantLang || film) && !input.cinemaId && !emirate
          ? [
              async (): Promise<[Session[], string]> => [
                await otherCinemaRows(),
                t(ctx.lang, "at other cinemas", "في سينمات أخرى"),
              ],
            ]
          : []),
        async () => [single("date"), t(ctx.lang, "on other days", "في أيام أخرى")],
        ...(film || wantLang
          ? [
              async (): Promise<[Session[], string]> => [
                await otherCinemaRows(),
                t(ctx.lang, "at other cinemas", "في سينمات أخرى"),
              ],
            ]
          : []),
        async () => [single("lang"), t(ctx.lang, "in other languages", "بلغات أخرى")],
      ];
      for (const step of steps) {
        const [r, label] = await step();
        if (r.length) {
          rows = r;
          relaxed = label;
          break;
        }
      }
    }
    const rank = new Map(nearby.map((c) => [c.id, c.distanceKm]));
    rows = rows
      .sort(
        (a, b) =>
          (nearby.length ? (rank.get(a.cinemaId) ?? 99) - (rank.get(b.cinemaId) ?? 99) : 0) ||
          a.showtime.localeCompare(b.showtime),
      )
      .slice(0, input.limit);
    if (!rows.length) {
      return ok(
        { sessions: [] },
        t(
          ctx.lang,
          `There are no showtimes${film ? ` for ${film.title}` : ""}${cinemaLabel ? ` at ${cinemaLabel}` : ""} ${fmtDate(date, "en", ctx.nowLocal)}. Would you like another day or cinema?`,
          `لا توجد عروض${film ? ` لـ ${film.title}` : ""}${cinemaLabel ? ` في ${cinemaLabel}` : ""} ${fmtDate(date, "ar", ctx.nowLocal)}. هل تريد يوماً أو سينما أخرى؟`,
        ),
        undefined,
        { name: "movie_info", status: "completed" },
      );
    }
    const filmsById = new Map((await ctx.catalog.films()).map((f) => [f.hoCode, f] as const));
    const items = rows.map((s) => {
      const f = filmsById.get(s.hoCode);
      const c = cinemas.find((x) => x.id === s.cinemaId);
      return {
        ...sessionCard(s, ctx.lang, ctx.nowLocal, cname(s.cinemaId)),
        posterUrl: f?.posterUrl,
        rating: f?.rating,
        filmLanguage: f?.language,
        distanceKm: nearby.find((n) => n.id === s.cinemaId)?.distanceKm,
        mapUrl:
          c?.lat && c?.lng ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}` : undefined,
      };
    });
    // ---- spoken summary: at most 3 slots, grouped the way a human would say it; the cards carry the rest
    const ar = ctx.lang === "ar";
    const dayOf = (i: (typeof items)[number]) => i.dateLabel;
    const slot = (i: (typeof items)[number], withExp: boolean) =>
      `${i.time}${withExp ? ` ${i.experience}` : ""}`;
    let spoken: string;
    let remaining = 0;
    if (film && nearby.length) {
      // location-based: "Spider-Man near Deira — Burjuman (2 km) tomorrow 12:30 pm and 3:30 pm KIDS; Wafi Mall (4.7 km) 12:15 pm"
      const byCinema = new Map<string, typeof items>();
      for (const it of items)
        byCinema.set(it.cinemaName ?? "", [...(byCinema.get(it.cinemaName ?? "") ?? []), it]);
      const multiExp = new Set(items.map((i) => i.experience)).size > 1;
      const parts: string[] = [];
      let used = 0;
      for (const [cn, its] of byCinema) {
        if (used >= 3) break;
        const take = its.slice(0, Math.min(2, 3 - used));
        used += take.length;
        parts.push(
          `${cn}${its[0]?.distanceKm != null ? ` (${its[0].distanceKm} ${ar ? "كم" : "km"})` : ""} ${take[0]!.dateLabel} ${joinList(
            take.map((i) => slot(i, multiExp)),
            ctx.lang,
          )}`,
        );
      }
      remaining = items.length - used;
      spoken = `${film.title} ${cinemaLabel} — ${parts.join(ar ? "؛ " : "; ")}`;
    } else if (film) {
      // one film: "DC at City Centre Deira — tomorrow 5:15 pm and 8:40 pm, Sunday 3:00 pm"
      const byDay = new Map<string, typeof items>();
      for (const it of items) byDay.set(dayOf(it), [...(byDay.get(dayOf(it)) ?? []), it]);
      const cinemasUsed = [...new Set(items.map((i) => i.cinemaName))];
      const multiCinema = cinemasUsed.length > 1;
      const multiExp = new Set(items.map((i) => i.experience)).size > 1;
      const parts: string[] = [];
      let used = 0;
      for (const [day, its] of byDay) {
        if (used >= 3) break;
        // late-night prints (before 6 am) are rarely what a guest means — mention daytime/evening slots first
        const ordered = [...its].sort(
          (a, b) => Number(a.showtime.slice(11, 13) < "06") - Number(b.showtime.slice(11, 13) < "06"),
        );
        const take = ordered.slice(0, 3 - used);
        used += take.length;
        parts.push(
          `${day} ${joinList(
            take.map(
              (i) =>
                `${slot(i, multiExp)}${multiCinema ? ` ${ar ? "في" : "at"} ${i.cinemaName}${i.distanceKm != null ? ` (${i.distanceKm} ${ar ? "كم" : "km"})` : ""}` : ""}`,
            ),
            ctx.lang,
          )}`,
        );
      }
      remaining = items.length - used;
      spoken = `${film.title}${!multiCinema ? ` ${ar ? "في" : "at"} ${cinemasUsed[0]}${items[0]?.distanceKm != null ? ` (${items[0].distanceKm} ${ar ? "كم" : "km"})` : ""}` : nearby.length ? ` ${cinemaLabel}` : ""} — ${parts.join(ar ? "؛ " : "; ")}`;
    } else {
      // many films (cinema/time query): "Tomorrow at City Centre Deira after 8 pm: Immortal 10:50 pm, Insidious 8:00 pm GOLD, …"
      // per film, lead with a daytime/evening slot; late-night prints (before 6 am) come last — and films whose
      // only slots are late-night go to the end of the spoken list
      const byFilm = new Map<string, typeof items>();
      for (const it of items) byFilm.set(it.filmTitle, [...(byFilm.get(it.filmTitle) ?? []), it]);
      const lateNight = (i: (typeof items)[number]) => i.showtime.slice(11, 13) < "06";
      for (const [k, its] of byFilm)
        byFilm.set(
          k,
          [...its].sort((a, b) => Number(lateNight(a)) - Number(lateNight(b))),
        );
      const orderedFilms = [...byFilm.entries()].sort(
        (a, b) => Number(lateNight(a[1][0]!)) - Number(lateNight(b[1][0]!)),
      );
      byFilm.clear();
      for (const [k, v] of orderedFilms) byFilm.set(k, v);
      const cinemasUsed = [...new Set(items.map((i) => i.cinemaName))];
      const top = [...byFilm.entries()].slice(0, 3);
      const parts = top.map(
        ([title, its]) =>
          `${title} ${slot(its[0]!, false)}${its[0]!.dateLabel !== items[0]!.dateLabel ? ` ${its[0]!.dateLabel}` : ""}${
            cinemasUsed.length > 1
              ? ` ${ar ? "في" : "at"} ${its[0]!.cinemaName}${its[0]!.distanceKm != null ? ` (${its[0]!.distanceKm} ${ar ? "كم" : "km"})` : ""}`
              : ""
          }`,
      );
      remaining = byFilm.size - top.length;
      spoken = `${items[0]!.dateLabel}${cinemasUsed.length === 1 ? ` ${ar ? "في" : "at"} ${cinemasUsed[0]}` : ""}${input.timeFrom ? ` ${ar ? "بعد" : "after"} ${fmtTime(`2000-01-01T${input.timeFrom}:00`, ctx.lang)}` : ""}: ${joinList(parts, ctx.lang)}`;
      if (remaining > 0)
        spoken += ar
          ? `، و${arMore(remaining, "film")} على الشاشة`
          : `, and ${remaining} more film${remaining > 1 ? "s" : ""} on screen`;
      remaining = 0;
    }
    if (remaining > 0)
      spoken += ar ? ` — و${arMore(remaining, "showtime")} على الشاشة` : ` — and ${remaining} more on screen`;
    const asked = [
      wantLang ? t(ctx.lang, `${wantLang} films`, `أفلام ${wantLang}`) : film ? film.title : "",
      cinemaLabel ? t(ctx.lang, `at ${cinemaLabel}`, `في ${cinemaLabel}`) : "",
      input.date ? fmtDate(date, ctx.lang, ctx.nowLocal) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const speech = `${relaxed ? t(ctx.lang, `No ${asked || "exact match"}, but I found options ${relaxed}. `, `لا يوجد ${asked || "تطابق دقيق"}، لكن هناك خيارات ${relaxed}. `) : ""}${spoken}. ${t(ctx.lang, "Shall I book one of these?", "هل أحجز أحد هذه المواعيد؟")}`;
    return ok(
      { film: film ? filmCard(film, ctx.lang) : undefined, sessions: items, relaxed },
      speech,
      {
        type: "showtimes",
        title: film ? film.title : t(ctx.lang, "Showtimes", "مواعيد العرض"),
        items,
        meta: { film: film ? filmCard(film, ctx.lang) : undefined, groupBy: film ? "cinema" : "film" },
      },
      { name: "movie_info", status: "completed" },
    );
  },

  async how_to_book(ctx, input) {
    const base = ctx.cfg.voxWebBaseUrl;
    let url = `${base}/movies/whatson`;
    let label = t(ctx.lang, "Open What's On", "افتح قائمة الأفلام");
    if (input.sessionKey) {
      url = `${base}/booking/${input.sessionKey}`;
      label = t(ctx.lang, "Book this session", "احجز هذا العرض");
    } else if (input.hoCode) {
      const film = await ctx.catalog.film(input.hoCode);
      if (film?.websiteUrl) {
        url = `${film.websiteUrl}#showtimes`;
        label = t(ctx.lang, `Book ${film.title}`, `احجز ${film.title}`);
      }
    } else if (input.cinemaId) {
      const c = await ctx.catalog.cinema(input.cinemaId);
      if (c?.websiteUrl) url = c.websiteUrl;
    }
    const speech = t(
      ctx.lang,
      "You can book right here with me — just tell me the movie, cinema and time and I'll pick seats and take payment. Or I can open the booking page on the VOX website or app; you'll choose seats, add food, apply offers and pay by card, Apple Pay or VOX credit. Tickets arrive by email with a QR code.",
      "يمكنك الحجز معي مباشرة — أخبرني بالفيلم والسينما والوقت وسأختار المقاعد وأكمل الدفع. أو أفتح لك صفحة الحجز على موقع فوكس أو التطبيق لاختيار المقاعد وإضافة الطعام والدفع. تصل التذاكر بالبريد الإلكتروني مع رمز QR.",
    );
    return ok({ url, label, canBookInChat: true }, speech, {
      type: "movie",
      title: t(ctx.lang, "Booking", "الحجز"),
      items: [],
      actions: [
        { label: t(ctx.lang, "Book with me", "احجز معي"), value: "book:start", style: "primary" },
        { label, value: `link:${url}` },
      ],
    });
  },

  async get_age_rules(ctx, input) {
    const rows = await ctx.db.select().from((await import("@voxi/db")).schema.kbDocuments);
    const doc = rows.find((r) => r.id === "age-restrictions-generated");
    const rules = RATING_ORDER.map((r) => ({ rating: r, minAge: ratingMinAge[r] ?? 0 }));
    const expRule: Record<string, string> = {
      GOLD: "GOLD is 18+ except at Mall of the Emirates, City Centre Mirdif and Yas Mall where children aged 8+ may attend with an adult.",
      THEATRE: "THEATRE is for guests 18 and over.",
      KIDS: "KIDS screens are for children with their families; booster seats are available.",
      "4DX":
        "4DX requires a minimum height of 100 cm and is not recommended for pregnant guests or those with heart or back conditions.",
      Private: "The person booking a Private cinema must be 21 or over.",
    };
    let verdict: string | undefined;
    if (input.childAge != null && input.rating) {
      const min = ratingMinAge[input.rating.toUpperCase()] ?? 0;
      const allowed = input.childAge >= min;
      const pg = /^PG(13|15)$/i.test(input.rating);
      verdict = allowed
        ? pg
          ? t(
              ctx.lang,
              `Yes — ${input.rating} allows a ${input.childAge}-year-old, but they must be accompanied by someone older than ${input.rating.replace(/\D/g, "")}. The content may not be suitable for younger viewers, so it's the parent's call.`,
              `نعم — تصنيف ${input.rating} يسمح لطفل بعمر ${input.childAge} بشرط مرافقة شخص أكبر. المحتوى قد لا يناسب الصغار، والقرار للوالدين.`,
            )
          : t(
              ctx.lang,
              `Yes, a ${input.childAge}-year-old can watch a ${input.rating} movie.`,
              `نعم، يمكن لطفل بعمر ${input.childAge} مشاهدة فيلم بتصنيف ${input.rating}.`,
            )
        : t(
            ctx.lang,
            `No — ${input.rating} means no one under ${min} is admitted, even with a parent. Staff may ask for ID.`,
            `لا — تصنيف ${input.rating} يمنع دخول من هم دون ${min} سنة حتى مع الوالدين. قد يُطلب إثبات العمر.`,
          );
    }
    const expText = input.experience && expRule[input.experience] ? expRule[input.experience] : undefined;
    const speech =
      verdict ??
      expText ??
      t(
        ctx.lang,
        "Ratings in the UAE range from G and PG (all ages) through PG13 and PG15 (accompanied) to 15+, 18+ and 21+ where no one under that age is admitted, even with parents. Tell me the movie and your child's age and I'll check.",
        "تتراوح التصنيفات في الإمارات من G وPG لجميع الأعمار، إلى PG13 وPG15 بمرافقة، ثم +15 و+18 و+21 حيث لا يُسمح لمن هم دون هذا العمر حتى مع الوالدين. أخبرني بالفيلم وعمر طفلك لأتحقق.",
      );
    return ok(
      { rules, experienceRules: expRule, experienceRule: expText, verdict, source: doc?.sourceUrl },
      speech,
      undefined,
      { name: "age_restrictions", status: "completed" },
    );
  },
};

export const experienceLabel = (e: Experience, lang: "en" | "ar") =>
  lang === "ar"
    ? ((
        {
          Standard: "ستاندرد",
          MAX: "ماكس",
          GOLD: "غولد",
          KIDS: "كيدز",
          "4DX": "4DX",
          THEATRE: "ثياتر",
          IMAX: "آيماكس",
          Premier: "بريمير",
          Premium: "بريميوم",
          Couch: "كاوتش",
          Outdoor: "أوت دور",
          Private: "سينما خاصة",
          Other: "أخرى",
        } as Record<string, string>
      )[e] ?? e)
    : e;
export { fmtDateTime };
