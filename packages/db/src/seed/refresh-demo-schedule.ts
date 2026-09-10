/**
 * Insert-only simulator availability. These are synthetic screenings, not live VOX inventory.
 * Enable only with DEMO_SCHEDULE_REFRESH=true AND VISTA_PROVIDER=mock. Existing sessions,
 * holds, seat maps, bookings and the captured source file are never changed.
 * IDs are D + YYMMDD + nine hash characters; sourceHash records the original snapshot session.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import * as S from "../schema/index.js";
import { addDaysIso, nowLocalIso } from "./util.js";

export const DEMO_SCHEDULE_SOURCE = "demo-schedule:v1:";
type Session = typeof S.sessions.$inferSelect;
export type ScheduleSnapshot = {
  films: { hoCode: string; status: string }[];
  sessions: {
    cinemaId: string;
    sessionId: string;
    hoCode: string;
    showtime: string;
    date: string;
  }[];
};

export function demoScheduleEnabled(env: Record<string, string | undefined>): boolean {
  return env.DEMO_SCHEDULE_REFRESH === "true" && env.VISTA_PROVIDER === "mock";
}

const identity = (session: { cinemaId: string; sessionId: string }) =>
  `${session.cinemaId}-${session.sessionId}`;
const slot = (session: Session) =>
  `${session.cinemaId}|${session.hoCode}|${session.experience}|${session.showtime.toISOString()}`;

/** Pick each cinema's fullest captured regular day, retaining its real film/language/experience mix. */
export function planDemoSchedule(
  snapshot: ScheduleSnapshot,
  existing: Session[],
  nowLocal: string,
  days = 7,
): Session[] {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("Demo horizon must be 1–31 days");
  const regularFilms = new Set(snapshot.films.filter((f) => f.status === "now_showing").map((f) => f.hoCode));
  const reference = new Map(existing.map((session) => [identity(session), session]));
  const capturedDays = new Map<string, Map<string, ScheduleSnapshot["sessions"]>>();
  for (const session of snapshot.sessions) {
    if (!regularFilms.has(session.hoCode) || !reference.has(identity(session))) continue;
    let cinema = capturedDays.get(session.cinemaId);
    if (!cinema) {
      cinema = new Map();
      capturedDays.set(session.cinemaId, cinema);
    }
    const day = cinema.get(session.date) ?? [];
    day.push(session);
    cinema.set(session.date, day);
  }
  const templates = [...capturedDays.values()].flatMap(
    (cinema) =>
      [...cinema.entries()].sort(
        ([dayA, a], [dayB, b]) => b.length - a.length || dayB.localeCompare(dayA),
      )[0]?.[1] ?? [],
  );
  const occupiedSlots = new Set(existing.map(slot));
  const occupiedIds = new Set(existing.map(identity));
  const additions: Session[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = addDaysIso(`${nowLocal.slice(0, 10)}T00:00:00`, offset).slice(0, 10);
    for (const template of templates) {
      const showtime = `${date}T${template.showtime.slice(11, 19)}`;
      // Today's passed screenings are not useful, and must never become a recovery target.
      if (showtime <= nowLocal) continue;
      const original = reference.get(identity(template))!;
      const digest = createHash("sha256")
        .update(`${date}|${identity(template)}`)
        .digest("hex")
        .slice(0, 9);
      const row: Session = {
        ...original,
        sessionId: `D${date.replaceAll("-", "").slice(2)}${digest}`,
        showtime: new Date(`${showtime}Z`),
        sessionBusinessDate: date,
        // Fresh simulator occupancy is independent of bookings/holds on the source screening.
        seatsAvailable: Math.max(1, Math.floor(original.totalSeats * 0.8)),
        soldoutStatus: 0,
        allowTicketSales: true,
        bookingUrl: "",
        sourceHash: `${DEMO_SCHEDULE_SOURCE}${identity(template)}`,
        updatedAt: new Date(`${nowLocal}Z`),
      };
      if (occupiedIds.has(identity(row)) || occupiedSlots.has(slot(row))) continue;
      occupiedIds.add(identity(row));
      occupiedSlots.add(slot(row));
      additions.push(row);
    }
  }
  return additions;
}

async function loadSnapshot(market: string): Promise<ScheduleSnapshot> {
  if (!/^[a-z]{2,5}$/.test(market)) throw new Error("Invalid demo snapshot market");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, `data/vox-${market}.json`),
    path.resolve(here, `../../src/seed/data/vox-${market}.json`),
  ];
  const dataPath = candidates.find((candidate) => existsSync(candidate));
  if (!dataPath) throw new Error(`Demo snapshot missing for ${market}`);
  return JSON.parse(await readFile(dataPath, "utf8")) as ScheduleSnapshot;
}

export async function refreshDemoSchedule(
  db: Db,
  env: Record<string, string | undefined> = process.env,
  nowLocal = nowLocalIso(env.DEFAULT_TIMEZONE ?? "Asia/Dubai"),
) {
  if (!demoScheduleEnabled(env)) return { enabled: false, inserted: 0, days: 0 };
  const snapshot = await loadSnapshot(env.SEED_MARKET ?? "uae");
  const inserted = await db.transaction(async (tx) => {
    // Concurrent API bootstraps cannot race the semantic duplicate check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('demo-schedule:v1'))`);
    const existing = await tx.select().from(S.sessions);
    const additions = planDemoSchedule(snapshot, existing, nowLocal);
    if (!additions.length) return 0;
    let count = 0;
    for (let start = 0; start < additions.length; start += 250) {
      const rows = await tx
        .insert(S.sessions)
        .values(additions.slice(start, start + 250))
        .onConflictDoNothing()
        .returning({ id: S.sessions.sessionId });
      count += rows.length;
    }
    // A missing association may be added; existing metadata is deliberately left untouched.
    const associations = new Map<string, typeof S.scheduledFilms.$inferInsert>();
    for (const row of additions) {
      const key = `${row.cinemaId}-${row.hoCode}`;
      const association = associations.get(key);
      if (association) association.lastShowtime = row.showtime;
      else
        associations.set(key, {
          cinemaId: row.cinemaId,
          hoCode: row.hoCode,
          firstShowtime: row.showtime,
          lastShowtime: row.showtime,
        });
    }
    await tx
      .insert(S.scheduledFilms)
      .values([...associations.values()])
      .onConflictDoNothing();
    return count;
  });
  return { enabled: true, inserted, days: 7 };
}
