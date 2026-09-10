import { describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import type { sessions } from "../src/schema/reference.js";
import {
  type ScheduleSnapshot,
  demoScheduleEnabled,
  planDemoSchedule,
  refreshDemoSchedule,
} from "../src/seed/refresh-demo-schedule.js";

type Session = typeof sessions.$inferSelect;
const snapshot: ScheduleSnapshot = {
  films: [
    { hoCode: "arabic", status: "now_showing" },
    { hoCode: "tamil", status: "now_showing" },
    { hoCode: "advance", status: "advance" },
  ],
  sessions: [
    {
      cinemaId: "0002",
      sessionId: "123",
      hoCode: "arabic",
      showtime: "2026-09-09T19:00:00",
      date: "2026-09-09",
    },
    {
      cinemaId: "0013",
      sessionId: "456",
      hoCode: "tamil",
      showtime: "2026-09-09T21:00:00",
      date: "2026-09-09",
    },
    {
      cinemaId: "0013",
      sessionId: "789",
      hoCode: "advance",
      showtime: "2026-09-13T20:00:00",
      date: "2026-09-13",
    },
  ],
};
const originals = snapshot.sessions.map(
  (session) =>
    ({
      ...session,
      showtime: new Date(`${session.showtime}Z`),
      experience: "Standard",
      totalSeats: 100,
      seatsAvailable: 5,
      soldoutStatus: 2,
      allowTicketSales: false,
      language: session.hoCode,
      sourceHash: "",
      updatedAt: new Date("2026-09-09T00:00:00Z"),
    }) as unknown as Session,
);

describe("synthetic demo schedule", () => {
  it("requires explicit demo and mock flags before accessing the database", async () => {
    expect(demoScheduleEnabled({})).toBe(false);
    expect(demoScheduleEnabled({ DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "real" })).toBe(false);
    expect(demoScheduleEnabled({ DEMO_SCHEDULE_REFRESH: "false", VISTA_PROVIDER: "mock" })).toBe(false);
    expect(
      await refreshDemoSchedule({} as Db, { DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "real" }),
    ).toEqual({ enabled: false, inserted: 0, days: 0 });
  });
  it("covers seven dates including Friday/Saturday, preserves language, and excludes advance-only titles", () => {
    const before = structuredClone(originals);
    const rows = planDemoSchedule(snapshot, originals, "2026-09-10T00:40:00");
    expect(rows).toHaveLength(14);
    for (const date of [
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]) {
      expect(
        rows
          .filter((row) => row.sessionBusinessDate === date)
          .map((row) => row.language)
          .sort(),
      ).toEqual(["arabic", "tamil"]);
    }
    expect(
      rows.every(
        (row) =>
          /^D\d{6}[a-f0-9]{9}$/.test(row.sessionId) &&
          row.sourceHash?.startsWith("demo-schedule:v1:") &&
          row.bookingUrl === "",
      ),
    ).toBe(true);
    expect(originals).toEqual(before);
    expect(planDemoSchedule(snapshot, [...originals, ...rows], "2026-09-10T00:40:00")).toEqual([]);
    expect(planDemoSchedule(snapshot, [...originals, ...rows], "2026-09-11T00:40:00")).toHaveLength(2);
  });
  it("does not duplicate an existing equivalent screening or invent another after it is held/sold out", () => {
    const [existing] = planDemoSchedule(snapshot, originals, "2026-09-10T18:00:00", 1);
    const closed = { ...existing!, sessionId: "original-id", seatsAvailable: 0, soldoutStatus: 2 };
    const rows = planDemoSchedule(snapshot, [...originals, closed], "2026-09-10T20:00:00", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hoCode).toBe("tamil");
  });
});
