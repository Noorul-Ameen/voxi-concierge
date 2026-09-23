import { describe, expect, it } from "vitest";
import { filmBadges, showtimeBadges } from "../src/services/badges.js";

const ctx = { lang: "en" } as any;

describe("reason badges", () => {
  it("marks only true facts on showtimes: one roomiest show, scarce shows and the customer's usual time", () => {
    const items = [
      { sessionKey: "a", showtime: "2026-09-23T19:15:00", seatsAvailable: 120, experience: "IMAX" },
      { sessionKey: "b", showtime: "2026-09-23T20:45:00", seatsAvailable: 6, experience: "4DX" },
      { sessionKey: "c", showtime: "2026-09-23T22:10:00", seatsAvailable: 40, experience: "Standard" },
      {
        sessionKey: "d",
        showtime: "2026-09-23T23:00:00",
        seatsAvailable: 0,
        soldOut: true,
        experience: "Standard",
      },
    ];
    const habit = { weekday: { from: "20:00", to: "21:30" }, weekend: null, weekendDays: [6, 0] };
    const out = showtimeBadges(ctx, items, habit);
    expect(out[0]!.badges).toEqual([{ kind: "rec", label: "Most seats free", icon: "star" }]);
    expect(out[1]!.badges.map((b) => b.label)).toEqual(["Only 6 left", "Your usual time"]);
    expect(out[2]!.badges).toEqual([]);
    expect(out[3]!.badges).toEqual([]);
  });

  it("gives no 'most seats' badge when shows are tied or nearly full", () => {
    const out = showtimeBadges(
      ctx,
      [
        { sessionKey: "a", seatsAvailable: 50 },
        { sessionKey: "b", seatsAvailable: 50 },
      ],
      null,
    );
    expect(out.every((s) => s.badges.length === 0)).toBe(true);
  });

  it("leads a recommendation with Best match and explains taste matches", () => {
    const out = filmBadges(
      ctx,
      [
        { hoCode: "1", why: ["you enjoy Horror"] },
        { hoCode: "2", why: [] },
      ],
      true,
    );
    expect(out[0]!.badges.map((b: any) => b.label)).toEqual(["Best match", "Like films you've seen"]);
    expect(out[1]!.badges).toBeUndefined();
  });
});
