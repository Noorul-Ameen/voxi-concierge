import { describe, expect, it } from "vitest";
import { cinemaDate } from "../src/lib/cinema-time";

describe("customer history Dubai timestamps", () => {
  it("keeps zone-less visits at the same Dubai time in browsers outside Dubai", () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
        process.env.TZ = zone;
        const date = cinemaDate("2030-06-03T21:00:00");
        expect(date.toISOString()).toBe("2030-06-03T17:00:00.000Z");
        expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(date)).toBe("21:00");
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("preserves explicit UTC/offset instants and fractional seconds", () => {
    expect(cinemaDate("2030-06-03T17:00:00Z").toISOString()).toBe("2030-06-03T17:00:00.000Z");
    expect(cinemaDate("2030-06-03T21:00:00+04:00").toISOString()).toBe("2030-06-03T17:00:00.000Z");
    expect(cinemaDate("2030-06-03T21:00:00.125").toISOString()).toBe("2030-06-03T17:00:00.125Z");
  });
  it("leaves invalid values detectable for the existing text fallback", () => {
    expect(Number.isNaN(cinemaDate("unknown").getTime())).toBe(true);
  });
});
