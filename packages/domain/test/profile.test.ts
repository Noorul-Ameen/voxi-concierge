import { describe, expect, it } from "vitest";
import {
  inferCustomerProfile,
  localShowtime,
  preferenceCalendar,
  scorePreferredTime,
  visitDayType,
} from "../src/profile.js";

describe("history-backed customer preferences", () => {
  const history = [
    { cinemaId: "0013", language: "Tamil", showtime: "2026-09-07T21:00:00", seatPreference: "back" },
    { cinemaId: "0013", language: "Tamil", showtime: "2026-09-08T20:30:00", seatPreference: "back" },
    { cinemaId: "0013", language: "Tamil", showtime: "2026-09-05T17:45:00", seatPreference: "back" },
    { cinemaId: "0002", language: "English", showtime: "2026-09-06T18:15:00", seatPreference: "middle" },
  ];
  it("derives one language, one cinema and independent weekday/weekend windows", () => {
    const profile = inferCustomerProfile(history);
    expect(profile.movieLanguage).toBe("Tamil");
    expect(profile.cinemaId).toBe("0013");
    expect(profile.seatPreference).toBe("back");
    expect(profile.weekday).toEqual({ around: "20:45", from: "19:45", to: "21:45", sampleCount: 2 });
    expect(profile.weekend).toEqual({ around: "18:00", from: "17:00", to: "19:00", sampleCount: 2 });
  });
  it("uses recency only to break equal-frequency preferences", () => {
    expect(inferCustomerProfile(history.slice(2)).cinemaId).toBe("0002");
  });
  it("excludes future and invalid records and does not invent missing timing preferences", () => {
    const profile = inferCustomerProfile(
      [...history, { cinemaId: "bad", language: "Arabic", showtime: "invalid" }],
      preferenceCalendar(),
      "2026-09-06T00:00:00",
    );
    expect(profile.historyCount).toBe(1);
    expect(profile.weekday).toBeNull();
    expect(inferCustomerProfile([]).movieLanguage).toBeNull();
  });
  it("uses configurable weekends and converts zoned timestamps to Dubai wall time", () => {
    expect(visitDayType("2026-09-06T18:00:00")).toBe("weekend");
    expect(visitDayType("2026-09-06T18:00:00", preferenceCalendar({ VOX_WEEKEND_DAYS: "5,6" }))).toBe(
      "weekday",
    );
    expect(localShowtime("2026-09-06T17:00:00Z")).toBe("2026-09-06T21:00:00");
    expect(localShowtime("2026-09-06T17:00:00")).toBe("2026-09-06T17:00:00");
  });
  it("gives separate soft timing scores instead of rejecting nonusual times", () => {
    const profile = inferCustomerProfile(history);
    expect(scorePreferredTime("2026-09-12T18:00:00", profile)).toBeGreaterThan(
      scorePreferredTime("2026-09-12T21:00:00", profile),
    );
    expect(scorePreferredTime("2026-09-14T20:45:00", profile)).toBeGreaterThan(
      scorePreferredTime("2026-09-14T18:00:00", profile),
    );
  });
});

it("infers preferred experience from actual visit frequency, breaking ties by recency", () => {
  const visits = [
    { cinemaId: "0002", language: "English", experience: "IMAX", showtime: "2026-09-01T20:00:00" },
    { cinemaId: "0002", language: "English", experience: "Standard", showtime: "2026-09-02T20:00:00" },
    { cinemaId: "0002", language: "English", experience: "IMAX", showtime: "2026-09-03T20:00:00" },
  ];
  expect(inferCustomerProfile(visits).preferredExperience).toBe("IMAX");
  expect(inferCustomerProfile(visits.slice(0, 2)).preferredExperience).toBe("Standard");
  expect(inferCustomerProfile([]).preferredExperience).toBeNull();
});
