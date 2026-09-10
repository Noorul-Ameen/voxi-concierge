/** Historical showtimes without an offset are cinema-local wall time, as in Vista. */
export type PreferenceCalendar = { timeZone: string; weekendDays: number[] };
export type SeatPreference = "front" | "middle" | "back" | "aisle";
export type ProfileVisit = {
  language?: string | null;
  cinemaId: string;
  showtime: string;
  seatPreference?: string | null;
};
export type TimingPreference = { from: string; to: string; around: string; sampleCount: number };
export type InferredProfile = {
  movieLanguage: string | null;
  cinemaId: string | null;
  weekday: TimingPreference | null;
  weekend: TimingPreference | null;
  seatPreference: SeatPreference | null;
  historyCount: number;
  timeZone: string;
  weekendDays: number[];
};

export function preferenceCalendar(env: Record<string, string | undefined> = {}): PreferenceCalendar {
  const configured = (env.VOX_WEEKEND_DAYS ?? "6,0").split(",").map(Number);
  const weekendDays = [...new Set(configured)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return { timeZone: "Asia/Dubai", weekendDays: weekendDays.length ? weekendDays : [6, 0] };
}

export function localShowtime(iso: string, calendar = preferenceCalendar()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return null;
  if (!Number.isFinite(Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`))) return null;
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) return iso.slice(0, 19);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

export function visitDayType(local: string, calendar = preferenceCalendar()): "weekday" | "weekend" {
  return calendar.weekendDays.includes(new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay())
    ? "weekend"
    : "weekday";
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Frequency decides preferences; the most recent visit breaks ties. No manually saved preference votes. */
export function inferCustomerProfile(
  history: ProfileVisit[],
  calendar = preferenceCalendar(),
  nowLocal?: string,
): InferredProfile {
  const visits = history
    .flatMap((h) => {
      const local = localShowtime(h.showtime, calendar);
      return local && (!nowLocal || local < nowLocal) ? [{ ...h, local }] : [];
    })
    .sort((a, b) => b.local.localeCompare(a.local));
  const dominant = (values: (string | null | undefined)[]) => {
    const counts = new Map<string, number>();
    for (const value of values)
      if (value?.trim()) counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const timing = (day: "weekday" | "weekend"): TimingPreference | null => {
    const times = visits
      .filter((v) => visitDayType(v.local, calendar) === day)
      .map((v) => clockMinutes(v.local.slice(11, 16)))
      .sort((a, b) => a - b);
    if (!times.length) return null;
    const middle = Math.floor(times.length / 2);
    const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
    const around = Math.min(1439, Math.round(median / 15) * 15);
    return {
      around: hhmm(around),
      from: hhmm(Math.max(0, around - 60)),
      to: hhmm(Math.min(1439, around + 60)),
      sampleCount: times.length,
    };
  };
  const seat = dominant(visits.map((v) => v.seatPreference));
  return {
    movieLanguage: dominant(visits.map((v) => v.language)),
    cinemaId: dominant(visits.map((v) => v.cinemaId)),
    weekday: timing("weekday"),
    weekend: timing("weekend"),
    seatPreference: ["front", "middle", "back", "aisle"].includes(seat ?? "")
      ? (seat as SeatPreference)
      : null,
    historyCount: visits.length,
    timeZone: calendar.timeZone,
    weekendDays: calendar.weekendDays,
  };
}

/** Soft timing signal only: explicit user times are handled by the caller before this score. */
export function scorePreferredTime(showtime: string, profile: InferredProfile): number {
  const local = localShowtime(showtime, profile);
  if (!local) return 0;
  const pref = profile[visitDayType(local, profile)];
  if (!pref) return 0;
  const distance = Math.abs(clockMinutes(local.slice(11, 16)) - clockMinutes(pref.around));
  return Math.max(0, 4 - distance / 60);
}
