import { classification } from "@voxi/domain";

export interface ExperienceAdmission {
  experience: "GOLD" | "THEATRE";
  minimumAge: number;
  meetsMinimumAge: boolean | null;
  parentOrGuardianRequired: boolean | null;
  accompanimentThroughAge: number;
  subjectToFilmRating: boolean;
  source: string;
}

export interface AdmissionEvaluation {
  rule: ReturnType<typeof classification>;
  checkedChildAge: number | null;
  filmAllowed: boolean | null;
  allowed: boolean | null;
  minimumAge: number | null;
  restrictedExperience: boolean;
  experienceBlocked: boolean;
  experienceAdmission: ExperienceAdmission | undefined;
  guidanceAge: number | null;
  filmAccompanimentRequired: boolean | null;
}

/** Shared numerical admission evidence; unknown film classifications remain unconfirmed. */
export function evaluateAdmission(
  rating: string | undefined | null,
  experience: string | undefined,
  childAge: number | undefined | null,
): AdmissionEvaluation {
  const rule = classification(rating);
  const filmAllowed = childAge != null && rule.minimumAge != null ? childAge >= rule.minimumAge : null;
  const restrictedExperience = experience === "GOLD" || experience === "THEATRE";
  const experienceBlocked = restrictedExperience && childAge != null && childAge < 5;
  const allowed = experienceBlocked ? false : filmAllowed;
  const minimumAge =
    rule.minimumAge != null
      ? Math.max(rule.minimumAge, restrictedExperience ? 5 : 0)
      : experienceBlocked
        ? 5
        : null;
  const experienceAdmission: ExperienceAdmission | undefined = restrictedExperience
    ? {
        experience,
        minimumAge: 5,
        meetsMinimumAge: childAge == null ? null : childAge >= 5,
        parentOrGuardianRequired: childAge == null ? null : childAge >= 5 && childAge <= 18,
        accompanimentThroughAge: 18,
        subjectToFilmRating: true,
        source:
          experience === "THEATRE"
            ? "https://uae.voxcinemas.com/ways-to-watch/theatre"
            : "https://uae.voxcinemas.com/faq",
      }
    : undefined;

  return {
    rule,
    checkedChildAge: childAge ?? null,
    filmAllowed,
    allowed,
    minimumAge,
    restrictedExperience,
    experienceBlocked,
    experienceAdmission,
    guidanceAge: rule.guidanceAge,
    filmAccompanimentRequired:
      childAge == null || !rule.known ? null : rule.guidanceAge != null && childAge <= rule.guidanceAge,
  };
}
