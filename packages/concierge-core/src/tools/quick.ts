/**
 * Booking v2 — "ask less, understand more": one-shot booking, hold recovery, resume and quick F&B.
 *
 * quick_book   everything the guest said → best showtime → order → seats held → Review & Pay (one call)
 * recover_order after the hold expired → same showtime, same or closest seats, F&B + offers re-added
 * resume_order  inspect an earlier booking; expired holds require a new, explicit choice
 * suggest_fnb   "your usual" + popular items before checkout or after tickets are paid
 * order_fnb     add to the unpaid basket, or a separate F&B order after ticket payment
 */
import { createHash } from "node:crypto";
import { DomainError, ErrorCodes } from "@voxi/contracts";
import { schema as S } from "@voxi/db";
import {
  asEmirate,
  describeBenefit,
  distanceKm,
  normaliseFilmLanguage,
  resolveSpokenDate,
  similarity,
  visitDayType,
} from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { eq, sql } from "drizzle-orm";
import { renewLease } from "../actions/ledger.js";
import { appendEvent } from "../events.js";
import type { Cinema, Film, Session } from "../services/catalog.js";
import { updateConversation } from "../services/conversation.js";
import { fmtDate, fmtTime, joinList, money, t } from "../services/format.js";
import { beginInlineBasketMutation, finishInlineBasketMutation } from "../services/inline-mutation.js";
import { buildBookingState } from "../services/order-state.js";
import { loadCustomer } from "./customer.js";
import { filmCard, sessionCard } from "./movies.js";
import {
  type OfferHint,
  type VistaOrder,
  orderSummary,
  reviewAndPay,
  savedCardOfferHint,
} from "./ordering.js";
import { type ToolCtx, type ToolHandlers, type ToolResult, err, ok } from "./types.js";

type Meta = {
  activeOrder?: string | null;
  activeSessionKey?: string;
  lastCinemaId?: string;
  lastBookingId?: string;
  fnbOrder?: string | null;
  fnbForBookingId?: string;
  usualCinemaId?: string;
  pendingBooking?: Record<string, unknown>;
  bookingState?: Record<string, unknown>;
  holdRequest?: string;
  [k: string]: unknown;
};
const meta = (ctx: ToolCtx) => (ctx.conversation.metadata ?? {}) as Meta;

async function setMeta(ctx: ToolCtx, patch: Partial<Meta>) {
  const next = { ...meta(ctx), ...patch };
  await updateConversation(ctx.db, ctx.conversation.id, { metadata: next });
  ctx.conversation.metadata = next;
}

