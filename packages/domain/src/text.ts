/** Fuzzy matching helpers for names spoken by customers (cinemas, films). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْ]/g, "") // Arabic diacritics
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|vox|cinemas?|mall|at|in|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Dice coefficient on bigrams + token containment bonus; 0..1 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.92;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let inter = 0;
  for (const x of ba) if (bb.has(x)) inter++;
  const dice = (2 * inter) / (ba.size + bb.size);
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let tok = 0;
  for (const x of ta) if (tb.has(x)) tok++;
  return Math.max(dice, tok / Math.max(ta.size, tb.size));
}

export function bestMatch<T>(
  query: string,
  items: T[],
  keys: (t: T) => string[],
  threshold = 0.45,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const it of items) {
    const score = Math.max(
      ...keys(it)
        .filter(Boolean)
        .map((k) => similarity(query, k)),
    );
    if (score >= threshold && (!best || score > best.score)) best = { item: it, score };
  }
  return best;
}

/** Common spoken aliases for VOX UAE cinemas. */
export const CINEMA_ALIASES: Record<string, string[]> = {
  "0002": ["MOE", "Mall of Emirates", "Emirates Mall", "مول الامارات"],
  "0001": ["Deira", "DCC", "Deira City Centre", "ديرة"],
  "0005": ["Mirdif", "MCC", "مردف"],
  "0046": ["Galleria", "Al Maryah", "Maryah Island", "الغاليريا"],
  "0012": ["Yas", "Yas Mall", "ياس"],
  "0049": ["Palm", "Nakheel Mall", "Palm Jumeirah", "النخلة"],
  "0105": ["Festival City", "DFC", "فستيفال سيتي"],
  "0013": ["Burjuman", "Bur Juman", "برجمان"],
  "0035": ["Sharjah", "Sharjah City Centre", "الشارقة"],
  "0055": ["Al Zahia", "Zahia", "الزاهية"],
  "0004": ["Ajman", "عجمان"],
  "0006": ["Fujairah", "الفجيرة"],
  "0017": ["Shindagha", "الشندغة"],
  "0007": ["Mercato", "ميركاتو"],
  "0014": ["Nation Towers", "Corniche", "نيشن تاورز"],
  "0036": ["Abu Dhabi Mall", "ابوظبي مول"],
  "0009": ["Al Hamra", "RAK", "Ras Al Khaimah", "الحمرا"],
  "0039": ["Al Jimi", "Al Ain", "الجيمي"],
  "0015": ["Megaplex", "Grand Hyatt", "ميغابلكس"],
  "0045": ["Kempinski", "كمبينسكي"],
  "0057": ["Wafi", "وافي"],
  "0104": ["Reem Mall", "Reem Island", "ريم مول"],
};

/**
 * Resolve a spoken date ("today", "tomorrow", "friday", "weekend", or YYYY-MM-DD) against a cinema-local ISO timestamp.
 * Returns YYYY-MM-DD. Weekday names resolve to the next occurrence (today counts if it is that weekday).
 * "weekend" resolves to the coming Saturday (UAE weekend: Sat/Sun); "next weekend" adds a week.
 */
export function resolveSpokenDate(word: string | undefined, nowLocalIso: string): string {
  const today = nowLocalIso.slice(0, 10);
  if (!word) return today;
  const w = word.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const add = (d: number) => {
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + d);
    return t.toISOString().slice(0, 10);
  };
  if (w === "today" || w === "tonight") return today;
  if (w === "tomorrow") return add(1);
  if (w === "day after tomorrow") return add(2);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun
  if (/weekend$/.test(w)) {
    const toSat = (6 - dow + 7) % 7;
    return add(toSat + (w.startsWith("next") ? 7 : 0));
  }
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const m = w.match(/^(next )?(\w+day)$/);
  if (m) {
    const target = names.indexOf(m[2] ?? "");
    if (target >= 0) {
      let diff = (target - dow + 7) % 7;
      if (m[1]) diff += diff === 0 ? 7 : 0;
      return add(diff);
    }
  }
  return today;
}

/** Spoken language names/codes → catalogue language (so "ta" and "Tamil" both match). */
const LANG_NAMES: Record<string, string> = {
  ta: "Tamil",
  tamil: "Tamil",
  hi: "Hindi",
  hindi: "Hindi",
  ml: "Malayalam",
  malayalam: "Malayalam",
  te: "Telugu",
  telugu: "Telugu",
  kn: "Kannada",
  kannada: "Kannada",
  ar: "Arabic",
  arabic: "Arabic",
  العربية: "Arabic",
  en: "English",
  english: "English",
  ur: "Urdu",
  urdu: "Urdu",
  tl: "Tagalog",
  tagalog: "Tagalog",
  filipino: "Tagalog",
  fr: "French",
  french: "French",
  ko: "Korean",
  korean: "Korean",
  ja: "Japanese",
  japanese: "Japanese",
  ru: "Russian",
  russian: "Russian",
  pa: "Punjabi",
  punjabi: "Punjabi",
  bn: "Bengali",
  bengali: "Bengali",
  tr: "Turkish",
  turkish: "Turkish",
  es: "Spanish",
  spanish: "Spanish",
};
export function normaliseFilmLanguage(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const k = v.trim().toLowerCase();
  return LANG_NAMES[k] ?? v.trim();
}

/** UAE emirates (and common spellings) → canonical emirate name as stored on cinemas. */
const EMIRATES: [RegExp, string][] = [
  [/^(dubai|دبي|dxb)$/i, "Dubai"],
  [/^(abu ?dhabi|أبو ?ظبي|ابوظبي|auh)$/i, "Abu Dhabi"],
  [/^(sharjah|الشارقة|shj)$/i, "Sharjah"],
  [/^(ajman|عجمان)$/i, "Ajman"],
  [/^(fujairah|الفجيرة)$/i, "Fujairah"],
  [/^(ras ?al ?khaimah|rak|رأس الخيمة|راس الخيمة)$/i, "Ras Al Khaimah"],
  [/^(umm ?al ?quwain|uaq|أم القيوين)$/i, "Umm Al Quwain"],
];
export function asEmirate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^(in|at)\s+/i, "");
  for (const [re, name] of EMIRATES) if (re.test(s)) return name;
  return undefined;
}

/** For range words ("weekend", "this weekend", "next weekend") the natural end date is the Sunday. */
export function spokenDateRangeEnd(word: string | undefined, startIso: string): string {
  if (word && /weekend$/i.test(word.trim())) {
    const t = new Date(`${startIso}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  }
  return startIso;
}
