import { type Experience, normaliseExperience } from "@voxi/contracts";
import { CINEMA_ALIASES, bestMatch, nearest, similarity } from "@voxi/domain";
/**
 * Read layer over the Vista client for movies/cinemas/sessions with small TTL caches and fuzzy resolution.
 * Everything here is side-effect free and safe to run concurrently.
 */
import type { VistaClient } from "@voxi/vista-client";

export type Cinema = {
  id: string;
  name: string;
  nameAlt: string;
  address: string;
  city: string;
  lat: number | null;
  lng: number | null;
  parking: string;
  emirate: string;
  mall: string;
  shortCode: string;
  openingHours: { day: number; open: string; close: string }[];
  accessibility: string;
  directions: string;
  directionsAlt: string;
  bestParking: string;
  experiences: string[];
  websiteUrl: string;
  phone: string;
};
export type Film = {
  hoCode: string;
  title: string;
  titleAlt: string;
  rating: string;
  ratingDescription: string;
  synopsis: string;
  synopsisAlt: string;
  runTime: number;
  trailerUrl: string;
  genres: string[];
  cast: string[];
  director: string;
  language: string;
  subtitles: string;
  posterUrl: string;
  heroUrl: string;
  websiteUrl: string;
  status: "now_showing" | "coming_soon" | "advance";
  openingDate: string | null;
};
export type Session = {
  key: string;
  cinemaId: string;
  sessionId: string;
  hoCode: string;
  showtime: string; // local ISO
  businessDate: string;
  screenName: string;
  experience: Experience;
  attributes: string[];
  seatsAvailable: number;
  totalSeats: number;
  soldOut: boolean;
  allowTicketSales: boolean;
  bookingUrl: string;
  language: string;
  filmTitle: string;
};