const hm = (iso: string) => iso.slice(11, 16);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = (m: number) =>
  `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;

function cinemaName(c: Cinema | undefined | null, lang: "en" | "ar") {
  return c ? (lang === "ar" ? c.nameAlt || c.name : c.name) : "";
}

/** The member's usual cinema: the one they book most, else the profile's home cinema. */
export async function usualCinema(ctx: ToolCtx, customerId: string, homeCinemaId?: string | null) {
  const hist = await ctx.vista
    .customerHistory(customerId)
    .catch(() => ({ history: [] as Record<string, any>[] }));
  const counts = new Map<string, number>();
  for (const h of hist.history) counts.set(h.cinemaId, (counts.get(h.cinemaId) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return top ? await ctx.catalog.cinema(top) : homeCinemaId ? await ctx.catalog.cinema(homeCinemaId) : null;
}

/** Booking availability is independent of cancellation's 30-minute refund cutoff. */
export function sessionUnavailableReason(s: Session, nowLocal: string) {
  if (s.showtime <= nowLocal) return "show_started";
  if (!s.allowTicketSales) return "sales_closed";
  if (s.soldOut) return "sold_out";
  return null;
}

function holdExpired(o: VistaOrder, now = Date.now()) {
  return o.State === "expired" || (!!o.ExpiryDateUtc && new Date(o.ExpiryDateUtc).getTime() <= now);
}

/** A food edit replaces only the named items; omitted items and modifiers remain in the basket. */
function mergeFoodItems(
  order: VistaOrder | null,
  items: { itemId: string; quantity: number; modifierIds?: string[] }[],
) {
  const existing = (order?.Concessions ?? []) as {
    ItemId: string;
    Quantity: number;
    Modifiers?: (string | { Id: string })[];
  }[];
  const modifiers = (line: (typeof existing)[number] | undefined) =>
    line?.Modifiers?.map((modifier) => (typeof modifier === "string" ? modifier : modifier.Id));
  const requested = new Set(items.map((item) => item.itemId));
  return [
    ...existing
      .filter((line) => !requested.has(line.ItemId))
      .map((line) => ({ ItemId: line.ItemId, Quantity: line.Quantity, Modifiers: modifiers(line) })),
    ...items.map((item) => ({
      ItemId: item.itemId,
      Quantity: item.quantity,
      Modifiers: item.modifierIds ?? modifiers(existing.find((line) => line.ItemId === item.itemId)),
    })),
  ];
}

async function expiredChoice(
  ctx: ToolCtx,
  userSessionId: string,
  canRecover = true,
  order?: VistaOrder,
): Promise<ToolResult> {
  const current = order ?? (await ctx.vista.getOrder(userSessionId).catch(() => null))?.Order;
  const cinema = current ? await ctx.catalog.cinema(current.CinemaId) : null;
  const summary = current
    ? orderSummary(current, ctx.lang, ctx.nowLocal, cinemaName(cinema, ctx.lang))
    : null;
  const bookingState = summary
    ? { ...buildBookingState(summary), currentJourneyStage: "expired", requiresFreshHold: true }
    : null;
  return ok(
    {
      active: false,
      expired: true,
      userSessionId,
      needs: "recovery_confirmation",
      canRecover,
      summary,
      bookingState,
    },
    t(
      ctx.lang,
      "That hold has expired. Shall I check and hold available seats again?",
      "انتهى الحجز المؤقت. هل أتحقق وأحجز المقاعد المتاحة مجدداً؟",
    ),
    {
      type: "order",
      items: summary ? [summary] : [],
      meta: { userSessionId, expired: true, canRecover, stage: "expired" },
      actions: [
        ...(canRecover
          ? [
              {
                label: t(ctx.lang, "Check and hold seats again", "تحقق واحجز المقاعد مجدداً"),
                value: "recover:confirm",
              },
            ]
          : []),
        { label: t(ctx.lang, "Another show", "عرض آخر"), value: "booking:restart" },
      ],
    },
  );
}

async function bookingReview(
  ctx: ToolCtx,
  o: VistaOrder,
  speech: string,
  extra: Record<string, unknown> = {},
) {
  const cinema = await ctx.catalog.cinema(o.CinemaId);
  const summary = orderSummary(o, ctx.lang, ctx.nowLocal, cinemaName(cinema, ctx.lang));
  const sessionKey = `${summary.cinemaId}-${summary.sessionId}`;
  const bookingState = buildBookingState(summary);
  await setMeta(ctx, { bookingState });
  return ok(
    { userSessionId: o.UserSessionId, sessionKey, order: summary, bookingState, ...extra },
    speech,
    {
      type: "order",
      title: t(ctx.lang, "Your booking", "حجزك"),
      items: [summary],
      meta: {
        userSessionId: o.UserSessionId,
        sessionKey,
        expiresAtUtc: summary.expiresAtUtc,
        stage: "seats",
        ...extra,
      },
      actions: [
        { label: t(ctx.lang, "Change seats", "تغيير المقاعد"), value: "seats:open" },
        { label: t(ctx.lang, "Add snacks", "إضافة وجبات خفيفة"), value: "fnb:suggest" },
        { label: t(ctx.lang, "Continue to payment", "متابعة الدفع"), value: "pay:start", style: "primary" },
      ],
    },
    { name: "guided_booking", status: "started" },
  );
}

type Resolved =
  | { kind: "session"; session: Session; film: Film | null; cinema: Cinema | undefined }
  | { kind: "result"; result: ToolResult };

/** Pick the ticket types for the request: cheapest regular adult type (+ child type when asked). */
async function ticketTypesFor(ctx: ToolCtx, s: Session, adults: number, children: number) {
  const r = await ctx.vista.ticketTypes(s.cinemaId, s.sessionId);
  const film = await ctx.catalog.film(s.hoCode);
  const noKids = /^(15|18|21)\+?$/.test((film?.rating ?? "").trim());
  const usable = (r.Tickets ?? []).filter(
    (x: any) => !x.IsAvailableForLoyaltyMembersOnly || ctx.conversation.memberId,
  );
  const regular = usable.filter(
    (x: any) =>
      !x.IsChildOnlyTicket && x.AreaCategoryCode !== "0000000001" && x.AreaCategoryCode !== "0000000003",
  );
  const adult = [...regular].sort((a: any, b: any) => a.PriceInCents - b.PriceInCents)[0] ?? usable[0];
  const child = noKids ? null : usable.find((x: any) => x.IsChildOnlyTicket);
  const tickets: { TicketTypeCode: string; Qty: number }[] = [];
  if (adult && adults > 0) tickets.push({ TicketTypeCode: adult.TicketTypeCode, Qty: adults });
  if (children > 0 && (child ?? adult))
    tickets.push({ TicketTypeCode: (child ?? adult)!.TicketTypeCode, Qty: children });
  return { tickets, noKids, rating: film?.rating };
}

/** Start an order for a session and hold seats — the synchronous core shared by quick_book and recovery. */
export async function holdSeats(
  ctx: ToolCtx,
  s: Session,
  tickets: { TicketTypeCode: string; Qty: number }[],
  preference: string | undefined,
  exactSeats?: { Row: string; Number: string }[],
): Promise<{ userSessionId: string; order: VistaOrder; sameSeats: boolean }> {
  const previous = meta(ctx).activeOrder;
  const holdRequest = JSON.stringify({ sessionKey: s.key, tickets, preference, exactSeats });
  if (previous && meta(ctx).holdRequest === holdRequest) {
    const current = (await ctx.vista.getOrder(previous).catch(() => null))?.Order;
    if (current && !["paid", "cancelled"].includes(current.State) && !holdExpired(current))
      return { userSessionId: previous, order: current, sameSeats: true };
  }
  // A retry of the same tool call addresses the same downstream order, even after a partial response.
  const userSessionId = `usid_${createHash("sha256").update(`${ctx.conversation.id}:${ctx.toolCallId}:${s.key}`).digest("hex").slice(0, 24)}`;
  const existing = (await ctx.vista.getOrder(userSessionId).catch(() => null))?.Order;
  if (
    existing?.Sessions?.[0]?.Tickets?.length &&
    !["paid", "cancelled"].includes(existing.State) &&
    !holdExpired(existing)
  ) {
    await setMeta(ctx, {
      activeOrder: userSessionId,
      activeSessionKey: s.key,
      lastCinemaId: s.cinemaId,
      holdRequest,
    });
    return { userSessionId, order: existing, sameSeats: true };
  }
  let order: VistaOrder;
  let sameSeats = false;
  if (exactSeats?.length) {
    // hold the exact seats: add tickets without auto-allocation, then set the seats; fall back to auto on conflict
    try {
      await ctx.vista.addTickets({
        UserSessionId: userSessionId,
        CinemaId: s.cinemaId,
        SessionId: s.sessionId,
        TicketTypes: tickets,
        SkipAutoAllocation: true,
        ConversationId: ctx.conversation.id,
      });
      order = (
        await ctx.vista.setSeats({
          UserSessionId: userSessionId,
          CinemaId: s.cinemaId,
          SessionId: s.sessionId,
          SelectedSeats: exactSeats,
        })
      ).Order;
      sameSeats = true;
    } catch {
      order = (
        await ctx.vista.addTickets({
          UserSessionId: userSessionId,
          CinemaId: s.cinemaId,
          SessionId: s.sessionId,
          TicketTypes: tickets,
          SeatPreference: preference,
          ConversationId: ctx.conversation.id,
        })
      ).Order;
    }
  } else {
    order = (
      await ctx.vista.addTickets({
        UserSessionId: userSessionId,
        CinemaId: s.cinemaId,
        SessionId: s.sessionId,
        TicketTypes: tickets,
        SeatPreference: preference,
        ConversationId: ctx.conversation.id,
      })
    ).Order;
  }
  await setMeta(ctx, {
    activeOrder: userSessionId,
    activeSessionKey: s.key,
    lastCinemaId: s.cinemaId,
    holdRequest,
  });
  if (previous && previous !== userSessionId) await ctx.vista.cancelOrder(previous).catch(() => undefined);
  ctx.catalog.invalidateSessions(s.cinemaId);
  return { userSessionId, order, sameSeats };
}

/** Closest free run of `n` adjacent seats to the previous seats: same row first, then nearest rows. */
export async function closestSeats(ctx: ToolCtx, s: Session, previous: { Row: string; Number: string }[]) {
  const plan = await ctx.vista.seatPlan(s.cinemaId, s.sessionId).catch(() => null);
  const areas = (plan?.SeatLayoutData?.Areas ?? []) as any[];
  const rows = areas.flatMap((a) =>
    a.Rows.map((r: any) => ({
      row: String(r.PhysicalName),
      rowIndex: Number(r.RowIndexZeroBased ?? 0),
      seats: (r.Seats as any[])
        .filter((x) => x.Status === 0)
        .map((x) => ({ id: String(x.Id), col: Number(x.Position?.ColumnIndex ?? 0) }))
        .sort((a, b) => a.col - b.col),
    })),
  );
  const n = previous.length;
  const prevRow = previous.length ? rows.find((r) => r.row === previous[0]!.Row) : undefined;
  const prevCols = previous.map((p) => Number(p.Number));
  const centre = prevCols.reduce((a, b) => a + b, 0) / Math.max(1, prevCols.length);
  let best: { row: string; seats: { id: string }[]; score: number } | null = null;
  for (const r of rows) {
    for (let i = 0; i + n <= r.seats.length; i++) {
      const run = r.seats.slice(i, i + n);
      if (run[n - 1]!.col - run[0]!.col !== n - 1) continue;
      const mid = (Number(run[0]!.id) + Number(run[n - 1]!.id)) / 2;
      const rowGap = prevRow ? Math.abs(r.rowIndex - prevRow.rowIndex) : 0;
      const score = rowGap * 100 + Math.abs(mid - centre);
      if (!best || score < best.score) best = { row: r.row, seats: run, score };
    }
  }
  return best ? best.seats.map((x) => ({ Row: best!.row, Number: x.id })) : null;
}

/** Resolve the guest's request to one bookable session, or to a card that asks for the missing piece. */
async function resolveSession(
  ctx: ToolCtx,
  input: any,
  customer: Record<string, any> | null,
): Promise<Resolved> {
  const lang = ctx.lang;
  const cinemas = await ctx.catalog.cinemas();
  if (input.sessionKey) {
    const session = await ctx.catalog.sessionByKey(input.sessionKey);
    if (!session)
      return {
        kind: "result",
        result: err(ErrorCodes.NOT_FOUND, t(lang, "I couldn't find that showtime.", "لم أجد هذا الموعد.")),
      };
    const reason = sessionUnavailableReason(session, ctx.nowLocal);
    if (reason) {
      const alternatives = (await ctx.catalog.sessions(session.cinemaId))
        .filter((s) => s.hoCode === session.hoCode && !sessionUnavailableReason(s, ctx.nowLocal))
        .sort((a, b) => a.showtime.localeCompare(b.showtime))
        .slice(0, 3);
      const items = alternatives.map((s) =>
        sessionCard(
          s,
          lang,
          ctx.nowLocal,
          cinemaName(
            cinemas.find((c) => c.id === s.cinemaId),
            lang,
          ),
        ),
      );
      return {
        kind: "result",
        result: ok(
          {
            needs: "alternative",
            reason,
            requestedShowtime: session.showtime,
            currentTime: ctx.nowLocal,
            alternatives: items,
          },
          t(
            lang,
            reason === "show_started"
              ? "That show has already started. Here are the next options."
              : "That show is no longer on sale. Try one of these?",
            reason === "show_started"
              ? "بدأ ذلك العرض بالفعل. هذه المواعيد التالية."
              : "لم يعد ذلك العرض متاحاً للحجز. هل يناسبك أحد هذه المواعيد؟",
          ),
          {
            type: "showtimes",
            items,
            actions: items.map((s) => ({ label: `${s.dateLabel} ${s.time}`, value: `book:${s.sessionKey}` })),
            meta: { reason },
          },
        ),
      };
    }
    return {
      kind: "session",
      session,
      film: await ctx.catalog.film(session.hoCode),
      cinema: cinemas.find((c) => c.id === session.cinemaId),
    };
  }
  // ---- film ----
  let film: Film | null = input.hoCode ? await ctx.catalog.film(input.hoCode) : null;
  if (!film && input.title) {
    const cands = await ctx.catalog.resolveFilms(input.title, 3);
    if (cands.length > 1 && cands[0]!.score < 0.8 && cands[1]!.score > 0.6)
      return {
        kind: "result",
        result: ok(
          { needs: "film", ambiguous: cands.map((c) => filmCard(c.film, lang)) },
          t(
            lang,
            `Did you mean ${joinList(cands.map((c) => c.film.title))}?`,
            `هل تقصد ${joinList(
              cands.map((c) => c.film.title),
              "ar",
            )}؟`,
          ),
          {
            type: "movie",
            items: cands.map((c) => filmCard(c.film, lang)),
            actions: cands.map((c) => ({ label: c.film.title, value: `showtimes:${c.film.hoCode}` })),
          },
        ),
      };
    film = cands[0] && cands[0].score >= 0.55 ? cands[0].film : null;
    if (!film)
      return {
        kind: "result",
        result: err(
          ErrorCodes.NOT_FOUND,
          t(lang, `I couldn't find a movie called ${input.title}.`, `لم أجد فيلماً باسم ${input.title}.`),
        ),
      };
  }
  if (!film)
    return {
      kind: "result",
      result: ok({ needs: "film" }, t(lang, "Which movie would you like to see?", "أي فيلم تود مشاهدته؟")),
    };
  const wantLang = normaliseFilmLanguage(input.language);
  const versions = new Set(
    (await ctx.catalog.films())
      .filter(
        (f) =>
          f.title.toLowerCase() === film!.title.toLowerCase() &&
          (!wantLang || similarity(f.language, wantLang) >= 0.7),
      )
      .map((f) => f.hoCode),
  );
  if (!versions.size && !wantLang) versions.add(film.hoCode);
  if (!versions.size)
    return {
      kind: "result",
      result: ok(
        { needs: "alternative", reason: "language_unavailable", language: wantLang },
        t(
          lang,
          `I couldn't find ${film.title} in ${wantLang}. Another movie?`,
          `لم أجد ${film.title} باللغة ${wantLang}. هل تختار فيلماً آخر؟`,
        ),
      ),
    };

  // ---- cinema ----
  let cinemaIds: string[] = [];
  let requested: Cinema | undefined;
  const emirate = asEmirate(input.cinemaName);
  if (input.cinemaId) cinemaIds = [input.cinemaId];
  else if (emirate) cinemaIds = cinemas.filter((c) => c.emirate === emirate).map((c) => c.id);
  else if (input.cinemaName) {
    const r = await ctx.catalog.resolveCinema(input.cinemaName);
    if (!r)
      return {
        kind: "result",
        result: err(
          ErrorCodes.NOT_FOUND,
          t(
            lang,
            `I don't recognise a VOX cinema called ${input.cinemaName}. Which mall is it in?`,
            `لا أعرف سينما فوكس باسم ${input.cinemaName}. في أي مول؟`,
          ),
        ),
      };
    cinemaIds = [r.cinema.id];
  } else {
    const inferred = customer?.profile?.cinemaId ? await ctx.catalog.cinema(customer.profile.cinemaId) : null;
    const usual = inferred ?? (customer ? await usualCinema(ctx, customer.id, customer.homeCinemaId) : null);
    if (usual) cinemaIds = [usual.id];
    else if (ctx.conversation.geo)
      cinemaIds = (
        await ctx.catalog.nearestCinemas(ctx.conversation.geo.lat, ctx.conversation.geo.lng, 3)
      ).map((c) => c.id);
    else
      return {
        kind: "result",
        result: ok(
          { needs: "cinema", film: filmCard(film, lang) },
          t(
            lang,
            "Which cinema — or tap the location button and I'll pick the nearest?",
            "أي سينما — أو اضغط زر الموقع وسأختار الأقرب؟",
          ),
        ),
      };
  }
  requested = cinemas.find((c) => c.id === cinemaIds[0]);

  // ---- window ----
  const date = resolveSpokenDate(input.date, ctx.nowLocal);
  const from = input.time ? clock(minutes(input.time) - 30) : input.timeFrom;
  const to = input.time ? clock(minutes(input.time) + 30) : input.timeTo;
  const profileTime =
    customer?.profile && !input.time && !input.timeFrom && !input.timeTo
      ? customer.profile[visitDayType(`${date}T12:00:00`, customer.profile)]?.around
      : undefined;
  const target = input.time ? minutes(input.time) : profileTime ? minutes(profileTime) : null;
  const all = (await Promise.all(cinemaIds.map((id) => ctx.catalog.sessions(id))))
    .flat()
    .filter((s) => versions.has(s.hoCode) && !sessionUnavailableReason(s, ctx.nowLocal));
  const onDate = (d: string) => all.filter((s) => s.showtime.slice(0, 10) === d);
  const inWindow = (rows: Session[]) =>
    rows.filter((s) => (!from || hm(s.showtime) >= from) && (!to || hm(s.showtime) <= to));
  const preferredExp: string | undefined =
    input.experience ?? (customer?.preferences?.experiences?.[0] as string | undefined);
  const byExperience = (rows: Session[]) => {
    if (input.experience) return rows.filter((s) => s.experience === input.experience);
    const std = rows.filter((s) => s.experience === "Standard");
    const pref = preferredExp ? rows.filter((s) => s.experience === preferredExp) : [];
    return pref.length ? pref : std.length ? std : rows;
  };
  const closeness = (s: Session) =>
    target == null ? minutes(hm(s.showtime)) : Math.abs(minutes(hm(s.showtime)) - target);
  const rank = (rows: Session[]) =>
    [...rows].sort(
      (a, b) => closeness(a) - closeness(b) || cinemaIds.indexOf(a.cinemaId) - cinemaIds.indexOf(b.cinemaId),
    );
  const primary = rank(byExperience(inWindow(onDate(date))));
  const requestedPast = !!input.time && `${date}T${input.time}:00` <= ctx.nowLocal;
  if (primary.length && !requestedPast)
    return {
      kind: "session",
      session: primary[0]!,
      film,
      cinema: cinemas.find((c) => c.id === primary[0]!.cinemaId),
    };

  // ---- alternatives: same cinema other time → nearby cinemas in the window → next day → similar film ----
  const alts: { s: Session; why: string }[] = [];
  const add = (rows: Session[], why: string, n: number) => {
    for (const s of rank(rows)) {
      if (alts.length >= 3) break;
      if (alts.some((a) => a.s.key === s.key)) continue;
      alts.push({ s, why });
      if (alts.filter((a) => a.why === why).length >= n) break;
    }
  };
  const sameCinema = requested ? onDate(date).filter((s) => s.cinemaId === requested!.id) : onDate(date);
  add(byExperience(sameCinema), "time", 2);
  if (requested?.lat != null && requested.lng != null) {
    const near = cinemas.filter(
      (c) =>
        c.id !== requested!.id &&
        c.lat != null &&
        c.lng != null &&
        distanceKm(requested!.lat!, requested!.lng!, c.lat!, c.lng!) <= 10,
    );
    const nearRows = (await Promise.all(near.map((c) => ctx.catalog.sessions(c.id))))
      .flat()
      .filter(
        (s) =>
          versions.has(s.hoCode) &&
          !sessionUnavailableReason(s, ctx.nowLocal) &&
          s.showtime.slice(0, 10) === date,
      );
    add(byExperience(inWindow(nearRows)), "nearby", 2);
  }
  const nextDay = new Date(`${date}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const tomorrow = nextDay.toISOString().slice(0, 10);
  add(
    byExperience(
      inWindow(
        sameCinema.length || !requested
          ? all.filter(
              (s) => s.showtime.slice(0, 10) === tomorrow && (!requested || s.cinemaId === requested.id),
            )
          : [],
      ),
    ),
    "tomorrow",
    1,
  );
  if (alts.length < 3 && requested) {
    const genres = new Set(film.genres);
    const similar = (await ctx.catalog.sessions(requested.id)).filter(
      (s) =>
        s.showtime.slice(0, 10) === date &&
        !sessionUnavailableReason(s, ctx.nowLocal) &&
        !versions.has(s.hoCode),
    );
    const films = await ctx.catalog.films();
    const rows = similar.filter((s) =>
      (films.find((f) => f.hoCode === s.hoCode)?.genres ?? []).some((g) => genres.has(g)),
    );
    add(byExperience(inWindow(rows)), "similar", 1);
  }
  const cname = (id: string) =>
    cinemaName(
      cinemas.find((c) => c.id === id),
      lang,
    );
  const reqName = requested ? cinemaName(requested, lang) : "";
  if (!alts.length)
    return {
      kind: "result",
      result: ok(
        { needs: "alternative", alternatives: [] },
        t(
          lang,
          `${film.title} isn't showing${reqName ? ` at ${reqName}` : ""} ${fmtDate(date, "en", ctx.nowLocal)}. Another day or another movie?`,
          `${film.title} غير معروض${reqName ? ` في ${reqName}` : ""} ${fmtDate(date, "ar", ctx.nowLocal)}. يوم آخر أم فيلم آخر؟`,
        ),
      ),
    };
  const items = alts.map((a) => ({
    ...sessionCard(a.s, lang, ctx.nowLocal, cname(a.s.cinemaId)),
    why: a.why,
    posterUrl: a.s.hoCode === film!.hoCode ? undefined : undefined,
  }));
  const describe = (a: { s: Session; why: string }) => {
    const time = fmtTime(a.s.showtime, lang);
    const c = cname(a.s.cinemaId);
    if (a.why === "time") return t(lang, `${time} at ${c}`, `${time} في ${c}`);
    if (a.why === "nearby") return t(lang, `${time} at ${c} nearby`, `${time} في ${c} القريبة`);
    if (a.why === "tomorrow") return t(lang, `tomorrow ${time} at ${c}`, `غداً ${time} في ${c}`);
    return t(lang, `${a.s.filmTitle} at ${time}`, `${a.s.filmTitle} الساعة ${time}`);
  };
  const askedTime = input.time ? fmtTime(`${date}T${input.time}:00`, lang) : "";
  return {
    kind: "result",
    result: ok(
      {
        needs: "alternative",
        reason: requestedPast ? "requested_time_passed" : "unavailable",
        requestedTime: input.time,
        currentTime: ctx.nowLocal,
        film: filmCard(film, lang),
        alternatives: items.map((i) => ({
          sessionKey: i.sessionKey,
          cinemaName: i.cinemaName,
          time: i.time,
          dateLabel: i.dateLabel,
          experience: i.experience,
          filmTitle: i.filmTitle,
          why: i.why,
        })),
      },
      t(
        lang,
        `${requestedPast ? `${askedTime} has already passed` : askedTime ? `${askedTime} isn't available` : "That isn't available"}. ${joinList(alts.map(describe), "en").replace(/, and /, " or ")} — which works?`,
        `${requestedPast ? `مضى موعد ${askedTime}` : askedTime ? `${askedTime} غير متاح` : "هذا غير متاح"}. ${joinList(alts.map(describe), "ar")} — أيها يناسبك؟`,
      ),
      {
        type: "showtimes",
        title: t(lang, "Closest options", "أقرب الخيارات"),
        items,
        meta: { film: filmCard(film, lang), groupBy: "cinema" },
        actions: items.map((i) => ({
          label: t(
            lang,
            `${i.dateLabel} ${i.time} · ${i.cinemaName}`,
            `${i.dateLabel} ${i.time} · ${i.cinemaName}`,
          ),
          value: `book:${i.sessionKey}`,
        })),
      },
    ),
  };
}

