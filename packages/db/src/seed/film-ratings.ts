/** Refresh captured classifications only; never reseed the catalogue or commerce/customer data. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { films } from "../schema/reference.js";
import { AGE_RULES } from "./catalog.js";

export function capturedFilmClassification(value: unknown) {
  if (typeof value !== "string") return null;
  const rating = value.replace(/\s+/g, "").toUpperCase();
  const rule = AGE_RULES.find((candidate) => candidate.rating === rating);
  return rule ? { rating: rule.rating, ratingDescription: rule.text } : null;
}

// Shared with the normal reference seed: an empty/unknown capture cannot erase a known classification.
const validExcludedRating = inArray(
  sql`excluded.rating`,
  AGE_RULES.map((rule) => rule.rating),
);
export const filmClassificationConflictSet = {
  rating: sql<string>`case when ${validExcludedRating} then excluded.rating else ${films.rating} end`,
  ratingDescription: sql<string>`case when ${validExcludedRating} then excluded.rating_description else ${films.ratingDescription} end`,
};

export async function readCapturedFilmSnapshot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "data/vox-uae.json"),
    path.resolve(here, "../../src/seed/data/vox-uae.json"),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) throw new Error("Captured UAE film catalogue is missing");
  return JSON.parse(await readFile(source, "utf8")) as unknown;
}

type CapturedFilm = {
  hoCode: string;
  title: string;
  slug: string;
  rating: string;
  ratingDescription: string;
};
export function capturedFilmRatings(snapshot: unknown): CapturedFilm[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const source = snapshot as { capturedAt?: unknown; films?: unknown };
  if (
    typeof source.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(source.capturedAt)) ||
    !Array.isArray(source.films)
  )
    return [];
  const counts = new Map<unknown, number>();
  for (const raw of source.films) {
    const id = raw && typeof raw === "object" ? raw.hoCode : undefined;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return source.films.flatMap((raw): CapturedFilm[] => {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.hoCode !== "string" ||
      !/^HO\d{8}$/.test(raw.hoCode) ||
      counts.get(raw.hoCode) !== 1 ||
      typeof raw.title !== "string" ||
      !raw.title.trim() ||
      typeof raw.slug !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.slug)
    )
      return [];
    const classification = capturedFilmClassification(raw.rating);
    if (!classification) return [];
    // A real captured VOX film identity is required; arbitrary records cannot act as an update source.
    if (raw.websiteUrl !== `https://uae.voxcinemas.com/movies/${raw.slug}`) return [];
    return [{ hoCode: raw.hoCode, title: raw.title, slug: raw.slug, ...classification }];
  });
}

export async function syncCapturedFilmRatings(db: Pick<Db, "update">, snapshot?: unknown) {
  const candidates = capturedFilmRatings(snapshot ?? (await readCapturedFilmSnapshot()));
  let updated = 0;
  for (const film of candidates) {
    const changed = await db
      .update(films)
      .set({ rating: film.rating, ratingDescription: film.ratingDescription })
      .where(
        and(
          eq(films.hoCode, film.hoCode),
          eq(films.slug, film.slug),
          eq(films.title, film.title),
          or(
            sql`${films.rating} is distinct from ${film.rating}`,
            sql`${films.ratingDescription} is distinct from ${film.ratingDescription}`,
          ),
        ),
      )
      .returning({ hoCode: films.hoCode });
    updated += changed.length;
  }
  return { captured: candidates.length, updated };
}
