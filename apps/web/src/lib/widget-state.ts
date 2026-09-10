import type { CommandResult, Lang, UiHint, WidgetEvent } from "./api";
import { cinemaDate } from "./cinema-time";

export type UserActivityClock = { lastUserAt: number; lastProviderPingAt: number };

/** Every customer event refreshes inactivity; bursts need only one provider ping per second. */
export function recordUserActivity(clock: UserActivityClock, notifyProvider?: () => void, now = Date.now()): void {
  clock.lastUserAt = now;
  if (notifyProvider && now - clock.lastProviderPingAt >= 1000) {
    clock.lastProviderPingAt = now;
    notifyProvider();
  }
}

/** A client tool may claim the map opened only after its verified response is rendered. */
export async function renderVerifiedSeatMap(load: () => Promise<CommandResult>, render: (ui: UiHint) => void, isCurrent: () => boolean) {
  try {
    const result = await load();
    if (!isCurrent()) return { ok: false, rendered: false, error: "The widget session changed. Check the current booking again." };
    if (!result.ok || result.ui?.type !== "seatmap") return { ok: false, rendered: false, error: result.error ?? "No verified seat map was returned." };
    render(result.ui);
    return { ok: true, rendered: true };
  } catch {
    return { ok: false, rendered: false, error: "The seat map could not load. Please try again." };
  }
}

/** Direct navigation confirms visible UI; a paused conversation must stay paused. */
export function directSeatMapFeedback(command: string, result: CommandResult, lang: Lang, connected: boolean, currentSession: boolean) {
  if (command !== "seat.plan" || !currentSession || !result.ok || result.ui?.type !== "seatmap") return;
  return {
    text: lang === "ar" ? "خريطة المقاعد جاهزة. يمكنك الآن اختيار مقاعدك." : "Seat map ready. You can choose your seats now.",
    context: connected ? JSON.stringify({ action: "seat_map_opened", succeeded: true, rendered: true, bookingChanged: false,
      instruction: "The seat map is already visible. Give one brief acknowledgement without calling tools, reopening the map or changing/holding seats. Wait for the customer." }) : undefined,
  };
}

/** Consume transport positions even when a relink repeats an already displayed event. */
export function acceptWidgetEvent(sequences: Map<string, number>, identities: Set<string>, conversationId: string, event: WidgetEvent): boolean {
  if (event.seq <= (sequences.get(conversationId) ?? 0)) return false;
  sequences.set(conversationId, event.seq);
  if (event.eventId) {
    if (identities.has(event.eventId)) return false;
    identities.add(event.eventId);
  }
  return true;
}

/** Translate only fixed controls; movie, cinema and offer names keep their server-provided wording. */
export function uiActionLabel(value: string, fallback: string, lang: Lang): string {
  const labels: Record<string, [string, string]> = {
    "recover:confirm": ["Check and hold seats again", "تحقق واحجز المقاعد مجدداً"],
    "booking:restart": ["Another show", "عرض آخر"],
    "seats:open": ["Choose seats", "اختيار المقاعد"],
    "seatmap:open": ["Choose seats", "اختيار المقاعد"],
    "menu:open": ["Browse menu", "تصفح القائمة"],
    "fnb:suggest": ["Add snacks", "إضافة وجبات خفيفة"],
    "pay:start": ["Continue to checkout", "المتابعة للدفع"],
    fnb_skip: ["Skip snacks", "تخطي الوجبات الخفيفة"],
    fnb_usual: ["Same as last time", "نفس الطلب السابق"],
    "usual:no": ["Another cinema", "سينما أخرى"],
    abort: ["Go back", "الرجوع"],
  };
  const label = labels[value] ?? labels[value.split(":")[0]!];
  return label?.[lang === "ar" ? 1 : 0] ?? fallback;
}