/** Compact seat label: F10–F11 for a run, F3, F5 otherwise. */
export function seatRange(seats: string): string {
  const parts = seats.split(/,\s*/).filter(Boolean);
  if (parts.length < 2) return seats;
  const row = parts[0]!.replace(/\d+$/, "");
  const nums = parts.map((p) => Number(p.replace(/^[A-Za-z]+/, "")));
  const contiguous =
    parts.every((p) => p.startsWith(row)) && nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
  return contiguous ? `${row}${nums[0]}–${row}${nums[nums.length - 1]}` : parts.join(", ");
}

const quickHandlers: Pick<
  ToolHandlers,
  "quick_book" | "recover_order" | "resume_order" | "suggest_fnb" | "order_fnb"
> = {
  async quick_book(ctx, incoming) {
    const lang = ctx.lang;
    const previous = meta(ctx).pendingBooking ?? {};
    const provided = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
    const pending = { ...previous, ...provided };
    // A newly stated movie/cinema/date/time replaces a previous exact showtime selection.
    if (
      !incoming.sessionKey &&
      [
        "title",
        "hoCode",
        "cinemaId",
        "cinemaName",
        "date",
        "time",
        "timeFrom",
        "timeTo",
        "language",
        "experience",
      ].some((key) => key in provided)
    )
      pending.sessionKey = undefined;
    if (incoming.title && !incoming.hoCode) pending.hoCode = undefined;
    if (incoming.cinemaName && !incoming.cinemaId) pending.cinemaId = undefined;
    if (incoming.time) {
      pending.timeFrom = undefined;
      pending.timeTo = undefined;
    }
    if (incoming.timeFrom || incoming.timeTo) pending.time = undefined;
    const input = pending as typeof incoming;
    await setMeta(ctx, { pendingBooking: pending });
    const customer = ctx.conversation.customerId ? await loadCustomer(ctx) : null;
    const resolved = await resolveSession(ctx, input, customer);
    if (resolved.kind === "result") return resolved.result;
    const { session: s, cinema } = resolved;
    await setMeta(ctx, { pendingBooking: { ...pending, sessionKey: s.key } });
    if (input.tickets == null) {
      const selection = {
        sessionKey: s.key,
        filmTitle: s.filmTitle,
        cinemaName: cinemaName(cinema, lang),
        showtime: s.showtime,
      };
      return ok(
        { needs: "tickets", ...selection, bookingState: { ...selection, currentJourneyStage: "quantity" } },
        t(lang, "How many are going?", "كم عدد التذاكر؟"),
        {
          type: "quantity",
          items: [],
          meta: selection,
          actions: [1, 2, 3, 4].map((n) => ({ label: String(n), value: `tickets:${n}` })),
        },
      );
    }
    const { tickets, noKids, rating } = await ticketTypesFor(ctx, s, input.tickets, input.childTickets ?? 0);
    if ((input.childTickets ?? 0) > 0 && noKids)
      return err(
        ErrorCodes.VALIDATION,
        t(
          lang,
          `${s.filmTitle} is rated ${rating}, so it's adults only. Book adult tickets only?`,
          `${s.filmTitle} مصنف ${rating} للكبار فقط. هل أحجز تذاكر للكبار فقط؟`,
        ),
      );
    if (!tickets.length)
      return err(
        ErrorCodes.VISTA_ERROR,
        t(lang, "No tickets are on sale for that show.", "لا توجد تذاكر معروضة لهذا العرض."),
      );
    const pref =
      input.seatPreference === "any"
        ? undefined
        : (input.seatPreference ??
          customer?.profile?.seatPreference ??
          customer?.preferences?.seatPreference ??
          "middle");
    let held: Awaited<ReturnType<typeof holdSeats>>;
    try {
      held = await holdSeats(ctx, s, tickets, pref);
    } catch (e) {
      if (e instanceof VistaClientError && e.extendedResultCode === 52)
        return err(
          ErrorCodes.SEATS_UNAVAILABLE,
          t(
            lang,
            `There aren't ${tickets.reduce((n, x) => n + x.Qty, 0)} seats together for that show. Try another time?`,
            "لا توجد مقاعد متجاورة كافية لهذا العرض. هل نجرب وقتاً آخر؟",
          ),
        );
      throw e;
    }
    const summary = orderSummary(held.order, lang, ctx.nowLocal, cinemaName(cinema, lang));
    await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "order.updated", {
      userSessionId: held.userSessionId,
      summary,
    });
    const hint = customer
      ? await savedCardOfferHint(ctx, s.key, s.cinemaId, summary.tickets.length, customer)
      : null;
    const count = summary.tickets.length;
    const seats = seatRange(summary.seats);
    return bookingReview(
      ctx,
      held.order,
      t(
        lang,
        `${count} seats held — ${seats}. Snacks before payment?`,
        `حجزت ${count} مقاعد — ${seats}. هل تريد وجبات خفيفة قبل الدفع؟`,
      ),
      { offerHint: hint, holdMinutes: ctx.cfg.orderExpiryMinutes },
    );
  },

  async recover_order(ctx, input) {
    const lang = ctx.lang;
    const usid = input.userSessionId ?? meta(ctx).activeOrder;
    if (!usid)
      return err(ErrorCodes.NOT_FOUND, t(lang, "There's no booking to recover.", "لا يوجد حجز لاستعادته."));
    const old = (await ctx.vista.getOrder(usid).catch(() => null))?.Order as VistaOrder | null;
    const sessionKey =
      old?.CinemaId && old?.Sessions?.[0]?.SessionId
        ? `${old.CinemaId}-${old.Sessions[0].SessionId}`
        : meta(ctx).activeSessionKey;
    const s = sessionKey ? await ctx.catalog.sessionByKey(sessionKey) : null;
    if (!s || !old)
      return err(
        ErrorCodes.NOT_FOUND,
        t(
          lang,
          "I couldn't find the earlier booking — let's start again.",
          "لم أجد الحجز السابق — لنبدأ من جديد.",
        ),
      );
    if (old.State === "paid")
      return ok(
        { active: false, paid: true, bookingId: old.CompletedBookingId },
        t(lang, "That booking is already confirmed.", "هذا الحجز مؤكد بالفعل."),
      );
    if (sessionUnavailableReason(s, ctx.nowLocal)) {
      const resolved = await resolveSession(ctx, { sessionKey: s.key }, null);
      if (resolved.kind === "result") return resolved.result;
    }
    if (!holdExpired(old) && old.State !== "cancelled") {
      // still alive → nothing to recover, just show it
      return quickHandlers.resume_order(ctx, {});
    }
    if (!input.confirmed) return expiredChoice(ctx, usid, true, old);
    const tickets = old.Sessions?.[0]?.Tickets ?? [];
    const counts = new Map<string, number>();
    for (const tk of tickets) counts.set(tk.TicketTypeCode, (counts.get(tk.TicketTypeCode) ?? 0) + 1);
    const grouped = [...counts.entries()].map(([TicketTypeCode, Qty]) => ({ TicketTypeCode, Qty }));
    const previousSeats = tickets
      .filter((tk: any) => tk.SeatRowId)
      .map((tk: any) => ({ Row: String(tk.SeatRowId), Number: String(tk.SeatNumber) }));
    let held = await holdSeats(ctx, s, grouped, "middle", previousSeats);
    let where = held.sameSeats ? "same" : "auto";
    if (!held.sameSeats && previousSeats.length) {
      const near = await closestSeats(ctx, s, previousSeats).catch(() => null);
      if (near) {
        try {
          const r = await ctx.vista.setSeats({
            UserSessionId: held.userSessionId,
            CinemaId: s.cinemaId,
            SessionId: s.sessionId,
            SelectedSeats: near,
          });
          held = { ...held, order: r.Order };
          where = near[0]!.Row === previousSeats[0]!.Row ? "same_row" : "nearby";
        } catch {}
      }
    }
    // F&B and offers come back with the seats
    const conc = (old.Concessions ?? []) as any[];
    if (conc.length)
      held.order =
        (
          await ctx.vista
            .addConcessions({
              UserSessionId: held.userSessionId,
              CinemaId: s.cinemaId,
              Concessions: conc.map((c) => ({
                ItemId: c.ItemId,
                Quantity: c.Quantity,
                Modifiers: (c.Modifiers ?? []).map((m: any) => String(m.Id ?? m.id)),
              })),
            })
            .catch(() => ({ Order: held.order }))
        ).Order ?? held.order;
    for (const o of (old.AppliedOffers ?? []) as any[])
      held.order =
        (
          await ctx.vista
            .applyOffer({
              UserSessionId: held.userSessionId,
              OfferId: o.offerId,
              CardBin: o.cardBin,
              MemberId: ctx.conversation.memberId ?? undefined,
            })
            .catch(() => ({ Order: held.order }))
        ).Order ?? held.order;
    const cinema = await ctx.catalog.cinema(s.cinemaId);
    const summary = orderSummary(held.order, lang, ctx.nowLocal, cinemaName(cinema, lang));
    await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "order.updated", {
      userSessionId: held.userSessionId,
      summary,
    });
    const seats = seatRange(summary.seats);
    const note =
      where === "same"
        ? t(
            lang,
            `Your hold expired, but ${seats} were still free — I've held them again.`,
            `انتهى الحجز المؤقت، لكن المقاعد ${seats} كانت لا تزال متاحة — حجزتها لك مجدداً.`,
          )
        : where === "same_row"
          ? t(
              lang,
              `Your hold expired and the same seats were taken, so I've held ${seats} in the same row.`,
              `انتهى الحجز المؤقت وأُخذت المقاعد نفسها، فحجزت ${seats} في الصف نفسه.`,
            )
          : t(
              lang,
              `Your hold expired and those seats were taken, so I've held the closest ones: ${seats}.`,
              `انتهى الحجز المؤقت وأُخذت المقاعد، فحجزت الأقرب: ${seats}.`,
            );
    return bookingReview(ctx, held.order, note, { seatsRecovered: where, recovered: true });
  },

  async resume_order(ctx) {
    const lang = ctx.lang;
    const usid = meta(ctx).activeOrder;
    if (!usid)
      return ok(
        { active: false },
        t(
          lang,
          "There's no booking in progress. What would you like to see?",
          "لا يوجد حجز قيد التنفيذ. ماذا تود أن تشاهد؟",
        ),
      );
    const r = await ctx.vista.getOrder(usid).catch(() => null);
    const o = r?.Order as VistaOrder | null;
    if (!o || o.State === "cancelled") {
      await setMeta(ctx, { activeOrder: null });
      return ok(
        { active: false },
        t(
          lang,
          "That booking was cancelled. Shall we start a fresh one?",
          "تم إلغاء ذلك الحجز. هل نبدأ حجزاً جديداً؟",
        ),
      );
    }
    if (o.State === "paid")
      return ok(
        { active: false, paid: true, bookingId: o.CompletedBookingId },
        t(lang, "That booking is already paid and confirmed.", "ذلك الحجز مدفوع ومؤكد بالفعل."),
      );
    if (holdExpired(o)) return expiredChoice(ctx, usid, true, o);
    const sessionKey =
      o.CinemaId && o.Sessions?.[0]?.SessionId ? `${o.CinemaId}-${o.Sessions[0].SessionId}` : null;
    const session = sessionKey ? await ctx.catalog.sessionByKey(sessionKey) : null;
    if (session && sessionUnavailableReason(session, ctx.nowLocal)) {
      const resolved = await resolveSession(ctx, { sessionKey }, null);
      if (resolved.kind === "result") return resolved.result;
    }
    const cinema = await ctx.catalog.cinema(o.CinemaId);
    const summary = orderSummary(o, lang, ctx.nowLocal, cinemaName(cinema, lang));
    await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "order.updated", {
      userSessionId: usid,
      summary,
    });
    const left = summary.expiresAtUtc
      ? Math.max(0, Math.round((new Date(summary.expiresAtUtc).getTime() - Date.now()) / 60000))
      : null;
    const line = t(
      lang,
      `You were booking ${summary.filmTitle} at ${summary.cinemaName}, ${summary.showtimeLabel}, seats ${seatRange(summary.seats)}${left != null ? ` — held for ${left} more minute${left === 1 ? "" : "s"}` : ""}.`,
      `كنت تحجز ${summary.filmTitle} في ${summary.cinemaName}، ${summary.showtimeLabel}، المقاعد ${seatRange(summary.seats)}${left != null ? ` — محجوزة لـ ${left} دقائق أخرى` : ""}.`,
    );
    return bookingReview(ctx, o, `${line} ${t(lang, "Pick it back up?", "هل نتابع؟")}`, { active: true });
  },

  async suggest_fnb(ctx, input) {
    const lang = ctx.lang;
    const bookingId = input.bookingId ?? meta(ctx).lastBookingId;
    const booking = bookingId ? (await ctx.vista.getBooking(bookingId).catch(() => null))?.Booking : null;
    const activeId = meta(ctx).activeOrder;
    const active = activeId ? (await ctx.vista.getOrder(activeId).catch(() => null))?.Order : null;
    const unpaid = active && !["paid", "cancelled"].includes(active.State) && !holdExpired(active);
    const cinemaId =
      input.cinemaId ?? (unpaid ? active.CinemaId : booking?.CinemaId) ?? meta(ctx).lastCinemaId;
    if (!cinemaId) return ok({ needs: "cinema" }, t(lang, "Which cinema is this for?", "لأي سينما؟"));
    const { ConcessionTabs } = await ctx.vista.concessions(String(cinemaId));
    const items: Record<string, any>[] = ConcessionTabs.flatMap((tab) =>
      tab.Items.map((i) => ({ ...i, Tab: tab.Name })),
    );
    const card = (i: Record<string, any>, tag?: string) => ({
      itemId: i.Id,
      name: lang === "ar" && i.DescriptionAlt ? i.DescriptionAlt : i.Description,
      nameEn: i.Description,
      description: i.ExtendedDescription,
      priceCents: i.PriceInCents,
      price: money(i.PriceInCents, lang),
      imageUrl: i.ImageUrl,
      tab: i.Tab,
      isCombo: i.IsCombo,
      isBestSeller: i.IsBestSeller,
      tag,
      modifiers: (i.ModifierGroups ?? []).map((g: any) => ({
        name: g.Name,
        required: g.IsRequired,
        options: g.Modifiers.map((m: any) => ({ id: m.Id, name: m.Description, priceCents: m.PriceInCents })),
      })),
    });
    // "your usual": the F&B on the member's most recent booking that had any
    let usual: Record<string, any>[] = [];
    let usualIds: { itemId: string; quantity: number }[] = [];
    if (ctx.conversation.customerId) {
      const hist = await ctx.vista
        .customerHistory(ctx.conversation.customerId)
        .catch(() => ({ history: [] as Record<string, any>[] }));
      const last = hist.history.find((h) => (h.concessionItemIds ?? []).length);
      if (last) {
        const counts = new Map<string, number>();
        for (const id of last.concessionItemIds as string[]) counts.set(id, (counts.get(id) ?? 0) + 1);
        usualIds = [...counts.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
        usual = usualIds
          .map((u) => items.find((i) => i.Id === u.itemId))
          .filter(Boolean)
          .map((i) => card(i!, t(lang, "Your usual", "طلبك المعتاد")));
      }
    }
    const popular = items
      .filter((i) => i.IsBestSeller && !usual.some((u) => u.itemId === i.Id))
      .slice(0, 3)
      .map((i) => card(i, t(lang, "Popular", "الأكثر طلباً")));
    const picks = [...usual, ...popular];
    await setMeta(ctx, { usualFnb: usualIds });
    const usualText = usual
      .map((u) => `${usualIds.find((x) => x.itemId === u.itemId)?.quantity ?? 1}× ${u.nameEn}`)
      .join(" + ");
    const speech = usual.length
      ? t(
          lang,
          `Last time you had ${usualText} — same again, or something else?`,
          `في المرة الماضية طلبت ${usualText} — الطلب نفسه أم شيء آخر؟`,
        )
      : t(
          lang,
          `Popular picks are ${joinList(popular.map((p) => `${p.nameEn} ${p.price}`))}. Anything for the show?`,
          `الأكثر طلباً: ${joinList(
            popular.map((p) => `${p.name} ${p.price}`),
            "ar",
          )}. هل تريد شيئاً للعرض؟`,
        );
    return ok(
      { usual: usualIds, items: picks, cinemaId },
      speech,
      {
        type: "menu",
        title: t(lang, "Food & drinks", "المأكولات والمشروبات"),
        items: picks,
        meta: {
          quick: true,
          usual: usualIds,
          bookingId: unpaid ? undefined : bookingId,
          userSessionId: unpaid ? activeId : undefined,
          stage: "food",
        },
        actions: [
          ...(usual.length
            ? [
                {
                  label: t(lang, "Same as last time", "نفس المرة الماضية"),
                  value: "fnb_usual",
                  style: "primary" as const,
                },
              ]
            : []),
          { label: t(lang, "See full menu", "القائمة الكاملة"), value: "menu:open" },
          { label: t(lang, "No food, thanks", "لا شكراً"), value: "fnb_skip" },
        ],
      },
      { name: "fnb_info", status: "completed" },
    );
  },

  async order_fnb(ctx, input) {
    const lang = ctx.lang;
    let items = input.items ?? [];
    if (input.repeatUsual && !items.length) {
      if (!(meta(ctx).usualFnb as unknown[] | undefined)?.length)
        await quickHandlers.suggest_fnb(ctx, { bookingId: input.bookingId });
      const usual = (meta(ctx).usualFnb as { itemId: string; quantity: number }[] | undefined) ?? [];
      if (usual.length) items = usual;
    }
    if (!items.length)
      return err(ErrorCodes.VALIDATION, t(lang, "Which items would you like?", "ما الأصناف التي تريدها؟"));
    // Before payment, food belongs to the same ticket basket and appears in the same final total.
    const activeId = meta(ctx).activeOrder;
    const active =
      !input.bookingId && activeId ? (await ctx.vista.getOrder(activeId).catch(() => null))?.Order : null;
    if (active && !["paid", "cancelled"].includes(active.State) && active.Sessions?.[0]?.Tickets?.length) {
      if (holdExpired(active)) return expiredChoice(ctx, activeId!, true, active);
      const r = await ctx.vista.addConcessions({
        UserSessionId: activeId!,
        CinemaId: active.CinemaId,
        Replace: true,
        Concessions: mergeFoodItems(active, items),
      });
      const failed = Array.isArray(r.FailedConcessions) ? r.FailedConcessions : [];
      const result = await bookingReview(
        ctx,
        r.Order,
        failed.length
          ? t(
              lang,
              "Some snacks could not be added. Please review what is in your basket.",
              "تعذرت إضافة بعض الوجبات الخفيفة. يرجى مراجعة محتويات طلبك.",
            )
          : t(
              lang,
              "Snacks added. Your tickets and food are ready for one payment.",
              "تمت إضافة الوجبات الخفيفة. التذاكر والطعام جاهزان للدفع معاً.",
            ),
        { combinedCheckout: true, ...(failed.length ? { failed, needs: "food_review" } : {}) },
      );
      await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "order.updated", {
        userSessionId: activeId,
        summary: result.data?.order,
      });
      return result;
    }
    const bookingId = input.bookingId ?? meta(ctx).lastBookingId;
    const booking = bookingId ? (await ctx.vista.getBooking(bookingId).catch(() => null))?.Booking : null;
    if (!booking)
      return err(
        ErrorCodes.NOT_FOUND,
        t(lang, "Pick a show first, then we can add snacks.", "اختر عرضاً أولاً، ثم نضيف الوجبات الخفيفة."),
      );
    const existingId = meta(ctx).fnbOrder;
    const existingOrder = existingId ? (await ctx.vista.getOrder(existingId))?.Order : null;
    const sameBooking =
      meta(ctx).fnbForBookingId === bookingId ||
      (!meta(ctx).fnbForBookingId && !input.bookingId && meta(ctx).lastBookingId === bookingId);
    const reusable =
      existingOrder &&
      !["paid", "cancelled", "expired"].includes(existingOrder.State) &&
      !holdExpired(existingOrder) &&
      sameBooking &&
      existingOrder.CinemaId === booking.CinemaId &&
      String(existingOrder.Sessions?.[0]?.SessionId) === String(booking.SessionId) &&
      !(existingOrder.Sessions?.[0]?.Tickets?.length ?? 0);
    const userSessionId = reusable
      ? existingId!
      : `usid_${createHash("sha256").update(`${ctx.conversation.id}:${ctx.toolCallId}:food`).digest("hex").slice(0, 24)}`;
    const r = await ctx.vista.addConcessions({
      UserSessionId: userSessionId,
      CinemaId: booking.CinemaId,
      SessionId: booking.SessionId,
      Replace: true,
      Concessions: mergeFoodItems(reusable ? existingOrder! : null, items),
    });
    await setMeta(ctx, {
      fnbOrder: userSessionId,
      fnbForBookingId: bookingId,
      activeOrder: userSessionId,
      activeSessionKey: `${booking.CinemaId}-${booking.SessionId}`,
      lastCinemaId: booking.CinemaId,
    });
    const cinema = await ctx.catalog.cinema(booking.CinemaId);
    const summary = orderSummary(r.Order, lang, ctx.nowLocal, cinemaName(cinema, lang));
    await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "order.updated", { userSessionId, summary });
    const failed = Array.isArray(r.FailedConcessions) ? r.FailedConcessions : [];
    if (failed.length)
      return ok(
        { userSessionId, fnbOrder: userSessionId, order: summary, failed, needs: "food_review" },
        t(
          lang,
          "Some snacks could not be added. Please review what is in your basket before payment.",
          "تعذرت إضافة بعض الوجبات الخفيفة. يرجى مراجعة محتويات طلبك قبل الدفع.",
        ),
        {
          type: "order",
          title: t(lang, "Food & drinks", "المأكولات والمشروبات"),
          items: [summary],
          meta: { userSessionId, stage: "food", failed },
          actions: [{ label: t(lang, "See full menu", "القائمة الكاملة"), value: "menu:open" }],
        },
      );
    const line = t(
      lang,
      `${joinList(summary.concessions.map((c) => `${c.quantity}× ${c.description}`))} — ${summary.total}, ready at the Candy Bar for your ${booking.FilmTitle} show.`,
      `${joinList(
        summary.concessions.map((c) => `${c.quantity}× ${c.description}`),
        "ar",
      )} — ${summary.total}، جاهز عند الكاندي بار لعرض ${booking.FilmTitle}.`,
    );
    const customer = ctx.conversation.customerId ? await loadCustomer(ctx) : null;
    const sheet = await reviewAndPay(
      ctx,
      {
        userSessionId,
        method: customer?.savedCards?.length ? "SAVED_CARD" : "CARD",
        customer: customer
          ? undefined
          : {
              name: `${booking.Customer?.FirstName ?? ""} ${booking.Customer?.LastName ?? ""}`.trim(),
              email: booking.Customer?.Email ?? "",
              phone: booking.Customer?.Phone ?? "",
            },
      },
      { fnbOnly: true },
    );
    if (!sheet.ok) return sheet;
    return {
      ...sheet,
      speech: `${line} ${t(lang, "Shall I take the payment?", "هل أكمل الدفع؟")}`,
      journey: { name: "fnb_preorder", status: "started" },
      data: { ...(sheet.data ?? {}), fnbOrder: userSessionId, order: summary },
    };
  },
};

