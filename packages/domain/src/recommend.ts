/** Personalisation: score films/sessions/F&B against profile preferences and purchase history. Pure. */
export type Prefs = { genres?: string[]; languages?: string[]; experiences?: string[]; cinemas?: string[]; timeOfDay?: string[]; days?: string[]; dietary?: string[] };
export type HistoryItem = { hoCode?: string | null; genres: string[]; language: string; experience: string; cinemaId: string; showtime: string; concessionItemIds: string[] };
export type FilmLite = { hoCode: string; title: string; genreNames: string[]; language: string; rating: string; status: string; openingDate?: string | null };
export type SessionLite = { cinemaId: string; hoCode: string; experience: string; showtime: string; seatsAvailable: number };

function tally(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}
const slot = (iso: string) => {
  const h = Number(iso.slice(11, 13));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "late";
};
const dayType = (iso: string) => ([5, 6].includes(new Date(`${iso}Z`).getUTCDay()) ? "weekend" : "weekday");

export function buildTasteProfile(prefs: Prefs, history: HistoryItem[]) {
  const genres = tally([...(prefs.genres ?? []).flatMap((g) => [g, g]), ...history.flatMap((h) => h.genres)]);
  const languages = tally([...(prefs.languages ?? []).flatMap((l) => [l, l]), ...history.map((h) => h.language)]);
  const experiences = tally([...(prefs.experiences ?? []).flatMap((e) => [e, e]), ...history.map((h) => h.experience)]);
  const cinemas = tally([...(prefs.cinemas ?? []).flatMap((c) => [c, c]), ...history.map((h) => h.cinemaId)]);
  const slots = tally([...(prefs.timeOfDay ?? []), ...history.map((h) => slot(h.showtime))]);
  const days = tally([...(prefs.days ?? []), ...history.map((h) => dayType(h.showtime))]);
  const items = tally(history.flatMap((h) => h.concessionItemIds));
  const seen = new Set(history.map((h) => h.hoCode).filter(Boolean) as string[]);
  const top = (m: Map<string, number>, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return { genres, languages, experiences, cinemas, slots, days, items, seen, summary: { genres: top(genres), languages: top(languages, 2), experiences: top(experiences, 2), cinemas: top(cinemas, 2), slots: top(slots, 1), days: top(days, 1) } };
}

export function scoreFilm(f: FilmLite, p: ReturnType<typeof buildTasteProfile>): { score: number; why: string[] } {
  let score = 0;
  const why: string[] = [];
  const g = f.genreNames.reduce((a, x) => a + (p.genres.get(x) ?? 0), 0);
  if (g) {
    score += Math.min(6, g);
    why.push(`you enjoy ${f.genreNames.filter((x) => p.genres.get(x)).join("/")}`);
  }
  const l = p.languages.get(f.language) ?? 0;
  if (l) {
    score += Math.min(4, l);
    why.push(`${f.language}-language`);
  } else if (p.languages.size && !p.languages.get(f.language)) score -= 3;
  if (p.seen.has(f.hoCode)) {
    score -= 10;
    why.push("already watched");
  }
  if (f.status === "now_showing") score += 1;
  return { score, why };
}

export function scoreSession(s: SessionLite, p: ReturnType<typeof buildTasteProfile>): number {
  let score = 0;
  score += Math.min(3, p.experiences.get(s.experience) ?? 0);
  score += Math.min(3, p.cinemas.get(s.cinemaId) ?? 0);
  score += Math.min(2, p.slots.get(slot(s.showtime)) ?? 0);
  score += Math.min(1, p.days.get(dayType(s.showtime)) ?? 0);
  if (s.seatsAvailable < 4) score -= 2;
  return score;
}

export function recommendFilms(films: FilmLite[], p: ReturnType<typeof buildTasteProfile>, limit = 4) {
  return films
    .map((f) => ({ film: f, ...scoreFilm(f, p) }))
    .filter((x) => !p.seen.has(x.film.hoCode))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function recommendConcessions<T extends { id: string; dietaryTags: string[]; isBestSeller: boolean; experiences: string[]; tab: string }>(items: T[], p: ReturnType<typeof buildTasteProfile>, prefs: Prefs, experience?: string, limit = 3) {
  const dietary = prefs.dietary ?? [];
  return items
    .filter((i) => !i.experiences.length || !experience || i.experiences.includes(experience))
    .filter((i) => dietary.every((d) => i.dietaryTags.includes(d)))
    .map((i) => ({ item: i, score: (p.items.get(i.id) ?? 0) * 3 + (i.isBestSeller ? 2 : 0) + (i.tab === "Combos" ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
