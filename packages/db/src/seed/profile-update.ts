/** Upgrade only the three known demo personas; never reseed bookings, balances or real customer history. */
import { inferCustomerProfile, preferenceCalendar, visitDayType } from "@voxi/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { hashPassword } from "../password.js";
import * as S from "../schema/index.js";
import { PERSONAS } from "./personas.js";
import { nowLocalIso } from "./util.js";

export const DEMO_PROFILE_VERSION = 2;
export const demoHistoryId = (customerId: string, day: "weekday" | "weekend", visit: number) =>
  `pref_${customerId}_${day === "weekday" ? "wd" : "we"}_${visit}`;
export const DEMO_PROFILE_PATTERNS = [
  {
    id: "cust_sara",
    language: "Arabic",
    cinemaId: "0002",
    seat: "middle" as const,
    weekday: 19 * 60,
    weekend: 16 * 60,
  },
  {
    id: "cust_rahul",
    language: "Tamil",
    cinemaId: "0013",
    seat: "back" as const,
    weekday: 21 * 60,
    weekend: 18 * 60,
  },
  {
    id: "cust_james",
    language: "English",
    cinemaId: "0002",
    seat: "back" as const,
    weekday: 20 * 60,
    weekend: 16 * 60 + 30,
  },
];

export async function updateDemoProfiles(db: Db, env = process.env, now = nowLocalIso()) {
  const calendar = preferenceCalendar(env);
  const films = await db.select().from(S.films);
  for (const pattern of DEMO_PROFILE_PATTERNS) {
    const persona = PERSONAS.find((p) => p.id === pattern.id)!;
    const existing = (await db.select().from(S.customers).where(eq(S.customers.id, pattern.id)))[0];
    // A matching ID alone is not enough to overwrite a customer that replaced a seed account.
    if (!existing || existing.email.toLowerCase() !== persona.email.toLowerCase()) continue;
    const password = env[`DEMO_${persona.firstName.toUpperCase()}_PASSWORD`];
    const passwordHash = !existing.passwordHash && password ? await hashPassword(password) : undefined;
    if (existing.demoProfileVersion >= DEMO_PROFILE_VERSION) {
      if (passwordHash)
        await db.update(S.customers).set({ passwordHash }).where(eq(S.customers.id, pattern.id));
      continue;
    }
    const candidates = films.filter((f) => f.language === pattern.language);
    if (!candidates.length)
      throw new Error(`Cannot construct ${pattern.language} demo history: catalogue has no matching films`);
    await db.transaction(async (tx) => {
      const prior = await tx
        .select()
        .from(S.purchaseHistory)
        .where(eq(S.purchaseHistory.customerId, pattern.id));
      const seedBookings = await tx
        .select({ id: S.bookings.vistaBookingId })
        .from(S.bookings)
        .where(and(eq(S.bookings.customerId, pattern.id), eq(S.bookings.source, "seed")));
      const seedIds = new Set(seedBookings.map((b) => b.id));
      const replaceIds = prior
        .filter(
          (h) =>
            h.synthetic || h.id.startsWith(`ph_${pattern.id}_`) || (h.bookingId && seedIds.has(h.bookingId)),
        )
        .map((h) => h.id);
      if (replaceIds.length)
        await tx
          .delete(S.purchaseHistory)
          .where(
            and(eq(S.purchaseHistory.customerId, pattern.id), inArray(S.purchaseHistory.id, replaceIds)),
          );
      const visits: (typeof S.purchaseHistory.$inferInsert)[] = [];
      for (const day of ["weekday", "weekend"] as const) {
        for (let visit = 0; visit < 6; visit++) {
          const date = new Date(`${now.slice(0, 10)}T12:00:00Z`);
          date.setUTCDate(date.getUTCDate() - 7 * (visit + 1) - (day === "weekend" ? 1 : 3));
          while (visitDayType(date.toISOString().slice(0, 19), calendar) !== day)
            date.setUTCDate(date.getUTCDate() - 1);
          const minutes = pattern[day] + [-15, 0, 15, 0, -15, 15][visit]!;
          date.setUTCHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
          const film = candidates[visit % candidates.length]!;
          visits.push({
            id: demoHistoryId(pattern.id, day, visit),
            customerId: pattern.id,
            cinemaId: pattern.cinemaId,
            hoCode: film.hoCode,
            filmTitle: film.title,
            genres: film.genreNames ?? [],
            language: film.language,
            experience: persona.preferences.experiences?.[0] ?? "Standard",
            showtime: date,
            ticketCount: 2,
            concessionItemIds: pattern.id === "cust_sara" ? ["9540", "7747"] : [],
            spendCents: 9200,
            seatPreference: pattern.seat,
            synthetic: true,
          });
        }
      }
      await tx.insert(S.purchaseHistory).values(visits);
      const history = await tx
        .select()
        .from(S.purchaseHistory)
        .where(eq(S.purchaseHistory.customerId, pattern.id));
      const inferred = inferCustomerProfile(
        history.map((h) => ({ ...h, showtime: h.showtime.toISOString().slice(0, 19) })),
        calendar,
        now,
      );
      await tx
        .update(S.customers)
        .set({
          ...(passwordHash ? { passwordHash } : {}),
          demoProfileVersion: DEMO_PROFILE_VERSION,
          preferences: {
            ...persona.preferences,
            languages: inferred.movieLanguage ? [inferred.movieLanguage] : [],
            cinemas: inferred.cinemaId ? [inferred.cinemaId] : [],
            seatPreference: inferred.seatPreference ?? pattern.seat,
          },
          homeCinemaId: inferred.cinemaId,
          persona: `${persona.firstName} — ${inferred.movieLanguage} films; preferences inferred from demo booking history`,
        })
        .where(eq(S.customers.id, pattern.id));
    });
  }
}
