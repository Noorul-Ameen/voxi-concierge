import { describe, expect, it } from "vitest";
import {
  GUEST_GREETING_COUNT,
  NAMED_GREETING_COUNT,
  greetings,
  nextGreetingVariant,
} from "../src/greetings.js";

describe("member welcome copy", () => {
  it("rotates through a large pool of paired English/Arabic welcomes without claiming account details", () => {
    expect(NAMED_GREETING_COUNT).toBeGreaterThanOrEqual(60);
    const variants = Array.from({ length: NAMED_GREETING_COUNT }, (_, i) =>
      greetings("Sara", i, { hour: 20 }),
    );
    expect(new Set(variants.map((value) => value.greetingEn)).size).toBe(NAMED_GREETING_COUNT);
    expect(new Set(variants.map((value) => value.greetingAr)).size).toBe(NAMED_GREETING_COUNT);
    for (const value of variants) {
      expect(value.firstName).toBe("Sara");
      expect(value.greetingEn).toContain(value.welcomeEn);
      expect(value.greetingAr).toContain(value.welcomeAr);
      expect(value.greetingEn).toContain("Sara");
      expect(value.greetingAr).toContain("Sara");
      expect(JSON.stringify(value)).not.toMatch(/balance|points|Premier|Mall|card|email|password|رصيد|نقاط/);
    }
    expect(greetings("Sara", NAMED_GREETING_COUNT, { hour: 20 })).toEqual(variants[0]);
  });

  it("matches the time of day", () => {
    expect(greetings("Sara", 4, { hour: 9 }).welcomeEn).toBe("Good morning, Sara!");
    expect(greetings("Sara", 4, { hour: 14 }).welcomeEn).toBe("Good afternoon, Sara!");
    expect(greetings("Sara", 4, { hour: 21 }).welcomeEn).toBe("Good evening, Sara!");
    expect(greetings("Sara", 4, { hour: 21 }).welcomeAr).toBe("مساء الخير يا Sara!");
    expect(greetings("Sara", 4).welcomeEn).toBe("Hello, Sara!");
  });

  it("mentions a booking later today on some visits only, in both languages", () => {
    const booking = { filmTitle: "Red Flag", timeEn: "7:00 pm", timeAr: "7:00 مساءً" };
    const withBooking = greetings("Sara", 0, { hour: 18, todayBooking: booking });
    expect(withBooking.greetingEn).toBe(
      "Welcome back, Sara! All set for Red Flag at 7:00 pm today? Let me know if you need anything for it.",
    );
    expect(withBooking.greetingAr).toContain("Red Flag");
    expect(withBooking.greetingAr).toContain("7:00 مساءً");
    expect(greetings("Sara", 1, { hour: 18, todayBooking: booking }).greetingEn).not.toContain("Red Flag");
    expect(greetings("Sara", 0, { hour: 18, todayBooking: null })).toEqual(
      greetings("Sara", 0, { hour: 18 }),
    );
  });

  it.each([undefined, null, "", "  \n  "])("keeps nameless guests generic but varied: %s", (name) => {
    const result = greetings(name, 3, { hour: 20 });
    expect(result.firstName).toBe("");
    expect(result.greetingEn).not.toMatch(/back|again/);
    expect(result.greetingAr).not.toContain("عودتك");
    const all = Array.from(
      { length: GUEST_GREETING_COUNT },
      (_, i) => greetings(name, i, { hour: 20 }).greetingEn,
    );
    expect(new Set(all).size).toBe(GUEST_GREETING_COUNT);
    expect(greetings(name, 0).greetingEn).toBe(
      "Hi, welcome to VOX Cinemas. What are you in the mood to watch?",
    );
  });

  it("uses readable account names and safely defaults an invalid rotation index", () => {
    expect(greetings("  سارة\n  ", Number.NaN)).toEqual(greetings("سارة", 0));
    expect(greetings("Sara", -1)).toEqual(greetings("Sara", 0));
    expect(greetings("Sara", 1.5)).toEqual(greetings("Sara", 0));
  });

  it("never repeats one of the last five greetings and honours a free preferred slot", () => {
    expect(nextGreetingVariant([], 60)).toBe(0);
    expect(nextGreetingVariant([0], 60)).toBe(1);
    expect(nextGreetingVariant([4, 3, 2, 1, 0], 60)).toBe(5);
    expect(nextGreetingVariant([59, 58, 57, 56, 55], 60)).toBe(0);
    expect(nextGreetingVariant([2, 1, 0], 60, 1)).toBe(3);
    expect(nextGreetingVariant([2, 1, 0], 60, 7)).toBe(7);
    // Only the five most recent are avoided; a tiny pool still returns something.
    expect(nextGreetingVariant([0, 1, 2, 3, 4, 5], 6)).toBe(5);
  });
});
