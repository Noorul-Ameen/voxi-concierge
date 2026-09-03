import { createHash } from "node:crypto";
/**
 * Seed the database: real VOX UAE reference data (from the scraper snapshot) + deterministic dummy
 * commerce/customer data. Idempotent — re-running upserts reference data and recreates demo bookings.
 *
 *   pnpm db:seed                       # shift the snapshot so its first day == today (whole weeks, keeps weekdays)
 *   SEED_SHIFT=none pnpm db:seed       # keep original dates
 *   SEED_KB_DIR=../agent/kb pnpm db:seed
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import * as s from "../schema/index.js";
import { generateSeatState, pickAdjacentSeats, seatKey } from "../seats.js";
import {
  AGE_RULES,
  CINEMA_EXTRAS,
  CONCESSIONS,
  DEFAULT_EXTRA,
  EXPERIENCE_AGE_RULES,
  EXPERIENCE_PRICING,
  OFFERS,
  ticketTypesFor,
} from "./catalog.js";
import { LAYOUTS, layoutForExperience } from "./layouts.js";
import { type BookingScenario, PERSONAS } from "./personas.js";
import { EXPERIENCE_CODE, EXPERIENCE_NAME_AR, addDaysIso, addMinutesIso, nowLocalIso, prng } from "./util.js";

type Dataset = {
  capturedAt: string;
  cinemas: {
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
  }[];
  films: {
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
  }[];
  sessions: {
    cinemaId: string;
    sessionId: string;
    hoCode: string;
    showtime: string;
    date: string;
    experience: string;
    experienceLabel: string;
    soldOut: boolean;
    bookingUrl: string;
  }[];
  genres: string[];
  experiences: string[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKET = process.env.SEED_MARKET ?? "uae";
const TZ = process.env.DEFAULT_TIMEZONE ?? "Asia/Dubai";

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const { db, close } = createDb(undefined, { max: 4 });
  // Data lives under src/seed/data (not copied to dist by tsc); resolve from either location.
  const candidates = [
    path.join(here, `data/vox-${MARKET}.json`),
    path.resolve(here, `../../src/seed/data/vox-${MARKET}.json`),
  ];
  const dataPath = candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
  const data: Dataset = JSON.parse(await readFile(dataPath, "utf8"));
  const nowLocal = nowLocalIso(TZ);

  // ---- date shift (keep weekday alignment: shift by whole weeks) ----
  const firstDay = data.sessions.map((x) => x.date).sort()[0]!;
  let shiftDays = 0;
  if ((process.env.SEED_SHIFT ?? "weeks") !== "none") {
    const diff = Math.round(
      (new Date(`${nowLocal.slice(0, 10)}T00:00:00Z`).getTime() -
        new Date(`${firstDay}T00:00:00Z`).getTime()) /
        86400000,
    );
    shiftDays = Math.round(diff / 7) * 7;
  }
  log(
    `dataset captured ${data.capturedAt}; first day ${firstDay}; now ${nowLocal}; shifting by ${shiftDays} days`,
  );
  const shift = (iso: string) => (shiftDays ? addDaysIso(iso, shiftDays) : iso);

  // ---- genres ----
  const genreIds = new Map<string, string>();
  data.genres.forEach((g, i) => genreIds.set(g, String(i + 1).padStart(10, "0")));
  await db
    .insert(s.filmGenres)
    .values([...genreIds].map(([name, id]) => ({ id, name, nameTranslations: [] })))
    .onConflictDoUpdate({ target: s.filmGenres.id, set: { name: sql`excluded.name` } });

  // ---- session attributes ----
  const ATTRS = [
    { id: "0000000006", description: "2D", shortName: "2D" },
    { id: "0000000007", description: "3D", shortName: "3D", altDescription: "ثلاثي الأبعاد" },
    { id: "0000000010", description: "Arabic Subtitles", shortName: "AR-SUB", altDescription: "ترجمة عربية" },
    { id: "0000000011", description: "English Subtitles", shortName: "EN-SUB" },
    { id: "0000000020", description: "Laser Projection", shortName: "LASER" },
    { id: "0000000021", description: "Dolby Atmos", shortName: "ATMOS" },
  ];
  await db.insert(s.sessionAttributes).values(ATTRS).onConflictDoNothing();

  // ---- cinemas ----
  const rnd = prng("voxi-seed");
  await db
    .insert(s.cinemas)
    .values(
      data.cinemas.map((c) => {
        const extra = CINEMA_EXTRAS[c.id] ?? DEFAULT_EXTRA(c.cinemaLocation, c.parkingInfo);
        const late = c.experiences.includes("MAX") || c.experiences.includes("IMAX");
        return {
          id: c.id,
          name: c.name,
          nameAlt: c.nameAlt,
          phoneNumber: "600 599 905",
          emailAddress: "customercare@voxcinemas.com",
          address1: c.address1,
          address2: "UAE",
          city: `${c.city} | ${c.emirate}`,
          latitude: c.latitude,
          longitude: c.longitude,
          parkingInfo: c.parkingInfo || extra.parking,
          loyaltyCode: c.id,
          description: c.description || `VOX Cinemas at ${c.mallName}.`,
          descriptionAlt: null,
          currencyCode: "AED",
          timeZoneId: "Arabian Standard Time",
          hopk: c.id,
          serverName: `AE${c.shortCode}VIS01`,
          slug: c.slug,
          mallName: c.mallName,
          emirate: c.emirate,
          shortCode: c.shortCode,
          openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
            day,
            open: "10:00",
            close: late || day === 4 || day === 5 ? "02:00" : "01:00",
          })),
          accessibilityInfo: extra.accessibility,
          inMallDirections: extra.directions,
          inMallDirectionsAlt: extra.directionsAlt,
          bestParking: c.parkingInfo ? `Nearest parking: ${c.parkingInfo}.` : extra.parking,
          experiences: c.experiences,
          websiteUrl: c.websiteUrl,
          active: true,
          updatedAt: new Date(),
        };
      }),
    )
    .onConflictDoUpdate({
      target: s.cinemas.id,
      set: {
        name: sql`excluded.name`,
        nameAlt: sql`excluded.name_alt`,
        latitude: sql`excluded.latitude`,
        longitude: sql`excluded.longitude`,
        experiences: sql`excluded.experiences`,
        description: sql`excluded.description`,
        updatedAt: new Date(),
      },
    });
  log(`cinemas: ${data.cinemas.length}`);

  // ---- cinema operators (experiences) ----
  const ops = data.cinemas.flatMap((c) =>
    c.experiences.map((exp) => ({
      cinemaId: c.id,
      code: `${c.shortCode}${EXPERIENCE_CODE[exp] ?? "OTH"}`,
      name: `${c.shortCode} ${exp === "GOLD" ? "GOLD" : exp.toUpperCase()}`,
      shortName: `${c.shortCode}${EXPERIENCE_CODE[exp] ?? "OTH"}`,
      experience: exp,
    })),
  );
  await db.insert(s.cinemaOperators).values(ops).onConflictDoNothing();

  // ---- films ----
  const filmRows = data.films.map((f) => ({
    hoCode: f.hoCode,
    title: f.title,
    titleAlt: f.titleAlt,
    rating: f.rating,
    ratingDescription: AGE_RULES.find((r) => r.rating === f.rating)?.text ?? "",
    synopsis: f.synopsis,
    synopsisAlt: "",
    openingDate: f.openingDate ? new Date(`${f.openingDate}Z`) : null,
    runTime: f.runTime,
    trailerUrl: f.trailerUrl,
    genreIds: f.genreNames.map((g) => genreIds.get(g)!).filter(Boolean),
    genreNames: f.genreNames,
    cast: [
      ...f.cast.map((n, i) => {
        const [first, ...rest] = n.split(" ");
        return {
          ID: `${f.hoCode}-A${i}`,
          FirstName: first ?? n,
          LastName: rest.join(" "),
          UrlToDetails: "",
          UrlToPicture: "",
          PersonType: "Actor" as const,
        };
      }),
      ...(f.director
        ? [
            {
              ID: `${f.hoCode}-D0`,
              FirstName: f.director.split(" ")[0]!,
              LastName: f.director.split(" ").slice(1).join(" "),
              UrlToDetails: "",
              UrlToPicture: "",
              PersonType: "Director" as const,
            },
          ]
        : []),
    ],
    language: f.language,
    subtitles: f.subtitles,
    posterUrl: f.posterUrl,
    heroUrl: f.heroUrl,
    slug: f.slug,
    websiteUrl: f.websiteUrl,
    status: f.status,
    isScheduledAtCinema: f.status === "now_showing",
    sourceHash: createHash("sha1").update(JSON.stringify(f)).digest("hex"),
    updatedAt: new Date(),
  }));
  for (const c of chunk(filmRows, 50)) {
    await db
      .insert(s.films)
      .values(c)
      .onConflictDoUpdate({
        target: s.films.hoCode,
        set: {
          title: sql`excluded.title`,
          synopsis: sql`excluded.synopsis`,
          status: sql`excluded.status`,
          genreNames: sql`excluded.genre_names`,
          cast: sql`excluded.cast`,
          posterUrl: sql`excluded.poster_url`,
          updatedAt: new Date(),
        },
      });
  }
  log(`films: ${filmRows.length}`);

  // ---- seat layout templates ----
  await db
    .insert(s.seatLayoutTemplates)
    .values(
      LAYOUTS.map((l) => ({
        id: l.id,
        experience: l.experience,
        name: l.name,
        totalSeats: l.totalSeats,
        layout: l.template,
      })),
    )
    .onConflictDoUpdate({
      target: s.seatLayoutTemplates.id,
      set: { layout: sql`excluded.layout`, totalSeats: sql`excluded.total_seats` },
    });

  // ---- sessions (+ scheduled films) ----
  await db.delete(s.sessions).where(sql`${s.sessions.sessionId} not like 'SW%'`); // keep sessions created by swaps? (none on fresh seed)
  await db.delete(s.scheduledFilms);
  const screenByKey = new Map<string, { name: string; number: number }>();
  const screenCounter = new Map<string, number>();
  const sessionRows = data.sessions.map((x) => {
    const cinema = data.cinemas.find((c) => c.id === x.cinemaId)!;
    const layout = layoutForExperience(x.experience, rnd.pick(["M", "M", "L", "S"]));
    const screenKey = `${x.cinemaId}:${x.experience}:${x.hoCode}`;
    let screen = screenByKey.get(screenKey);
    if (!screen) {
      const n = (screenCounter.get(x.cinemaId) ?? 0) + 1;
      screenCounter.set(x.cinemaId, n);
      const prefix = x.experience === "Standard" ? "SCREEN" : x.experience.toUpperCase();
      screen = { name: `${prefix} ${n}`, number: n };
      screenByKey.set(screenKey, screen);
    }
    const showtime = shift(x.showtime);
    const businessDate = shift(`${x.date}T00:00:00`).slice(0, 10);
    const total = layout.totalSeats;
    const occupancy = x.soldOut
      ? 1
      : Math.min(0.95, 0.1 + rnd.next() * 0.5 + (showtime.slice(11, 13) >= "18" ? 0.15 : 0));
    const is3D = /3d/i.test(x.experienceLabel) || (x.experience === "IMAX" && rnd.chance(0.4));
    return {
      cinemaId: x.cinemaId,
      sessionId: x.sessionId,
      hoCode: x.hoCode,
      showtime: new Date(`${showtime}Z`),
      sessionBusinessDate: businessDate,
      screenName: screen.name,
      screenNumber: screen.number,
      cinemaOperatorCode: `${cinema.shortCode}${EXPERIENCE_CODE[x.experience] ?? "OTH"}`,
      experience: x.experience,
      formatCode: is3D ? "0000000002" : "0000000001",
      attributeIds: [
        is3D ? "0000000007" : "0000000006",
        "0000000010",
        ...(x.experience === "MAX" || x.experience === "IMAX" ? ["0000000020", "0000000021"] : []),
      ],
      areaCategoryCodes: layout.template.areas.map((a) => a.areaCategoryCode),
      seatsAvailable: Math.max(0, Math.round(total * (1 - occupancy))),
      totalSeats: total,
      isAllocatedSeating: true,
      allowChildAdmits: x.experience !== "GOLD" && x.experience !== "THEATRE",
      allowTicketSales: !x.soldOut,
      soldoutStatus: x.soldOut ? 2 : occupancy > 0.9 ? 1 : 0,
      priceGroupCode: createHash("md5").update(`${x.cinemaId}:${x.experience}`).digest("hex"),
      typeCode: "01",
      seatLayoutTemplateId: layout.id,
      bookingUrl: x.bookingUrl,
      language: data.films.find((f) => f.hoCode === x.hoCode)?.language ?? "",
      sourceHash: "",
      updatedAt: new Date(),
    };
  });
  for (const c of chunk(sessionRows, 500)) await db.insert(s.sessions).values(c).onConflictDoNothing();
  const sf = new Map<string, { first: Date; last: Date }>();
  for (const r of sessionRows) {
    const k = `${r.cinemaId}|${r.hoCode}`;
    const cur = sf.get(k);
    if (!cur) sf.set(k, { first: r.showtime, last: r.showtime });
    else {
      if (r.showtime < cur.first) cur.first = r.showtime;
      if (r.showtime > cur.last) cur.last = r.showtime;
    }
  }
  await db.insert(s.scheduledFilms).values(
    [...sf].map(([k, v]) => ({
      cinemaId: k.split("|")[0]!,
      hoCode: k.split("|")[1]!,
      firstShowtime: v.first,
      lastShowtime: v.last,
    })),
  );
  log(`sessions: ${sessionRows.length}; scheduled films: ${sf.size}`);

  // ---- ticket types ----
  const ttRows = data.cinemas.flatMap((c) =>
    c.experiences.flatMap((exp) =>
      ticketTypesFor(exp).map((t, i) => ({
        id: `${c.id}-${EXPERIENCE_CODE[exp] ?? "OTH"}-${t.code}`,
        cinemaId: c.id,
        ticketTypeCode: `${EXPERIENCE_CODE[exp] ?? "OTH"}${t.code}`,
        experience: exp,
        areaCategoryCode: t.area,
        description: t.description,
        descriptionAlt: t.descriptionAlt,
        longDescription: t.long ?? "",
        priceInCents: t.priceInCents,
        hopk: String(1000 + i),
        headOfficeGroupingCode: `TT${t.code.padStart(8, "0")}`,
        isChildOnlyTicket: !!t.isChild,
        isAvailableForLoyaltyMembersOnly: !!t.loyaltyOnly,
        displaySequence: i + 1,
        priceGroupCode: createHash("md5").update(`${c.id}:${exp}`).digest("hex"),
      })),
    ),
  );
  await db.delete(s.ticketTypes);
  for (const c of chunk(ttRows, 300)) await db.insert(s.ticketTypes).values(c);
  log(`ticket types: ${ttRows.length}`);

  // ---- concessions ----
  await db.delete(s.concessionItems);
  await db.insert(s.concessionItems).values(
    CONCESSIONS.map((c, i) => ({
      id: c.id,
      cinemaId: null,
      tab: c.tab,
      headOfficeItemCode: `HO${c.id}`,
      hopk: String(1100 + i),
      description: c.description,
      descriptionAlt: c.descriptionAlt,
      extendedDescription: c.extended,
      priceInCents: c.price,
      taxInCents: Math.round(c.price * 0.05),
      itemClassCode:
        c.tab === "Drinks" ? "DRK" : c.tab === "Hot Food" || c.tab === "GOLD Menu" ? "HOT" : "BOX",
      imageUrl: c.image,
      dietaryTags: c.dietary,
      allergens: c.allergens ?? [],
      calories: c.calories ?? null,
      isCombo: !!c.isCombo,
      packageChildItems: c.children ?? [],
      modifierGroups: c.modifiers ?? [],
      experiences: c.experiences ?? [],
      isAvailableForInSeatDelivery: (c.experiences ?? []).length > 0,
      isAvailableForPickupAtCounter: true,
      isBestSeller: !!c.bestSeller,
      displaySequence: i + 1,
      active: true,
    })),
  );

  // ---- offers ----
  await db.delete(s.offerRedemptions);
  await db.delete(s.offers);
  await db.insert(s.offers).values(
    OFFERS.map((o) => ({
      id: o.id,
      title: o.title,
      titleAlt: o.titleAlt,
      shortDescription: o.short,
      shortDescriptionAlt: o.shortAlt,
      terms: o.terms,
      type: o.type,
      imageUrl: `https://picsum.photos/seed/voxi-offer-${o.id}/640/360`,
      rules: o.rules,
      benefit: o.benefit,
      totalBudget: o.budget ?? null,
      remainingBudget: o.budget ?? null,
      perMemberLimit: o.perMember ?? null,
      howToRedeem: o.howToRedeem,
      active: true,
      priority: o.priority,
    })),
  );

  // ---- customers, loyalty ----
  await db.delete(s.purchaseHistory);
  await db.delete(s.refunds);
  await db.delete(s.bookings);
  await db.delete(s.loyaltyLedger);
  await db.delete(s.loyaltyAccounts);
  await db.delete(s.customers);
  await db.insert(s.customers).values(
    PERSONAS.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      phone: p.phone,
      memberId: p.memberId,
      preferredLanguage: p.preferredLanguage,
      preferences: p.preferences,
      homeCinemaId: p.homeCinemaId,
      persona: p.persona,
      demoPin: p.pin,
    })),
  );
  await db.insert(s.loyaltyAccounts).values(
    PERSONAS.filter((p) => p.memberId).map((p) => ({
      memberId: p.memberId!,
      customerId: p.id,
      tier: p.tier ?? "Blue",
      sharePointsBalance: p.sharePoints ?? 0,
      voxRewardsBalanceCents: p.voxRewardsCents ?? 0,
    })),
  );

  // ---- bookings on real sessions ----
  const allSessions = sessionRows;
  const now = new Date(`${nowLocal}Z`);
  const bookingRows: (typeof s.bookings.$inferInsert)[] = [];
  const tt = (cinemaId: string, exp: string, code: string) =>
    ttRows.find((t) => t.cinemaId === cinemaId && t.experience === exp && t.ticketTypeCode.endsWith(code));
  const pickSession = (sc: BookingScenario, preferredCinemas: string[]) => {
    const exp = sc.experience ?? "Standard";
    const film = (r: (typeof sessionRows)[number]) => data.films.find((f) => f.hoCode === r.hoCode)!;
    let cands = allSessions.filter((r) => r.experience === exp && r.soldoutStatus !== 2);
    if (sc.cinemaId) cands = cands.filter((r) => r.cinemaId === sc.cinemaId);
    else
      cands = cands.filter((r) => preferredCinemas.includes(r.cinemaId)).length
        ? cands.filter((r) => preferredCinemas.includes(r.cinemaId))
        : cands;
    if (sc.genreHint)
      cands = cands.filter((r) => film(r).genreNames.includes(sc.genreHint!)).length
        ? cands.filter((r) => film(r).genreNames.includes(sc.genreHint!))
        : cands;
    if (sc.languageHint)
      cands = cands.filter((r) => film(r).language === sc.languageHint).length
        ? cands.filter((r) => film(r).language === sc.languageHint)
        : cands;
    const ms = (d: Date) => d.getTime();
    switch (sc.when) {
      case "soon":
        cands = cands.filter((r) => ms(r.showtime) > ms(now) && ms(r.showtime) < ms(now) + 25 * 60000);
        if (!cands.length) return null; // synthesised below
        break;
      case "past":
        cands = cands.filter((r) => ms(r.showtime) < ms(now) - 3 * 3600000);
        if (!cands.length) cands = allSessions.filter((r) => r.experience === exp).slice(0, 20); // fallback: will be shifted back
        break;
      case "tomorrow_evening":
        cands = cands.filter(
          (r) =>
            ms(r.showtime) > ms(now) + 20 * 3600000 &&
            ms(r.showtime) < ms(now) + 44 * 3600000 &&
            r.showtime.getUTCHours() >= 18,
        );
        break;
      case "weekend":
        cands = cands.filter(
          (r) => ms(r.showtime) > ms(now) + 3 * 3600000 && [5, 6].includes(r.showtime.getUTCDay()),
        );
        break;
      default:
        cands = cands.filter((r) => ms(r.showtime) > ms(now) + 3 * 3600000);
    }
    if (!cands.length)
      cands = allSessions.filter((r) => r.experience === exp && ms(r.showtime) > ms(now) + 3 * 3600000);
    // prefer films not yet used by another demo booking so the demo shows variety
    const used = new Set(bookingRows.map((b) => b.hoCode));
    const fresh = cands.filter((r) => !used.has(r.hoCode));
    if (fresh.length) cands = fresh;
    return cands[Math.floor(rnd.next() * cands.length)] ?? null;
  };

  let bookingNo = 100000;
  let transNo = 500000;
  const seatStates = new Map<string, ReturnType<typeof generateSeatState>>();
  const historyRows: (typeof s.purchaseHistory.$inferInsert)[] = [];
  for (const p of PERSONAS) {
    for (const sc of p.bookings) {
      let sess = pickSession(sc, p.preferences.cinemas ?? [p.homeCinemaId]);
      if (!sess) {
        // synthesise a session that starts in 20 minutes (cut-off demo) by cloning a real one
        const base =
          allSessions.find(
            (r) =>
              r.cinemaId === (sc.cinemaId ?? p.homeCinemaId) &&
              r.experience === (sc.experience ?? "Standard"),
          ) ?? allSessions[0]!;
        sess = {
          ...base,
          sessionId: `SW${String(9000 + bookingRows.length)}`,
          showtime: new Date(`${addMinutesIso(nowLocal, 20)}Z`),
          sessionBusinessDate: nowLocal.slice(0, 10),
        };
        await db.insert(s.sessions).values(sess).onConflictDoNothing();
      }
      const film = data.films.find((f) => f.hoCode === sess.hoCode)!;
      const cinema = data.cinemas.find((c) => c.id === sess.cinemaId)!;
      const layout = LAYOUTS.find((l) => l.id === sess.seatLayoutTemplateId)!;
      const key = `${sess.cinemaId}-${sess.sessionId}`;
      const state =
        seatStates.get(key) ??
        generateSeatState(sess.cinemaId, sess.sessionId, layout.template, {
          soldOut: sess.soldoutStatus === 2,
        });
      const qty = sc.tickets.reduce((a, t) => a + t.qty, 0);
      const wantsPremium = sc.tickets.some((t) => t.code.startsWith("013"));
      const seats = pickAdjacentSeats(
        layout.template,
        state,
        qty,
        p.preferences.seatPreference ?? "middle",
        wantsPremium ? "0000000001" : undefined,
      );
      const bookingId =
        sc.bookingId ?? `${p.firstName.slice(0, 2).toUpperCase()}${String(bookingNo).slice(-5)}`;
      const tickets: (typeof s.bookings.$inferInsert)["tickets"] = [];
      let i = 0;
      let ticketTotal = 0;
      for (const t of sc.tickets) {
        const type =
          tt(sess.cinemaId, sess.experience, t.code) ??
          ttRows.find((x) => x.cinemaId === sess.cinemaId && x.experience === sess.experience)!;
        for (let q = 0; q < t.qty; q++) {
          const seat = seats[i];
          const discount = sc.offerId?.includes("BOGO") && i % 2 === 1 ? type.priceInCents : 0;
          const final = type.priceInCents - discount;
          ticketTotal += final;
          tickets.push({
            Id: String(i + 1),
            TicketTypeCode: type.ticketTypeCode,
            Description: type.description,
            DescriptionAlt: type.descriptionAlt ?? "",
            PriceCents: type.priceInCents,
            DiscountPriceCents: discount,
            FinalPriceCents: final,
            TaxCents: Math.round(final * 0.05),
            AreaCategoryCode: type.areaCategoryCode,
            SeatRowId: seat?.row ?? null,
            SeatNumber: seat?.number ?? null,
            SeatRowIndex: seat?.rowIndex ?? null,
            SeatColumnIndex: seat?.columnIndex ?? null,
            SeatAreaNumber: seat?.areaNumber ?? null,
            DealDescription: sc.offerId ? (OFFERS.find((o) => o.id === sc.offerId)?.title ?? null) : null,
            DealDefinitionId: sc.offerId ?? null,
            LoyaltyRecognitionId: null,
            Barcode: `${bookingId}${String(i + 1).padStart(2, "0")}`,
            Status: sc.status === "cancelled" ? "refunded" : sc.collected ? "used" : "valid",
          });
          if (seat) state[seatKey(seat.row, seat.number)] = { status: 1, bookingId };
          i++;
        }
      }
      seatStates.set(key, state);
      const concessions = (sc.concessions ?? []).map((c, j) => {
        const item = CONCESSIONS.find((x) => x.id === c.itemId)!;
        return {
          Id: String(j + 1),
          ItemId: item.id,
          Description: item.description,
          Quantity: c.quantity,
          PriceCents: item.price,
          DealPriceCents: item.price * c.quantity,
          FinalPriceCents: item.price * c.quantity,
          TaxCents: Math.round(item.price * c.quantity * 0.05),
          DeliveryOption: item.experiences?.length ? 1 : 2,
          Modifiers: [],
          DealDefinitionId: null,
          DealDescription: null,
        };
      });
      const concTotal = concessions.reduce((a, c) => a + c.FinalPriceCents, 0);
      const total = ticketTotal + concTotal;
      const fee = sc.payment === "LOYALTY" ? 0 : 250 * qty;
      const status = sc.status === "cancelled" ? "refunded" : sc.collected ? "collected" : "confirmed";
      bookingRows.push({
        vistaBookingId: bookingId,
        vistaBookingNumber: bookingNo++,
        vistaTransNumber: transNo++,
        cinemaId: sess.cinemaId,
        sessionId: sess.sessionId,
        hoCode: sess.hoCode,
        filmTitle: film.title,
        filmTitleAlt: film.titleAlt,
        filmClassification: film.rating,
        experience: sess.experience,
        screenName: sess.screenName,
        showtime: sess.showtime,
        status,
        customerId: p.id,
        customer: {
          FirstName: p.firstName,
          LastName: p.lastName,
          Email: p.email,
          Phone: p.phone,
          ...(p.memberId ? { MemberId: p.memberId } : {}),
        },
        tickets,
        concessions,
        appliedOffers: sc.offerId
          ? [
              {
                offerId: sc.offerId,
                title: OFFERS.find((o) => o.id === sc.offerId)!.title,
                type: "bank",
                discountCents: tickets.reduce((a, t) => a + t.DiscountPriceCents, 0),
              },
            ]
          : [],
        payments: [
          sc.payment === "CREDIT"
            ? {
                PaymentTenderCategory: "CREDIT",
                PaymentValueCents: total + fee,
                CardNumberMasked: sc.offerId ? "4555 33** **** 1029" : "4111 11** **** 1111",
                CardType: "VISA",
                BankReference: `BR${transNo}`,
                Reference: `PAY${transNo}`,
              }
            : sc.payment === "EWALLET"
              ? {
                  PaymentTenderCategory: "EWALLET",
                  PaymentValueCents: total + fee,
                  Reference: `WAL${transNo}`,
                }
              : sc.payment === "APPLEPAY"
                ? {
                    PaymentTenderCategory: "APPLEPAY",
                    PaymentValueCents: total + fee,
                    CardNumberMasked: "5200 00** **** 0007",
                    Reference: `APL${transNo}`,
                  }
                : {
                    PaymentTenderCategory: "LOYALTY",
                    PaymentValueCents: total,
                    PointsRedeemed: total,
                    Reference: `PTS${transNo}`,
                  },
        ],
        totalValueCents: total + fee,
        taxValueCents: Math.round(total * 0.05),
        bookingFeeValueCents: fee,
        refundedValueCents: sc.status === "cancelled" ? total + fee : 0,
        salesChannel: rnd.pick(["WWW", "CELL"]),
        source: "seed",
        qrPayload: `VOX|${bookingId}|${sess.cinemaId}|${sess.sessionId}`,
        ticketsCollected: !!sc.collected,
        bookedAt: new Date(sess.showtime.getTime() - rnd.int(1, 5) * 86400000),
        updatedAt: new Date(),
      });
      if (status === "collected" || sc.when === "past") {
        historyRows.push({
          id: `ph_${bookingId}`,
          customerId: p.id,
          bookingId,
          cinemaId: sess.cinemaId,
          hoCode: sess.hoCode,
          filmTitle: film.title,
          genres: film.genreNames,
          language: film.language,
          experience: sess.experience,
          showtime: sess.showtime,
          ticketCount: qty,
          concessionItemIds: (sc.concessions ?? []).map((c) => c.itemId),
          spendCents: total + fee,
        });
      }
    }
  }
  await db.insert(s.bookings).values(bookingRows);
  if (historyRows.length) await db.insert(s.purchaseHistory).values(historyRows);
  // extra synthetic history for personalisation richness (older visits, no booking rows)
  const extraHistory: (typeof s.purchaseHistory.$inferInsert)[] = [];
  for (const p of PERSONAS.filter((x) => x.bookings.length)) {
    const prefGenres = p.preferences.genres ?? ["Action"];
    const prefExp = p.preferences.experiences ?? ["Standard"];
    for (let k = 0; k < 6; k++) {
      const filmsOfGenre = data.films.filter(
        (f) =>
          f.genreNames.some((g) => prefGenres.includes(g)) &&
          (!p.preferences.languages || p.preferences.languages.includes(f.language)),
      );
      const film = rnd.pick(filmsOfGenre.length ? filmsOfGenre : data.films);
      const exp = rnd.pick(prefExp);
      const cinemaId = rnd.pick(p.preferences.cinemas ?? [p.homeCinemaId]);
      const daysAgo = 20 + k * 25 + rnd.int(0, 10);
      const hour = (p.preferences.timeOfDay ?? ["evening"]).includes("late")
        ? 22
        : (p.preferences.timeOfDay ?? ["evening"]).includes("afternoon")
          ? 15
          : 19;
      const showtime = new Date(now.getTime() - daysAgo * 86400000);
      showtime.setUTCHours(hour, rnd.pick([0, 15, 30, 45]), 0, 0);
      const price = EXPERIENCE_PRICING[exp]?.adult ?? 4500;
      const qty = rnd.int(1, 4);
      extraHistory.push({
        id: `ph_${p.id}_${k}`,
        customerId: p.id,
        bookingId: null,
        cinemaId,
        hoCode: film.hoCode,
        filmTitle: film.title,
        genres: film.genreNames,
        language: film.language,
        experience: exp,
        showtime,
        ticketCount: qty,
        concessionItemIds: rnd.chance(0.6)
          ? [rnd.pick(CONCESSIONS.filter((c) => !c.experiences?.length || c.experiences.includes(exp))).id]
          : [],
        spendCents: price * qty + (rnd.chance(0.6) ? 4500 : 0),
      });
    }
  }
  await db.insert(s.purchaseHistory).values(extraHistory);
  // persist seat states touched by bookings
  await db.delete(s.sessionSeatState);
  await db.insert(s.sessionSeatState).values(
    [...seatStates].map(([k, seats]) => ({
      cinemaId: k.split("-")[0]!,
      sessionId: k.split("-")[1]!,
      seats,
      version: 1,
    })),
  );
  log(
    `bookings: ${bookingRows.length}; purchase history: ${historyRows.length + extraHistory.length}; seat states: ${seatStates.size}`,
  );

  // ---- knowledge base documents (optional) ----
  const kbDir = process.env.SEED_KB_DIR ?? path.resolve(here, "../../../agent/kb");
  try {
    const files = (await readdir(kbDir)).filter((f) => f.endsWith(".md"));
    const rows = [];
    for (const f of files) {
      const content = await readFile(path.join(kbDir, f), "utf8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      const meta: Record<string, string> = {};
      for (const line of fm?.[1]?.split("\n") ?? []) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) meta[m[1]!] = m[2]!.replace(/^"|"$/g, "");
      }
      rows.push({
        id: f.replace(/\.md$/, ""),
        title: meta.title ?? f,
        language: (meta.language ?? "en") as string,
        category: meta.category ?? "faq",
        sourceUrl: meta.source ?? "",
        contentMarkdown: content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        updatedAt: new Date(),
      });
    }
    if (rows.length) {
      await db
        .insert(s.kbDocuments)
        .values(rows)
        .onConflictDoUpdate({
          target: s.kbDocuments.id,
          set: {
            contentMarkdown: sql`excluded.content_markdown`,
            contentHash: sql`excluded.content_hash`,
            title: sql`excluded.title`,
            updatedAt: new Date(),
          },
        });
      log(`kb documents: ${rows.length}`);
    }
  } catch {
    log(`kb dir ${kbDir} not found — skipping`);
  }

  // ---- age rule docs are also stored as KB text for RAG (generated) ----
  const ageDoc = [
    "# Age restrictions and movie ratings (UAE)",
    "",
    ...AGE_RULES.map((r) => `- **${r.rating}** — ${r.text}`),
    "",
    "## Experience-specific rules",
    ...Object.entries(EXPERIENCE_AGE_RULES).map(([k, v]) => `- **${k}** — ${v}`),
  ].join("\n");
  await db
    .insert(s.kbDocuments)
    .values({
      id: "age-restrictions-generated",
      title: "Age restrictions and movie ratings",
      language: "en",
      category: "age_restrictions",
      sourceUrl: "https://uae.voxcinemas.com/faq",
      contentMarkdown: ageDoc,
      contentHash: createHash("sha256").update(ageDoc).digest("hex"),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: s.kbDocuments.id,
      set: { contentMarkdown: ageDoc, updatedAt: new Date() },
    });

  log("done");
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
