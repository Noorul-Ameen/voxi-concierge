import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { createDb } from "../src/client.js";
import * as S from "../src/schema/index.js";
import { refreshDemoSchedule } from "../src/seed/refresh-demo-schedule.js";
import { nowLocalIso } from "../src/seed/util.js";

// Explicit opt-in: this integration test uses only the dedicated isolated local test database.
const enabled = process.env.DEMO_SCHEDULE_TEST === "true";
const database = enabled ? createDb(assertLocalTestDatabase(), { max: 2 }) : null;
const holdId = `schedule-hold-${randomUUID()}`;
afterAll(async () => {
  if (!database) return;
  await database.db.delete(S.orders).where(eq(S.orders.userSessionId, holdId));
  await database.close();
});

describe.skipIf(!enabled)("insert-only demo schedule against PostgreSQL", () => {
  it("fills today's gap, remains idempotent, and preserves every existing session, booking, seat map and hold", async () => {
    assertLocalTestDatabase();
    const db = database!.db;
    const now = `${nowLocalIso().slice(0, 10)}T00:00:00`;
    const original = await db.select().from(S.sessions);
    expect(original.length).toBeGreaterThan(1000);
    const first = original[0]!;
    await db.insert(S.orders).values({
      userSessionId: holdId,
      cinemaId: first.cinemaId,
      sessionId: first.sessionId,
      state: "seats_selected",
      seatsAllocated: true,
      expiryAt: new Date(Date.now() + 600_000),
    });
    const bookings = await db.select().from(S.bookings);
    const seatMaps = await db.select().from(S.sessionSeatState);
    const [hold] = await db.select().from(S.orders).where(eq(S.orders.userSessionId, holdId));
    const env = { DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "mock" };
    const result = await refreshDemoSchedule(db, env, now);
    expect(result.enabled).toBe(true);
    expect(result.inserted).toBeGreaterThanOrEqual(0);
    expect((await refreshDemoSchedule(db, env, now)).inserted).toBe(0);
    const after = await db.select().from(S.sessions);
    expect(after.filter((row) => row.sourceHash?.startsWith("demo-schedule:v1:")).length).toBeGreaterThan(
      5000,
    );
    const byId = new Map(after.map((row) => [`${row.cinemaId}-${row.sessionId}`, row]));
    for (const row of original) expect(byId.get(`${row.cinemaId}-${row.sessionId}`)).toEqual(row);
    expect(await db.select().from(S.bookings)).toEqual(bookings);
    expect(await db.select().from(S.sessionSeatState)).toEqual(seatMaps);
    expect((await db.select().from(S.orders).where(eq(S.orders.userSessionId, holdId)))[0]).toEqual(hold);
    const [spider] = await db.select().from(S.films).where(eq(S.films.hoCode, "HO00013065"));
    expect(spider?.title).toContain("Spider-Man");
    for (const offset of [0, 1, 2]) {
      const date = new Date(`${now}Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      const day = date.toISOString().slice(0, 10);
      const shows = await db.select().from(S.sessions).where(eq(S.sessions.sessionBusinessDate, day));
      expect(shows.some((show) => show.cinemaId === "0002" && show.hoCode === spider!.hoCode)).toBe(true);
      for (const [cinemaId, language] of [
        ["0002", "Arabic"],
        ["0013", "Tamil"],
      ]) {
        const matching = await db
          .select({ session: S.sessions })
          .from(S.sessions)
          .innerJoin(S.films, eq(S.films.hoCode, S.sessions.hoCode))
          .where(
            and(
              eq(S.sessions.sessionBusinessDate, day),
              eq(S.sessions.cinemaId, cinemaId!),
              eq(S.films.language, language!),
            ),
          );
        expect(matching.length).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
