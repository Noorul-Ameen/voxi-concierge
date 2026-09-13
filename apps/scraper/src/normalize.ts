/**
 * Raw website capture → Vista-shaped seed dataset (deterministic).
 * Output files are consumed by packages/db/src/seed.
 */
import { normaliseExperience } from "@voxi/contracts";
import type { RawCinema, RawFilm } from "./parse.js";
import { parseReleaseDate, toLocalIso, toMinutes } from "./parse.js";

export type RawCapture = {
  films: RawFilm[];
  sessions: [
    ho: string,
    cinemaId: string,
    sessionId: string,
    experience: string,
    date: string,
    time: string,
    soldOut: number,
  ][];
  cinemaNames: Record<string, string>;
  cinemas: RawCinema[];
};

export type SeedCinema = {
  id: string;
  name: string;
  nameAlt: string;
  slug: string;
  shortCode: string;
  mallName: string;
  emirate: string;
  city: string;
  address1: string;
  latitude: string;
  longitude: string;
  parkingInfo: string;
  cinemaLocation: string;
  description: string;
  experiences: string[];
  websiteUrl: string;
};
export type SeedFilm = {
  hoCode: string;
  title: string;
  titleAlt: string;
  rating: string;
  synopsis: string;
  openingDate: string | null;
  runTime: number;
  trailerUrl: string;
  genreNames: string[];
  cast: string[];
  director: string;
  language: string;
  subtitles: string;
  posterUrl: string;
  heroUrl: string;
  slug: string;
  websiteUrl: string;
  status: "now_showing" | "coming_soon" | "advance";
};
export type SeedSession = {
  cinemaId: string;
  sessionId: string;
  hoCode: string;
  showtime: string; // local ISO
  date: string; // YYYY-MM-DD business date (as listed on the website)
  experience: string; // canonical
  experienceLabel: string; // as on website
  soldOut: boolean;
  bookingUrl: string;
};
export type SeedDataset = {
  capturedAt: string;
  cinemas: SeedCinema[];
  films: SeedFilm[];
  sessions: SeedSession[];
  genres: string[];
  experiences: string[];
};

const SITE = "https://uae.voxcinemas.com";
const ASSETS = "https://assets.voxcinemas.com";

/** Arabic cinema names (official VOX naming where known; otherwise transliteration). */
const CINEMA_AR: Record<string, string> = {
  "0001": "سيتي سنتر ديرة",
  "0002": "مول الإمارات",
  "0004": "سيتي سنتر عجمان",
  "0005": "سيتي سنتر مردف",
  "0006": "سيتي سنتر الفجيرة",
  "0007": "ميركاتو",
  "0009": "الحمرا مول - رأس الخيمة",
  "0012": "ياس مول - أبوظبي",
  "0013": "برجمان",
  "0014": "أبراج الاتحاد (نيشن تاورز) - أبوظبي",
  "0015": "ميغابلكس - جراند حياة",
  "0017": "سيتي سنتر الشندغة",
  "0035": "سيتي سنتر الشارقة",
  "0036": "أبوظبي مول",
  "0039": "الجيمي مول",
  "0045": "كمبينسكي - مول الإمارات",
  "0046": "الغاليريا - جزيرة المارية",
  "0049": "نخيل مول - نخلة جميرا",
  "0055": "سيتي سنتر الزاهية",
  "0057": "وافي مول",
  "0104": "ريم مول - أبوظبي",
  "0105": "دبي فستيفال سيتي مول",
  "0110": "سيتي سنتر معيصم",
};

const SHORT_CODES: Record<string, string> = {
  "0001": "DCC",
  "0002": "MOE",
  "0004": "AJM",
  "0005": "MCC",
  "0006": "FUJ",
  "0007": "MER",
  "0009": "HAM",
  "0012": "YAS",
  "0013": "BJM",
  "0014": "NTA",
  "0015": "MGX",
  "0017": "SHN",
  "0035": "SCC",
  "0036": "ADM",
  "0039": "JIM",
  "0045": "KMP",
  "0046": "GAL",
  "0049": "PJM",
  "0055": "ZAH",
  "0057": "WAF",
  "0104": "REM",
  "0105": "DFC",
  "0110": "CCM",
};

/** Fallback coordinates for cinema pages that do not embed a map link. */
const GEO_FALLBACK: Record<string, [string, string]> = {
  "0045": ["25.1168", "55.1992"], // Kempinski, Mall of the Emirates (hotel wing)
  "0009": ["25.6869", "55.7828"], // Al Hamra Mall, RAK
  "0104": ["24.4938", "54.4058"], // Reem Mall
  "0057": ["25.2287", "55.3195"], // Wafi Mall
  "0046": ["24.5015", "54.3898"], // The Galleria Al Maryah Island
  "0015": ["25.2245", "55.3223"], // Grand Hyatt Dubai
  "0002": ["25.1181", "55.2004"],
  "0105": ["25.2222", "55.3520"], // Dubai Festival City Mall
};

