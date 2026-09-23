import type { UiHint } from "@voxi/contracts";
import type { ToolCtx, ToolResult } from "../tools/types.js";

/**
 * Reason badges for the widget, computed here from real data so they are always true for the option shown.
 * rec = the single recommended option; few = scarce; usual = matches the customer's own habit; pop = neutral fact.
 * At most two per option; nothing is added when the data isn't there.
 */
export type Badge = { kind: "rec" | "fast" | "save" | "usual" | "few" | "pop"; label: string; icon?: string };

const L = (ctx: ToolCtx, en: string, ar: string) => (ctx.lang === "ar" ? ar : en);
const minutesOf = (hhmm?: string | null) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

type Habit = {
  cinemaId?: string | null;
  weekday?: { from: string; to: string } | null;
  weekend?: { from: string; to: string } | null;
  experience?: string | null;
  weekendDays: number[];
};

async function habit(ctx: ToolCtx): Promise<Habit | null> {
  if (!ctx.conversation.isLoggedIn || !ctx.conversation.customerId) return null;
  try {
    const c = await ctx.vista.customer(ctx.conversation.customerId);
    const p = c?.profile;
    if (!p || !p.historyCount) return null;
    return {
      cinemaId: p.cinemaId ?? null,
      weekday: p.weekday,
      weekend: p.weekend,
      experience: p.preferredExperience ?? null,
      weekendDays: p.weekendDays ?? [6, 0],
    };
  } catch {
    return null;
  }
}

function inUsualWindow(showtime: string, h: Habit) {
  const day = new Date(`${showtime.slice(0, 10)}T00:00:00Z`).getUTCDay();
  const pref = h.weekendDays.includes(day) ? h.weekend : h.weekday;
  const at = minutesOf(showtime.slice(11, 16));
  const from = minutesOf(pref?.from);
  const to = minutesOf(pref?.to);
  return at != null && from != null && to != null && at >= from && at <= to;
}

export function showtimeBadges(ctx: ToolCtx, items: Record<string, any>[], h: Habit | null) {
  const open = items.filter((s) => !s.soldOut && Number(s.seatsAvailable) > 0);
  // "Most seats free" only when one show clearly has the most room (and more than a handful of seats).
  const roomiest = [...open].sort((a, b) => Number(b.seatsAvailable) - Number(a.seatsAvailable));
  const best =
    roomiest.length > 1 &&
    Number(roomiest[0]!.seatsAvailable) >= 20 &&
    Number(roomiest[0]!.seatsAvailable) > Number(roomiest[1]!.seatsAvailable)
      ? roomiest[0]!.sessionKey
      : null;
  return items.map((s) => {
    const badges: Badge[] = [];
    if (s.sessionKey === best)
      badges.push({ kind: "rec", label: L(ctx, "Most seats free", "أكثر مقاعد متاحة"), icon: "star" });
    const left = Number(s.seatsAvailable);
    if (!s.soldOut && left > 0 && left <= 10)
      badges.push({ kind: "few", label: L(ctx, `Only ${left} left`, `بقي ${left} فقط`) });
    if (h && typeof s.showtime === "string" && inUsualWindow(s.showtime, h))
      badges.push({ kind: "usual", label: L(ctx, "Your usual time", "وقتك المعتاد") });
    else if (h?.experience && s.experience === h.experience)
      badges.push({ kind: "usual", label: L(ctx, `Your usual ${s.experience}`, `${s.experience} المعتاد`) });
    return { ...s, badges: badges.slice(0, 2) };
  });
}

export function filmBadges(ctx: ToolCtx, items: Record<string, any>[], recommendation: boolean) {
  return items.map((m, i) => {
    if (!m.hoCode) return m;
    const badges: Badge[] = [];
    const why: string[] = Array.isArray(m.why) ? m.why : m.why ? [String(m.why)] : [];
    if (recommendation && i === 0)
      badges.push({ kind: "rec", label: L(ctx, "Best match", "الأنسب لك"), icon: "star" });
    const taste = why.find((w) => w.startsWith("you enjoy"));
    if (taste) badges.push({ kind: "usual", label: L(ctx, "Like films you've seen", "يشبه أفلاماً شاهدتها") });
    const left = Number(m.suggestedSession?.seatsAvailable);
    if (Number.isFinite(left) && left > 0 && left <= 10)
      badges.push({
        kind: "few",
        label: L(ctx, `${m.suggestedSession.experience ?? ""} filling fast`.trim(), "المقاعد تنفد"),
      });
    return badges.length ? { ...m, badges: badges.slice(0, 2) } : m;
  });
}

const ART_TYPES = new Set(["order", "payment", "booking", "qr", "booking_proposal"]);

/** Film art for booking-stage cards that only carry a title or film code. Decoration only; never blocks a result. */
async function withPosters(ctx: ToolCtx, items: Record<string, any>[]) {
  if (items.every((i) => i.posterUrl || !(i.hoCode || i.filmTitle))) return items;
  const films = await Promise.resolve()
    .then(() => ctx.catalog.films())
    .catch(() => [] as any[]);
  if (!Array.isArray(films) || !films.length) return items;
  return items.map((i) => {
    if (i.posterUrl) return i;
    const f = films.find(
      (x: any) =>
        (i.hoCode && x.hoCode === i.hoCode) ||
        (i.filmTitle && (x.title === i.filmTitle || x.titleAlt === i.filmTitle)),
    );
    return f?.posterUrl ? { ...i, posterUrl: f.posterUrl } : i;
  });
}

/** Adds badges to showtimes and film cards on any tool result; everything else passes through untouched. */
export async function decorateBadges(ctx: ToolCtx, result: ToolResult): Promise<ToolResult> {
  const ui = result.ui as UiHint | undefined;
  if (!ui?.items?.length) return result;
  if (ART_TYPES.has(ui.type))
    return { ...result, ui: { ...ui, items: await withPosters(ctx, ui.items as Record<string, any>[]) } };
  if (ui.type === "cinema") {
    const h = await habit(ctx);
    if (!h?.cinemaId) return result;
    const items = (ui.items as Record<string, any>[]).map((c) =>
      c.cinemaId === h.cinemaId
        ? { ...c, badges: [{ kind: "usual", label: L(ctx, "Your usual cinema", "سينماك المعتادة") }] }
        : c,
    );
    return { ...result, ui: { ...ui, items } };
  }
  if (ui.type === "showtimes") {
    const items = showtimeBadges(ctx, ui.items as Record<string, any>[], await habit(ctx));
    return { ...result, ui: { ...ui, items } };
  }
  if (ui.type === "movie" || ui.type === "recommendation")
    return {
      ...result,
      ui: { ...ui, items: filmBadges(ctx, ui.items as Record<string, any>[], ui.type === "recommendation") },
    };
  return result;
}
