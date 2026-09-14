import { describe, expect, it } from "vitest";
import { evaluateAdmission } from "../src/services/admission.js";

describe("shared admission evaluation", () => {
  it("retains every supported film threshold without treating provisional labels as all-ages", () => {
    for (const [rating, minimumAge] of [
      ["G", 0],
      ["PG", 0],
      ["PG13", 0],
      ["PG15", 0],
      ["15+", 15],
      ["18+", 18],
      ["18TC", 18],
      ["21+", 21],
    ] as const) {
      const atBoundary = evaluateAdmission(rating, "Premier", minimumAge);
      expect(atBoundary, rating).toMatchObject({
        allowed: true,
        filmAllowed: true,
        minimumAge,
        checkedChildAge: minimumAge,
        rule: { known: true, minimumAge, provisional: rating === "18TC" },
      });
      expect(atBoundary.experienceAdmission).toBeUndefined();
      if (minimumAge > 0) {
        expect(evaluateAdmission(rating, "Premier", minimumAge - 1), rating).toMatchObject({
          allowed: false,
          filmAllowed: false,
        });
      }
    }
  });

  it("preserves inclusive PG13 and PG15 accompaniment boundaries", () => {
    for (const [rating, guidanceAge] of [
      ["PG13", 13],
      ["PG15", 15],
    ] as const) {
      for (const age of [7, guidanceAge]) {
        expect(evaluateAdmission(rating, undefined, age)).toMatchObject({
          allowed: true,
          minimumAge: 0,
          guidanceAge,
          filmAccompanimentRequired: true,
        });
      }
      expect(evaluateAdmission(rating, undefined, guidanceAge + 1).filmAccompanimentRequired).toBe(false);
    }
    expect(evaluateAdmission("PG", undefined, 7).filmAccompanimentRequired).toBe(false);
  });

  it.each(["GOLD", "THEATRE"] as const)(
    "combines %s and film conditions without overriding either",
    (experience) => {
      const below = evaluateAdmission("G", experience, 4);
      expect(below).toMatchObject({
        allowed: false,
        filmAllowed: true,
        minimumAge: 5,
        experienceBlocked: true,
        experienceAdmission: { meetsMinimumAge: false, parentOrGuardianRequired: false },
      });
      for (const age of [5, 18]) {
        expect(evaluateAdmission("G", experience, age)).toMatchObject({
          allowed: true,
          minimumAge: 5,
          experienceAdmission: {
            experience,
            meetsMinimumAge: true,
            parentOrGuardianRequired: true,
            accompanimentThroughAge: 18,
            subjectToFilmRating: true,
          },
        });
      }
      expect(evaluateAdmission("G", experience, 19).experienceAdmission?.parentOrGuardianRequired).toBe(
        false,
      );
      expect(evaluateAdmission("PG13", experience, 7)).toMatchObject({
        allowed: true,
        guidanceAge: 13,
        filmAccompanimentRequired: true,
        experienceAdmission: { parentOrGuardianRequired: true },
      });
      expect(evaluateAdmission("18TC", experience, 17)).toMatchObject({
        allowed: false,
        filmAllowed: false,
        minimumAge: 18,
        experienceAdmission: { meetsMinimumAge: true, parentOrGuardianRequired: true },
      });
    },
  );

  it("keeps absent, pending and unsupported ratings unconfirmed unless a screen independently blocks admission", () => {
    for (const rating of [undefined, null, "", "TBC", "15TC", "unknown"]) {
      expect(evaluateAdmission(rating, undefined, 7)).toMatchObject({
        allowed: null,
        filmAllowed: null,
        minimumAge: null,
        checkedChildAge: 7,
        filmAccompanimentRequired: null,
        rule: { known: false },
      });
      expect(evaluateAdmission(rating, "GOLD", 4)).toMatchObject({
        allowed: false,
        filmAllowed: null,
        minimumAge: 5,
      });
      expect(evaluateAdmission(rating, "GOLD", 5)).toMatchObject({
        allowed: null,
        filmAllowed: null,
        minimumAge: null,
        experienceAdmission: { meetsMinimumAge: true, parentOrGuardianRequired: true },
      });
    }
  });

  it("does not infer an unsupplied child's age from a known rating or experience", () => {
    for (const age of [undefined, null]) {
      expect(evaluateAdmission("PG13", "THEATRE", age)).toMatchObject({
        allowed: null,
        filmAllowed: null,
        checkedChildAge: null,
        minimumAge: 5,
        guidanceAge: 13,
        filmAccompanimentRequired: null,
        experienceAdmission: { meetsMinimumAge: null, parentOrGuardianRequired: null },
      });
    }
  });

  it("retains classification normalization and only the existing restricted experience names", () => {
    expect(evaluateAdmission(" pg 13 ", "GOLD", 7)).toMatchObject({
      rule: { code: "PG13", known: true },
      allowed: true,
      guidanceAge: 13,
    });
    for (const experience of [undefined, "Standard", "KIDS", "4DX", "Private", "gold", "Other"]) {
      expect(evaluateAdmission("G", experience, 4)).toMatchObject({
        allowed: true,
        minimumAge: 0,
        restrictedExperience: false,
        experienceBlocked: false,
      });
      expect(evaluateAdmission("G", experience, 4).experienceAdmission).toBeUndefined();
    }
  });
});