/** Summaries use only display fields, never session/order identifiers or hidden account data. */
export function decisionSummary(ui: UiHint, lang: Lang): string {
  const ar = lang === "ar";
  const meta = ui.meta ?? {};
  const items = ui.items ?? [];
  const selected = meta.selectedSummary ?? meta.selectedSession ?? meta.selectedFilm;
  const item = selected ?? (items.length === 1 || ["order", "payment", "booking", "qr"].includes(ui.type) ? items[0] : undefined) ?? {};
  const names = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string" && !!value.trim()))].slice(0, 2).join(" / ");
  const film = item.filmTitle ?? item.title ?? meta.film?.title ?? meta.filmTitle;
  const cinema = item.cinemaName ?? meta.cinemaName;
  const rawTime = item.showtime ?? meta.showtime;
  const parsed = typeof rawTime === "string" ? cinemaDate(rawTime) : null;
  const when = parsed && Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat(ar ? "ar-AE" : "en-AE", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dubai" }).format(parsed)
    : item.showtimeLabel ?? [item.dateLabel, item.time].filter(Boolean).join(" ");
  const count = item.tickets?.length || item.ticketCount || meta.selectedTicketCount;
  const seats = typeof item.seats === "string" ? item.seats : Array.isArray(item.seats) ? item.seats.join(", ") : item.tickets?.map((ticket: any) => ticket.seat).filter(Boolean).join(", ") ?? meta.selectedSeats;
  const details = [film, cinema, when, count ? ar ? `${count} تذاكر` : `${count} ticket${count === 1 ? "" : "s"}` : null, seats ? `${ar ? "المقاعد" : "Seats"} ${seats}` : null].filter(Boolean);
  if (["order", "payment", "booking", "qr", "quantity", "seatmap"].includes(ui.type) && details.length) return details.join(" · ");
  if (["movie", "recommendation"].includes(ui.type)) return film ?? `${ar ? "خيارات الأفلام" : "Movie options"}${items.length ? ` · ${names(items.map((movie) => movie.title ?? movie.filmTitle))}` : ""}`;
  if (ui.type === "showtimes") return selected && details.length ? details.join(" · ") : [ar ? "مواعيد العرض" : "Showtimes", film ?? names(items.map((show) => show.filmTitle)), cinema ?? names(items.map((show) => show.cinemaName))].filter(Boolean).join(" · ");
  if (ui.type === "menu") {
    const food = item.concessions ?? items.filter((food) => Number(food.quantity) > 0);
    return [ar ? "المأكولات والمشروبات" : "Food & drinks", food.map((food: any) => `${food.quantity}× ${ar ? food.descriptionAlt || food.description || food.name : food.description || food.name}`).join(" · ")].filter(Boolean).join(" · ");
  }
  const labels: Record<string, [string, string]> = { quantity: ["Ticket quantity", "عدد التذاكر"], seatmap: ["Seat selection", "اختيار المقاعد"], order: ["Booking choices", "اختيارات الحجز"], payment: ["Payment review", "مراجعة الدفع"], booking: ["Booking", "الحجز"], qr: ["Confirmed booking", "حجز مؤكد"], offer: ["Offers", "العروض"], cinema: ["Cinemas", "دور السينما"], loyalty: ["Your rewards", "مكافآتك"], transfer: ["Customer support", "خدمة العملاء"] };
  return labels[ui.type]?.[ar ? 1 : 0] ?? (ar ? "اختيارات سابقة" : "Earlier choices");
}

function retainSelection(previous: UiHint, next: UiHint): UiHint {
  const meta = next.meta ?? {};
  const summary = next.items?.[0];
  if (previous.type === "showtimes" && meta.sessionKey) {
    const selectedSession = previous.items.find((show) => show.sessionKey === meta.sessionKey);
    if (selectedSession) return { ...previous, meta: { ...previous.meta, selectedSession } };
  }
  if (["movie", "recommendation"].includes(previous.type)) {
    const title = meta.film?.title ?? summary?.filmTitle;
    const selectedFilm = previous.items.find((movie) => movie.hoCode === meta.film?.hoCode || (title && [movie.title, movie.titleEn].includes(title)));
    if (selectedFilm) return { ...previous, meta: { ...previous.meta, selectedFilm } };
  }
  if (["quantity", "seatmap", "menu"].includes(previous.type) && Array.isArray(summary?.tickets)) return { ...previous, meta: { ...previous.meta, selectedSummary: summary } };
  return previous;
}

export type TranscriptBody =
  | { kind: "msg"; role: "user" | "agent" | "human"; text: string; who?: string }
  | { kind: "cards"; ui: UiHint; archived?: boolean }
  | { kind: "note"; text: string; polite?: boolean }
  | { kind: "feedback" };
export type TranscriptItem = TranscriptBody & { id: string };

/** Server results are the only source of cards. Replays never revive old controls. */
export function appendTranscript(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const last = items.at(-1);
  if (item.kind === "msg" && last?.kind === "msg" && last.role === item.role && last.text === item.text) return items;
  if (item.kind === "feedback" && items.some((entry) => entry.kind === "feedback")) return items;
  if (item.kind !== "cards") return [...items, item];
  const fingerprint = JSON.stringify(item.ui);
  if (items.some((entry) => entry.kind === "cards" && !entry.archived && JSON.stringify(entry.ui) === fingerprint)) return items;
  const active = items.findIndex((entry) => entry.kind === "cards" && !entry.archived && entry.ui.type === item.ui.type &&
    entry.ui.meta?.userSessionId === item.ui.meta?.userSessionId && entry.ui.meta?.sessionKey === item.ui.meta?.sessionKey);
  if (active >= 0) return items.map((entry, index) => index === active ? { ...item, id: entry.id } : entry);
  return [...items.map((entry) => entry.kind === "cards" ? { ...entry, ui: entry.archived ? entry.ui : retainSelection(entry.ui, item.ui), archived: true } : entry), item];
}

export function holdSeconds(expiresAt: string | undefined, now = Date.now()): number | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** Keep acknowledgements factual and exclude credentials and payment tokens. */
export function actionContext(type: string, result: { ok: boolean; speech?: string; data?: Record<string, unknown>; action?: { status: string; type: string; result?: Record<string, unknown> }; error?: string }): string {
  const data = result.data ?? result.action?.result ?? {};
  const safe = Object.fromEntries(Object.entries(data).filter(([key]) => ["bookingState", "summary", "seats", "totalCents", "expiresAtUtc", "needs", "combinedCheckout", "bookingReference"].includes(key)));
  const scrub = (value: unknown): unknown => Array.isArray(value) ? value.map(scrub) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:password|token|secret|cvv|authorization)|^(?:pin|otp|email|phone|cardBin|cardNumber|first6)$/i.test(key)).map(([key, nested]) => [key, scrub(nested)]))
    : value;
  const pending = ["queued", "running"].includes(result.action?.status ?? "");
  const succeeded = result.ok && !pending && !["failed", "cancelled"].includes(result.action?.status ?? "");
  return JSON.stringify({ action: type, succeeded, pending, speech: result.speech, state: scrub(safe), error: result.error });
}
