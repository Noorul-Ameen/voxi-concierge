import { describe, expect, it } from "vitest";
import { movieTools } from "../src/tools/movies.js";
import type { ToolCtx } from "../src/tools/types.js";

const context = (lang: "en" | "ar") =>
  ({ lang, db: { select: () => ({ from: async () => [] }) } }) as unknown as ToolCtx;

describe.each(["GOLD", "THEATRE"] as const)("%s admission evidence", (experience) => {
  it.each(["en", "ar"] as const)("combines film and screen boundaries in %s", async (lang) => {
    for (const [rating, childAge, allowed, filmAllowed, minimumAge] of [
      ["G", 4, false, true, 5],
      ["G", 5, true, true, 5],
      ["PG13", 7, true, true, 5],
      ["18TC", 17, false, false, 18],
      ["18TC", 18, true, true, 18],
      ["TBC", 5, null, null, null],
      ["15TC", 5, null, null, null],
    ] as const) {
      const result = await movieTools.get_age_rules(context(lang), { experience, rating, childAge });
      expect(result.data, `${rating}/${childAge}`).toMatchObject({
        allowed,
        filmAllowed,
        minimumAge,
        filmMinimumAge: ["G", "PG13"].includes(rating) ? 0 : rating === "18TC" ? 18 : null,
        experienceAdmission: {
          experience,
          minimumAge: 5,
          meetsMinimumAge: childAge >= 5,
          parentOrGuardianRequired: childAge >= 5 && childAge <= 18,
          accompanimentThroughAge: 18,
          subjectToFilmRating: true,
          source: expect.stringContaining("https://uae.voxcinemas.com/"),
        },
      });
      if (allowed === false) {
        expect(result.speech).toMatch(lang === "en" ? /^No/ : /^لا/);
        expect(result.speech).not.toMatch(lang === "en" ? /under 0|^Yes/ : /دون 0|^نعم/);
        expect(result.speech).toContain(childAge < 5 ? "5" : "18");
      } else if (allowed === null) {
        expect(result.speech).toContain(
          lang === "en" ? "cannot confirm admission" : "لا يمكنني تأكيد السماح",
        );
      } else {
        expect(result.speech).toMatch(lang === "en" ? /^Yes/ : /^نعم/);
        expect(result.speech).toContain(lang === "en" ? "parent or guardian" : "أحد الوالدين أو الوصي");
        if (rating === "PG13") expect(result.speech).toContain("13");
      }
    }
    const adult = await movieTools.get_age_rules(context(lang), { experience, rating: "G", childAge: 19 });
    expect(adult.data?.experienceAdmission.parentOrGuardianRequired).toBe(false);
    expect(adult.data?.allowed).toBe(true);
  });

  it.each(["en", "ar"] as const)(
    "does not confuse experience-only evidence with a film classification in %s",
    async (lang) => {
      const underFive = await movieTools.get_age_rules(context(lang), { experience, childAge: 4 });
      expect(underFive.data).toMatchObject({
        allowed: false,
        filmAllowed: null,
        minimumAge: 5,
        filmMinimumAge: null,
        classificationKnown: false,
      });
      expect(underFive.speech).toMatch(lang === "en" ? /^No/ : /^لا/);
      expect(underFive.speech).not.toMatch(/undefined|unconfirmed film|التصنيف undefined/);
      const unknownFilm = await movieTools.get_age_rules(context(lang), { experience, childAge: 5 });
      expect(unknownFilm.data).toMatchObject({
        allowed: null,
        minimumAge: null,
        experienceAdmission: { meetsMinimumAge: true, parentOrGuardianRequired: true },
      });
      expect(unknownFilm.speech).toContain(
        lang === "en" ? "cannot confirm film admission" : "لا يمكنني تأكيد السماح بمشاهدة الفيلم",
      );
      const advice = await movieTools.get_age_rules(context(lang), { experience });
      expect(advice.data).toMatchObject({
        allowed: null,
        experienceAdmission: { meetsMinimumAge: null, parentOrGuardianRequired: null },
      });
      expect(advice.speech).toBe(advice.data?.experienceRule);
      expect(advice.speech).toContain(lang === "en" ? "under 5" : "دون 5");
      expect(advice.speech).not.toMatch(/18\+|18 and over|8\+|Mall of the Emirates/);
    },
  );
});

it("keeps ordinary film admission and unrelated experience advice unchanged", async () => {
  const film = await movieTools.get_age_rules(context("en"), { rating: "G", childAge: 4 });
  const standard = await movieTools.get_age_rules(context("en"), {
    rating: "G",
    childAge: 4,
    experience: "Standard",
  });
  expect(standard).toEqual(film);
  expect(film.data).toMatchObject({ allowed: true, minimumAge: 0 });
  expect(film.data?.experienceAdmission).toBeUndefined();
  const fourDx = await movieTools.get_age_rules(context("en"), { experience: "4DX" });
  expect(fourDx.speech).toContain("minimum height of 100 cm");
  expect(fourDx.data?.experienceAdmission).toBeUndefined();
});
