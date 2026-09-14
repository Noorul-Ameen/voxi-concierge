import { readFileSync } from "node:fs";
import { z } from "zod";

// One fixed reference list shared with the standalone widget. Node images retain the repository
// layout (infra/Dockerfile); src/services and dist/services resolve this same packaged resource.
export const locationAreas = z
  .array(
    z.object({
      group: z.string().min(1),
      label: z.string().min(1),
      labelAr: z.string().min(1),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../../apps/web/src/lib/location-areas.json", import.meta.url), "utf8"),
    ),
  );

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\p{L}\p{N}]/gu, "");
const aliases: Record<string, string[]> = {
  "Al Barsha": ["Barsha", "البرشا", "برشاء"],
};
const arabicEmirates: Record<string, string> = { Dubai: "دبي", "Abu Dhabi": "أبوظبي" };

/** Exact supported names only: a fuzzy mall match must never masquerade as area geocoding. */
export function resolveLocationArea(supplied: string) {
  const query = normalize(supplied);
  if (!query) return undefined;
  const matches = locationAreas.filter((area) => {
    const names = [
      area.label,
      area.labelAr,
      ...area.label.split("/"),
      ...area.labelAr.split("/"),
      ...(aliases[area.label] ?? []),
    ];
    return names.some((name) =>
      [name, `${name} ${area.group}`, `${name} ${arabicEmirates[area.group] ?? ""}`].some(
        (candidate) => normalize(candidate) === query,
      ),
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
