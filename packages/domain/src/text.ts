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

export function bestMatch<T>(query: string, items: T[], keys: (t: T) => string[], threshold = 0.45): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const it of items) {
    const score = Math.max(...keys(it).filter(Boolean).map((k) => similarity(query, k)));
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
