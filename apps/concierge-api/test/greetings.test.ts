import { describe, expect, it } from "vitest";
import { greetings } from "../src/greetings.js";

describe("member welcome copy", () => {
  it("rotates four paired English/Arabic welcomes without claiming account details", () => {
    const variants = Array.from({ length: 4 }, (_, i) => greetings("Sara", i));
    expect(new Set(variants.map((value) => value.greetingEn)).size).toBe(4);
    expect(new Set(variants.map((value) => value.greetingAr)).size).toBe(4);
    for (const value of variants) {
      expect(value.firstName).toBe("Sara");
      expect(value.greetingEn).toContain(value.welcomeEn);
      expect(value.greetingAr).toContain(value.welcomeAr);
      expect(value.greetingEn).toContain("Sara");
      expect(value.greetingAr).toContain("Sara");
      expect(JSON.stringify(value)).not.toMatch(/balance|points|Premier|Mall|card|email|password|رصيد|نقاط/);
    }
    expect(greetings("Sara", 4)).toEqual(variants[0]);
  });

  it.each([undefined, null, "", "  \n  "])("keeps nameless guests generic: %s", (name) => {
    const result = greetings(name, 3);
    expect(result.firstName).toBe("");
    expect(result.greetingEn).toBe("Hi, welcome to VOX Cinemas. What are you in the mood to watch?");
    expect(result.greetingAr).not.toContain("عودتك");
    expect(result.greetingEn).not.toMatch(/back|again/);
  });

  it("uses readable account names and safely defaults an invalid rotation index", () => {
    expect(greetings("  سارة\n  ", Number.NaN)).toEqual(greetings("سارة", 0));
    expect(greetings("Sara", -1)).toEqual(greetings("Sara", 0));
    expect(greetings("Sara", 1.5)).toEqual(greetings("Sara", 0));
  });
});
