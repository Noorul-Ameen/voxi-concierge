/** Speech/text formatting helpers (EN/AR). All times are cinema-local ISO strings without offset. */
import type { Language } from "@voxi/contracts";

export const money = (cents: number, lang: Language = "en", currency = "AED") => {
  const v = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return lang === "ar" ? `${v} درهم` : `AED ${v}`;
};

const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_AR = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

export function fmtTime(iso: string, lang: Language = "en"): string {
  const h = Number(iso.slice(11, 13));
  const m = iso.slice(14, 16);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (lang === "ar") return `${h12}:${m} ${h < 12 ? "صباحاً" : "مساءً"}`;
  return `${h12}:${m} ${h < 12 ? "am" : "pm"}`;
}

export function fmtDate(iso: string, lang: Language = "en", todayIso?: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (todayIso) {
    const t = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
    const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
    if (diff === 0) return lang === "ar" ? "اليوم" : "today";
    if (diff === 1) return lang === "ar" ? "غداً" : "tomorrow";
  }
  const day = d.getUTCDay();
  return lang === "ar"
    ? `${DAYS_AR[day]} ${d.getUTCDate()} ${MONTHS_AR[d.getUTCMonth()]}`
    : `${DAYS_EN[day]} ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]}`;
}

export function fmtDateTime(iso: string, lang: Language = "en", todayIso?: string): string {
  return lang === "ar"
    ? `${fmtDate(iso, lang, todayIso)} الساعة ${fmtTime(iso, lang)}`
    : `${fmtDate(iso, lang, todayIso)} at ${fmtTime(iso, lang)}`;
}

export function fmtMinutes(min: number, lang: Language = "en"): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (lang === "ar") return h ? `${h} س ${m ? `${m} د` : ""}`.trim() : `${m} د`;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** Join a list naturally: "A, B and C" */
export function joinList(items: string[], lang: Language = "en"): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0]!;
  const conj = lang === "ar" ? " و" : " and ";
  return `${items.slice(0, -1).join(lang === "ar" ? "، " : ", ")}${conj}${items[items.length - 1]}`;
}

export const t = (lang: Language, en: string, ar: string) => (lang === "ar" ? ar : en);

/** Deterministic seat label list e.g. "F7, F8" */
export const seatLabels = (tickets: { SeatRowId?: string | null; SeatNumber?: string | null }[]) =>
  tickets
    .map((t) => (t.SeatRowId ? `${t.SeatRowId}${t.SeatNumber}` : ""))
    .filter(Boolean)
    .join(", ");