/** Serialize quick mutations across API replicas and replay the same request's completed result. */
async function runQuick<N extends "quick_book" | "recover_order" | "order_fnb">(
  name: N,
  ctx: ToolCtx,
  input: Parameters<ToolHandlers[N]>[1],
): Promise<ToolResult> {
  const requestKey = (input as { idempotencyKey?: string }).idempotencyKey ?? ctx.toolCallId;
  const idempotencyKey = `quick:${createHash("sha256").update(`${ctx.conversation.id}:${name}:${requestKey}`).digest("hex")}`;
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quick:${ctx.conversation.id}`}))`);
    const existing = (
      await tx.select().from(S.actions).where(eq(S.actions.idempotencyKey, idempotencyKey))
    )[0];
    if (existing?.result?.toolResult) return existing.result.toolResult as ToolResult;
    if (existing)
      return err(
        ErrorCodes.ORDER_INVALID_STATE,
        "That request hasn't confirmed its result. Check the current order before retrying.",
        true,
      );
    let started: Awaited<ReturnType<typeof beginInlineBasketMutation>>;
    try {
      started = await beginInlineBasketMutation(ctx.db, {
        conversationId: ctx.conversation.id,
        type: name,
        idempotencyKey,
        payload: input as Record<string, unknown>,
        toolCallId: ctx.toolCallId,
        authGeneration: Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0),
      });
    } catch (error) {
      if (error instanceof DomainError)
        return err(
          error.code,
          error.message,
          error.retryable,
          error.detail as Record<string, unknown> | undefined,
        );
      throw error;
    }
    Object.assign(ctx.conversation, started.conversation);
    const previousMutation = ctx.checkoutMutationActionId;
    ctx.checkoutMutationActionId = started.action.id;
    let renewing = false;
    const renewal = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        await renewLease(ctx.db, started.action);
      } catch {
        /* Completion is fenced if the lease cannot be renewed. */
      } finally {
        renewing = false;
      }
    }, 30_000);
    renewal.unref();
    const handler = quickHandlers[name] as (
      ctx: ToolCtx,
      input: Parameters<ToolHandlers[N]>[1],
    ) => Promise<ToolResult>;
    try {
      const result = await handler(ctx, input);
      if (!(await finishInlineBasketMutation(ctx.db, started.action, result)))
        return err(
          ErrorCodes.ORDER_INVALID_STATE,
          "That request needs a fresh status check. Check the current order before retrying.",
          true,
        );
      return result;
    } catch (error) {
      await finishInlineBasketMutation(
        ctx.db,
        started.action,
        err(
          ErrorCodes.INTERNAL,
          "The booking change did not finish. Check the current order before retrying.",
          true,
        ),
      );
      throw error;
    } finally {
      clearInterval(renewal);
      ctx.checkoutMutationActionId = previousMutation;
    }
  });
}

export const quickTools: typeof quickHandlers = {
  ...quickHandlers,
  quick_book: (ctx, input) => runQuick("quick_book", ctx, input),
  recover_order: (ctx, input) => runQuick("recover_order", ctx, input),
  order_fnb: (ctx, input) => runQuick("order_fnb", ctx, input),
};

export type { OfferHint };
export { describeBenefit };