/**
 * Curated fields for cinema pages the site renders without address/map data (or with another
 * cinema's data). Applied after the page values so a re-capture never regresses them.
 */
const CINEMA_OVERRIDES: Record<
  string,
  Partial<
    Pick<SeedCinema, "address1" | "latitude" | "longitude" | "parkingInfo" | "cinemaLocation" | "description">
  >
> = {
  "0055": {
    address1: "Sheikh Mohammed Bin Zayed Rd, Al Zahia, Sharjah",
    latitude: "25.3113",
    longitude: "55.4809",
    parkingInfo: "Free mall parking with 4,000+ spaces",
    cinemaLocation: "Level 1",
    description:
      "VOX Cinemas City Centre Al Zahia is located in City Centre Al Zahia (Sharjah), offering Couch, GOLD, KIDS, MAX, Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0001": {
    address1: "Baniyas Rd, Port Saeed, Deira, Dubai",
    latitude: "25.2521",
    longitude: "55.3311",
    parkingInfo:
      "Mall parking (Al Maktoum Rd and Baniyas Rd entrances); Deira City Centre Metro station is a 3-minute walk",
    cinemaLocation: "Level 2",
    description:
      "VOX Cinemas City Centre Deira is located in City Centre Deira (Dubai), offering GOLD, MAX, Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0006": {
    address1: "Sheikh Khalifa Bin Zayed Rd, Fujairah",
    latitude: "25.1213",
    longitude: "56.3363",
    parkingInfo: "Free mall parking",
    cinemaLocation: "Level 1",
    description:
      "VOX Cinemas City Centre Fujairah is located in City Centre Fujairah (Fujairah), offering MAX, Premium, Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0005": {
    address1: "Sheikh Mohammed Bin Zayed Rd, Mirdif, Dubai",
    latitude: "25.2166",
    longitude: "55.4075",
    parkingInfo:
      "Mall parking (P1\u2013P5), cinema entrance closest to the Sheikh Mohammed Bin Zayed Rd side",
    cinemaLocation: "Level 2, next to Magic Planet",
    description:
      "VOX Cinemas City Centre Mirdif is located in City Centre Mirdif (Dubai), offering IMAX, KIDS, MAX, Standard, THEATRE screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0035": {
    address1: "Al Wahda St, Industrial Area 1, Sharjah",
    latitude: "25.3251",
    longitude: "55.3999",
    parkingInfo: "Free mall parking",
    cinemaLocation: "Level 1",
    description:
      "VOX Cinemas City Centre Sharjah is located in City Centre Sharjah (Sharjah), offering MAX, Premium, Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0017": {
    address1: "Al Khaleej St, Al Shindagha, Dubai",
    latitude: "25.2694",
    longitude: "55.2926",
    parkingInfo: "Mall parking; Al Ghubaiba Metro station is nearby",
    cinemaLocation: "Level 2",
    description:
      "VOX Cinemas City Centre Shindagha is located in City Centre Shindagha (Dubai), offering Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
  "0110": {
    address1: "Sheikh Mohammed Bin Zayed Rd, Me'aisem, Dubai Production City, Dubai",
    latitude: "25.0364",
    longitude: "55.1868",
    parkingInfo: "Free mall parking",
    cinemaLocation: "Level 1",
    description:
      "VOX Cinemas City Centre Me'aisem is located in City Centre Me'aisem (Dubai Production City, Dubai), offering Premier and Standard screens with online booking, food & drinks ordering and SHARE rewards.",
  },
};

function emirateOf(name: string): string {
  const n = name.toLowerCase();
  if (/abu dhabi|yas|reem|nation towers|maryah|galleria al/.test(n)) return "Abu Dhabi";
  if (/sharjah|zahia|jimi/.test(n)) return "Sharjah";
  if (/ajman/.test(n)) return "Ajman";
  if (/fujairah/.test(n)) return "Fujairah";
  if (/hamra|ras al/.test(n)) return "Ras Al Khaimah";
  return "Dubai";
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanCinemaName(n: string) {
  return n
    .replace(/\s*-\s*(Abu Dhabi|Ras Al Khaimah)$/i, "")
    .replace(/\s*-?\s*Mall of Emirates$/i, " - Mall of the Emirates")
    .replace(/\(Cineplex Grand Hyatt\)/i, "(Grand Hyatt)")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalize(raw: RawCapture, capturedAt = new Date().toISOString()): SeedDataset {
  // ---- cinemas ----
  const bySlug = new Map(raw.cinemas.map((c) => [c.href.replace("/cinemas/", ""), c]));
  const findPage = (name: string): RawCinema | undefined => {
    const key = slugify(name.replace(/\(.*?\)/g, "").replace(/-/g, " "));
    const exact = bySlug.get(key);
    if (exact) return exact;
    // Fuzzy match only when exactly one page shares the prefix (never "city-centre-*" → Ajman).
    const hits = [...bySlug].filter(([slug]) => slug.startsWith(key) || key.startsWith(slug));
    return hits.length === 1 ? hits[0]![1] : undefined;
  };
  const expByCinema = new Map<string, Set<string>>();
  for (const s of raw.sessions) {
    const set = expByCinema.get(s[1]) ?? new Set<string>();
    set.add(normaliseExperience(s[3]));
    expByCinema.set(s[1], set);
  }
  const cinemas: SeedCinema[] = Object.entries(raw.cinemaNames)
    .map(([id, rawName]) => {
      const page = findPage(rawName);
      const name = cleanCinemaName(rawName);
      const emirate = emirateOf(rawName);
      const mall = name.replace(/^VOX Cinemas\s*/i, "");
      return {
        id,
        name,
        nameAlt: CINEMA_AR[id] ?? name,
        slug: page?.href.replace("/cinemas/", "") ?? slugify(name),
        shortCode: SHORT_CODES[id] ?? name.replace(/[^A-Z]/g, "").slice(0, 3),
        mallName: mall,
        emirate,
        city: emirate,
        address1: page?.kv.Address || `${mall}, ${emirate}, UAE`,
        latitude: page?.geo?.[0] ?? GEO_FALLBACK[id]?.[0] ?? "",
        longitude: page?.geo?.[1] ?? GEO_FALLBACK[id]?.[1] ?? "",
        parkingInfo: page?.kv["Nearest Parking"] ?? "",
        cinemaLocation: page?.kv["Cinema Location"] ?? "",
        description: page?.paras.join("\n\n") ?? "",
        experiences: [...(expByCinema.get(id) ?? [])].sort(),
        websiteUrl: `${SITE}/cinemas/${page?.href.replace("/cinemas/", "") ?? slugify(name)}`,
        ...CINEMA_OVERRIDES[id],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---- films ----
  let synthetic = 0;
  const films: SeedFilm[] = raw.films.map((f) => {
    const ho = f.ho || f.meta.poster.replace("P_", "") || `HOCS${String(++synthetic).padStart(6, "0")}`;
    const aside = f.meta.aside;
    const genreNames = [
      ...new Set(
        [f.meta.genre, aside.Genre]
          .filter(Boolean)
          .flatMap((g) => g!.split(/,|\//).map((x) => x.trim()))
          .filter(Boolean),
      ),
    ];
    const cast = f.meta.actors.length
      ? f.meta.actors
      : (aside.Starring ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
    const hasRealHo = !ho.startsWith("HOCS");
    return {
      hoCode: ho,
      title: f.meta.name || f.title,
      titleAlt: "",
      rating: (f.meta.contentRating || f.rating || "").replace(/\s+/g, ""),
      synopsis: f.meta.description,
      openingDate: aside["Release Date"] ? parseReleaseDate(aside["Release Date"]) : null,
      runTime: toMinutes(f.meta.duration, aside["Running Time"] ?? ""),
      trailerUrl: f.meta.yt ? `https://www.youtube.com/watch?v=${f.meta.yt}` : "",
      genreNames,
      cast: [...new Set(cast)],
      director: f.meta.director,
      language: (f.meta.inLanguage || aside.Language || f.language || "").trim(),
      subtitles: aside["Subtitle(s)"] ?? "",
      posterUrl: hasRealHo ? `${ASSETS}/posters/P_${ho}.jpg` : "",
      heroUrl: hasRealHo ? `${ASSETS}/heroes/B_${ho}.jpg` : "",
      slug: f.slug,
      websiteUrl: `${SITE}/movies/${f.slug}`,
      status: f.status,
    };
  });

  // ---- sessions ----
  const seen = new Set<string>();
  const sessions: SeedSession[] = [];
  for (const [ho, cinemaId, sessionId, expLabel, date, time, soldOut] of raw.sessions) {
    const key = `${cinemaId}-${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const film = films.find((f) => f.hoCode === ho);
    if (!film || !/\d/.test(time)) continue; // skip rows the site rendered without a time (sold out / placeholder)
    // The website lists sessions under their business date; a 12:30am show listed on D actually starts on D+1.
    let showtime = toLocalIso(date, time);
    if (Number(showtime.slice(11, 13)) < 6) {
      const next = new Date(`${showtime}Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      showtime = next.toISOString().slice(0, 19);
    }
    sessions.push({
      cinemaId,
      sessionId,
      hoCode: ho,
      showtime,
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      experience: normaliseExperience(expLabel),
      experienceLabel: expLabel.replace(/\s+i\s+This session.*$/i, "").trim(),
      soldOut: soldOut === 1,
      bookingUrl: `${SITE}/booking/${cinemaId}-${sessionId}`,
    });
  }
  sessions.sort((a, b) => a.showtime.localeCompare(b.showtime) || a.cinemaId.localeCompare(b.cinemaId));

  const genres = [...new Set(films.flatMap((f) => f.genreNames))].sort();
  const experiences = [...new Set(sessions.map((s) => s.experience))].sort();
  return { capturedAt, cinemas, films, sessions, genres, experiences };
}
