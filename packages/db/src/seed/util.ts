/** Deterministic helpers so every seed run yields identical demo data. */
export function prng(seedStr: string) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min: number, max: number): number {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(this.next() * arr.length)]!;
    },
    chance(p: number): boolean {
      return this.next() < p;
    },
  };
}

export const EXPERIENCE_CODE: Record<string, string> = {
  Standard: "STD",
  MAX: "MAX",
  GOLD: "VG",
  KIDS: "KIDS",
  "4DX": "4DX",
  THEATRE: "THR",
  IMAX: "IMAX",
  Premier: "PRM",
  Premium: "PVW",
  Couch: "CCH",
  Outdoor: "OTDR",
  Private: "PRV",
  Other: "OTH",
};

export const EXPERIENCE_NAME_AR: Record<string, string> = {
  Standard: "ستاندرد",
  MAX: "ماكس",
  GOLD: "غولد",
  KIDS: "كيدز",
  "4DX": "4DX",
  THEATRE: "ثياتر",
  IMAX: "آيماكس",
  Premier: "بريمير",
  Premium: "بريميوم",
  Couch: "كاوتش",
  Outdoor: "أوت دور",
  Private: "سينما خاصة",
  Other: "أخرى",
};

/** Local wall-clock "now" in the cinema timezone as an ISO string without offset. */
export function nowLocalIso(timeZone = "Asia/Dubai", at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}:${g("second")}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19);
}
export function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(`${iso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19);
}
