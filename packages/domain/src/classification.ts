/** UAE classifications supported by this demo. Unrecognised values are not all-ages. */
export const RATINGS = ["G", "PG", "PG13", "PG15", "15+", "18+", "18TC", "21+"] as const;
const minimumAges: Record<string, number> = {
  G: 0,
  PG: 0,
  PG13: 0,
  PG15: 0,
  "15+": 15,
  "18+": 18,
  "18TC": 18,
  "21+": 21,
};

export function classification(rating: string | null | undefined) {
  const code = (rating ?? "").replace(/\s+/g, "").toUpperCase();
  const minimumAge = minimumAges[code] ?? null;
  return {
    code,
    known: minimumAge !== null,
    minimumAge,
    provisional: /TC$/.test(code),
    guidanceAge: code === "PG13" ? 13 : code === "PG15" ? 15 : null,
  };
}

/** Child tickets cover ages 3–12; adult-only and unconfirmed classifications cannot qualify. */
export function allowsChildTickets(rating: string | null | undefined) {
  const rule = classification(rating);
  return rule.known && !rule.provisional && rule.minimumAge === 0;
}