class Ttl<T> {
  private v: { at: number; value: T } | null = null;
  private inflight: Promise<T> | null = null;
  constructor(
    private ttlMs: number,
    private load: () => Promise<T>,
  ) {}
  async get(): Promise<T> {
    if (this.v && Date.now() - this.v.at < this.ttlMs) return this.v.value;
    if (!this.inflight)
      this.inflight = this.load()
        .then((value) => {
          this.v = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    return this.inflight;
  }
  invalidate() {
    this.v = null;
  }
}

export class Catalog {
  private cinemasCache: Ttl<Cinema[]>;
  private filmsCache: Ttl<Film[]>;
  private sessionsByCinema = new Map<string, Ttl<Session[]>>();
  constructor(
    private vista: VistaClient,
    private opts: { cinemaTtlMs?: number; filmTtlMs?: number; sessionTtlMs?: number } = {},
  ) {
    this.cinemasCache = new Ttl(opts.cinemaTtlMs ?? 10 * 60_000, () => this.loadCinemas());
    this.filmsCache = new Ttl(opts.filmTtlMs ?? 5 * 60_000, () => this.loadFilms());
  }

  private async loadCinemas(): Promise<Cinema[]> {
    const { value } = await this.vista.cinemas("CurrencyCode eq 'AED'");
    return value.map((c) => ({
      id: c.ID,
      name: c.Name,
      nameAlt: c.NameAlt ?? "",
      address: c.Address1 ?? "",
      city: String(c.City ?? "")
        .split("|")[0]!
        .trim(),
      lat: c.Latitude ? Number(c.Latitude) : null,
      lng: c.Longitude ? Number(c.Longitude) : null,
      parking: c.ParkingInfo ?? "",
      emirate: c.Extensions?.Emirate ?? "",
      mall: c.Extensions?.MallName ?? c.Name,
      shortCode: c.Extensions?.ShortCode ?? "",
      openingHours: c.Extensions?.OpeningHours ?? [],
      accessibility: c.Extensions?.AccessibilityInfo ?? "",
      directions: c.Extensions?.InMallDirections ?? "",
      directionsAlt: c.Extensions?.InMallDirectionsAlt ?? "",
      bestParking: c.Extensions?.BestParking ?? c.ParkingInfo ?? "",
      experiences: c.Extensions?.Experiences ?? [],
      websiteUrl: c.Extensions?.WebsiteUrl ?? "",
      phone: c.PhoneNumber ?? "",
    }));
  }

  private async loadFilms(): Promise<Film[]> {
    const { value } = await this.vista.films(undefined, true);
    return value.map((f) => ({
      hoCode: f.ScheduledFilmId ?? f.ID,
      title: f.Title,
      titleAlt: f.TitleAlt ?? "",
      rating: f.Rating ?? "",
      ratingDescription: f.RatingDescription ?? "",
      synopsis: f.Synopsis ?? "",
      synopsisAlt: f.SynopsisAlt ?? "",
      runTime: Number(f.RunTime ?? 0),
      trailerUrl: f.TrailerUrl ?? "",
      genres: (f.Genres ?? []).map((g: { Name: string }) => g.Name),
      cast: (f.Cast ?? [])
        .filter((c: { PersonType: string }) => c.PersonType === "Actor")
        .map((c: { FirstName: string; LastName: string }) => `${c.FirstName} ${c.LastName}`.trim()),
      director: f.Director ?? "",
      language: f.Language ?? "",
      subtitles: f.Subtitles ?? "",
      posterUrl: f.PosterUrl ?? "",
      heroUrl: f.HeroUrl ?? "",
      websiteUrl: f.WebsiteUrl ?? "",
      status: f.Status ?? (f.IsScheduledAtCinema ? "now_showing" : "coming_soon"),
      openingDate: f.OpeningDate ?? null,
    }));
  }

  cinemas() {
    return this.cinemasCache.get();
  }
  films() {
    return this.filmsCache.get();
  }
  async film(hoCode: string) {
    return (await this.films()).find((f) => f.hoCode === hoCode) ?? null;
  }
  async cinema(id: string) {
    return (await this.cinemas()).find((c) => c.id === id) ?? null;
  }

  async sessions(cinemaId: string): Promise<Session[]> {
    let c = this.sessionsByCinema.get(cinemaId);
    if (!c) {
      c = new Ttl(this.opts.sessionTtlMs ?? 60_000, async () => {
        const { value } = await this.vista.sessions(`CinemaId eq '${cinemaId}'`, { orderby: "Showtime asc" });
        return value.map((s) => ({
          key: `${s.CinemaId}-${s.SessionId}`,
          cinemaId: s.CinemaId,
          sessionId: String(s.SessionId),
          hoCode: s.ScheduledFilmId,
          showtime: s.Showtime,
          businessDate: String(s.SessionBusinessDate ?? "").slice(0, 10),
          screenName: s.ScreenName,
          experience:
            (s.Experience as Experience) ??
            normaliseExperience(String(s.SessionAttributesNames?.[0] ?? "Standard")),
          attributes: s.SessionAttributesNames ?? [],
          seatsAvailable: Number(s.SeatsAvailable ?? 0),
          totalSeats: Number(s.TotalSeats ?? 0),
          soldOut: Number(s.SoldoutStatus ?? 0) === 2,
          allowTicketSales: s.AllowTicketSales !== false,
          bookingUrl: s.BookingUrl ?? "",
          language: s.Language ?? "",
          filmTitle: s.FilmTitle ?? "",
        }));
      });
      this.sessionsByCinema.set(cinemaId, c);
    }
    return c.get();
  }
  async session(cinemaId: string, sessionId: string) {
    return (await this.sessions(cinemaId)).find((s) => s.sessionId === String(sessionId)) ?? null;
  }
  async sessionByKey(key: string) {
    const [cinemaId, sessionId] = key.split("-");
    if (!cinemaId || !sessionId) return null;
    return this.session(cinemaId, sessionId);
  }
  invalidateSessions(cinemaId: string) {
    this.sessionsByCinema.get(cinemaId)?.invalidate();
  }

  /** Resolve a spoken cinema name/alias/mall to a cinema. */
  async resolveCinema(query: string): Promise<{ cinema: Cinema; score: number } | null> {
    const cinemas = await this.cinemas();
    const m = bestMatch(
      query,
      cinemas,
      (c) => [c.name, c.nameAlt, c.mall, c.shortCode, ...(CINEMA_ALIASES[c.id] ?? [])],
      0.5,
    );
    return m ? { cinema: m.item, score: m.score } : null;
  }

  /** Resolve a spoken film title (EN/AR, partial) → best few candidates. */
  async resolveFilms(query: string, limit = 3): Promise<{ film: Film; score: number }[]> {
    const films = await this.films();
    return films
      .map((f) => ({
        film: f,
        score: Math.max(
          similarity(query, f.title),
          similarity(query, f.titleAlt),
          ...f.cast.map((c) => similarity(query, c) * 0.9),
        ),
      }))
      .filter((x) => x.score >= 0.45)
      .sort((a, b) => b.score - a.score || (a.film.status === "now_showing" ? -1 : 1))
      .slice(0, limit);
  }

  async nearestCinemas(lat: number, lng: number, limit = 3, experience?: string) {
    const cinemas = (await this.cinemas()).filter((c) => !experience || c.experiences.includes(experience));
    return nearest(
      cinemas.map((c) => ({
        ...c,
        latitude: c.lat != null ? String(c.lat) : null,
        longitude: c.lng != null ? String(c.lng) : null,
      })),
      lat,
      lng,
      limit,
    );
  }
}
