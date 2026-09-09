import { ErrorCodes } from "@voxi/contracts";
import { schema as S } from "@voxi/db";
import {
  buildTasteProfile,
  clockMinutes,
  inferCustomerProfile,
  normaliseFilmLanguage,
  preferenceCalendar,
  recommendConcessions,
  resolveSpokenDate,
  scoreFilm,
  scorePreferredTime,
  scoreSession,
  similarity,
} from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { eq } from "drizzle-orm";
import { enqueue, idem, toRef, waitFor } from "../actions/ledger.js";
import { addTopic, markJourney } from "../services/conversation.js";
import { fmtDateTime, money, t } from "../services/format.js";
import { buildBookingState, orderSummary } from "../services/order-state.js";
import { actionSpeech } from "./bookings.js";
import { filmCard, sessionCard } from "./movies.js";
import { type ToolCtx, type ToolHandlers, err, ok } from "./types.js";

export async function loadCustomer(ctx: ToolCtx) {
  if (!ctx.conversation.isLoggedIn || !ctx.conversation.customerId) return null;
  try {
    return await ctx.vista.customer(ctx.conversation.customerId);
  } catch (e) {
    if (e instanceof VistaClientError && e.status === 404) return null;
    throw e;
  }
}

export const customerTools: Pick<
  ToolHandlers,
  | "get_session_context"
  | "login_customer"
  | "get_loyalty_balance"
  | "get_recommendations"
  | "submit_feedback"
  | "create_complaint"
  | "transfer_to_agent"
  | "log_journey"
  | "get_action_result"
> = {
  async get_session_context(ctx) {
    const c = await loadCustomer(ctx);
    const active = (ctx.conversation.metadata as { activeOrder?: string; activeSessionKey?: string })
      ?.activeOrder;
    const activeResult = active ? await ctx.vista.getOrder(active).catch(() => null) : null;
    const activeOrder = activeResult?.Order;
    const ended = !activeOrder || ["paid", "cancelled"].includes(String(activeOrder.State));
    const cinema = activeOrder && !ended ? await ctx.catalog.cinema(activeOrder.CinemaId) : null;
    const summary =
      activeOrder && !ended
        ? orderSummary(
            activeOrder,
            ctx.lang,
            ctx.nowLocal,
            cinema ? (ctx.lang === "ar" ? cinema.nameAlt || cinema.name : cinema.name) : activeOrder.CinemaId,
          )
        : null;
    const bookingState = summary ? buildBookingState(summary) : null;
    const data = {
      conversationId: ctx.conversation.id,
      language: ctx.lang,
      channel: ctx.conversation.channel,
      modality: ctx.conversation.modality,
      isLoggedIn: !!c,
      customer: c
        ? {
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            memberId: c.memberId,
            tier: c.tier,
            preferredLanguage: c.preferredLanguage,
            homeCinemaId: c.homeCinemaId,
            sharePoints: c.sharePoints,
            voxCreditCents: c.voxRewardsCents,
            preferences: c.preferences,
            profile: c.profile,
          }
        : null,
      hasLocation: !!ctx.conversation.geo,
      location: ctx.conversation.geo?.label ?? (ctx.conversation.geo ? "shared GPS position" : null),
      activeOrder:
        active && !ended
          ? {
              userSessionId: active,
              sessionKey: summary?.sessionId
                ? `${summary.cinemaId}-${summary.sessionId}`
                : (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey,
              state: activeOrder.State,
              expiresAtUtc: activeOrder.ExpiresAtUtc ?? activeOrder.ExpiryDateUtc ?? null,
              requiresFreshHold: bookingState?.requiresFreshHold ?? false,
              summary,
              bookingState,
            }
          : null,
      mode: ctx.conversation.mode,
      localTime: ctx.nowLocal,
      market: ctx.cfg.market,
    };
    const speech = c
      ? t(
          ctx.lang,
          `Welcome back, ${c.firstName}. You're logged in as a SHARE ${c.tier ?? ""} member with ${c.sharePoints} Share Points and ${money(c.voxRewardsCents, ctx.lang)} VOX credit.`,
          `مرحباً بعودتك ${c.firstName}. أنت مسجل كعضو شير ${c.tier ?? ""} ولديك ${c.sharePoints} نقطة شير و${money(c.voxRewardsCents, "ar")} رصيد فوكس.`,
        )
      : t(
          ctx.lang,
          "You're browsing as a guest. Logging in lets me use your VOX credit, Share Points and bookings.",
          "أنت تتصفح كضيف. تسجيل الدخول يتيح لي استخدام رصيد فوكس ونقاط شير وحجوزاتك.",
        );
    return ok(data, speech);
  },

  async login_customer(ctx) {
    return err(
      ErrorCodes.LOGIN_REQUIRED,
      t(
        ctx.lang,
        "Use Sign in above to enter your email and password securely.",
        "سجّل الدخول من الزر بالأعلى باستخدام بريدك وكلمة المرور بأمان.",
      ),
      false,
      { action: "open_sign_in" },
    );
  },

  async get_loyalty_balance(ctx, input) {
    const memberId = ctx.conversation.memberId;
    if (!ctx.conversation.isLoggedIn || !memberId || (input.memberId && input.memberId !== memberId))
      return err(
        ErrorCodes.LOGIN_REQUIRED,
        t(
          ctx.lang,
          "Please log in first so I can check your balance.",
          "يرجى تسجيل الدخول أولاً للتحقق من رصيدك.",
        ),
      );
    const b = await ctx.vista.balances(memberId);
    const pts = b.Balances.find((x) => x.BalanceTypeId === "SHARE_POINTS")!;
    const credit = b.Balances.find((x) => x.BalanceTypeId === "VOX_REWARDS")!;
    return ok(
      {
        memberId,
        tier: b.Tier,
        sharePoints: pts.Points,
        sharePointsValueCents: pts.ValueCents,
        voxCreditCents: credit.ValueCents,
      },
      t(
        ctx.lang,
        `You have ${pts.Points} Share Points, worth ${money(pts.ValueCents, ctx.lang)}, and ${money(credit.ValueCents, ctx.lang)} VOX credit. Both can be used towards tickets and food.`,
        `لديك ${pts.Points} نقطة شير بقيمة ${money(pts.ValueCents, "ar")}، و${money(credit.ValueCents, "ar")} رصيد فوكس. يمكن استخدامهما للتذاكر والطعام.`,
      ),
      {
        type: "loyalty",
        items: [
          {
            tier: b.Tier,
            sharePoints: pts.Points,
            sharePointsValueCents: pts.ValueCents,
            voxCreditCents: credit.ValueCents,
          },
        ],
      },
    );
  },

  async get_recommendations(ctx, input) {
    const c = await loadCustomer(ctx);
    const history = c ? (await ctx.vista.customerHistory(c.id).catch(() => ({ history: [] }))).history : [];
    const calendar = preferenceCalendar(process.env);
    const inferred = inferCustomerProfile(
      history.map((h) => ({
        cinemaId: h.cinemaId,
        language: h.language,
        showtime: h.showtime,
        seatPreference: h.seatPreference,
      })),
      calendar,
      ctx.nowLocal,
    );
    const profile = buildTasteProfile(
      c?.preferences ?? {},
      history.map((h) => ({
        hoCode: h.hoCode,
        genres: h.genres ?? [],
        language: h.language ?? "",
        experience: h.experience,
        cinemaId: h.cinemaId,
        showtime: h.showtime,
        concessionItemIds: h.concessionItemIds ?? [],
      })),
      calendar,
    );
    const FAMILY = new Set(["Family", "Animation", "Kids"]);
    const isFamilyFilm = (genres: string[], rating?: string | null) =>
      genres.some((g) => FAMILY.has(g)) || rating === "G";
    // History informs ranking; it never forces an extra "are children joining?" question.
    const wantLang = normaliseFilmLanguage(input.language);
    let films = (await ctx.catalog.films()).filter((f) => f.status === "now_showing");
    if (wantLang) films = films.filter((f) => similarity(f.language, wantLang) >= 0.7);
    if (input.withChildren === true) films = films.filter((f) => !/^(15|18|21)\+?$/.test(f.rating ?? ""));
    else if (input.withChildren === false) films = films.filter((f) => !isFamilyFilm(f.genres, f.rating));

    let requestedCinema = input.cinemaId;
    if (input.cinemaName && !requestedCinema) {
      const resolved = await ctx.catalog.resolveCinema(input.cinemaName);
      if (!resolved || resolved.score < 0.65)
        return err(
          ErrorCodes.NOT_FOUND,
          t(ctx.lang, "I couldn't match that cinema. Which VOX did you mean?", "أي سينما فوكس تقصد؟"),
        );
      requestedCinema = resolved.cinema.id;
    }
    const cinemas = await ctx.catalog.cinemas();
    const preferredCinema = inferred.cinemaId ?? c?.homeCinemaId;
    const cinemaIds = requestedCinema
      ? [requestedCinema]
      : [
          ...(preferredCinema ? [preferredCinema] : []),
          ...cinemas.map((cinema) => cinema.id).filter((id) => id !== preferredCinema),
        ];
    const date = resolveSpokenDate(input.date, ctx.nowLocal);
    const eligibleFilmIds = new Set(films.map((film) => film.hoCode));
    const sessions = (await Promise.all(cinemaIds.map((id) => ctx.catalog.sessions(id))))
      .flat()
      .filter(
        (s) =>
          s.showtime > ctx.nowLocal &&
          s.showtime.slice(0, 10) === date &&
          !s.soldOut &&
          s.allowTicketSales &&
          s.seatsAvailable > 0 &&
          eligibleFilmIds.has(s.hoCode),
      );
    const withinWindow = (showtime: string) => {
      const time = showtime.slice(11, 16);
      return (!input.timeFrom || time >= input.timeFrom) && (!input.timeTo || time <= input.timeTo);
    };
    const targetMinutes = input.time ? clockMinutes(input.time) : null;
    const windowed = sessions.filter((s) => withinWindow(s.showtime));
    const outsideWindow = !windowed.length && sessions.length > 0 && !!(input.timeFrom || input.timeTo);
    const windowDistance = (showtime: string) => {
      const minute = clockMinutes(showtime.slice(11, 16));
      if (input.timeFrom && minute < clockMinutes(input.timeFrom))
        return clockMinutes(input.timeFrom) - minute;
      if (input.timeTo && minute > clockMinutes(input.timeTo)) return minute - clockMinutes(input.timeTo);
      return 0;
    };
    const nearestWindowDistance = Math.min(...sessions.map((session) => windowDistance(session.showtime)));
    const candidateSessions = outsideWindow
      ? sessions.filter((session) => windowDistance(session.showtime) === nearestWindowDistance)
      : windowed;
    const distance = (showtime: string) =>
      targetMinutes == null ? 0 : Math.abs(clockMinutes(showtime.slice(11, 16)) - targetMinutes);
    const closest =
      targetMinutes == null ? 0 : Math.min(...candidateSessions.map((s) => distance(s.showtime)));
    const timed =
      targetMinutes == null
        ? candidateSessions
        : candidateSessions.filter((s) => distance(s.showtime) <= Math.max(30, closest));
    const isAlternative = outsideWindow || (targetMinutes != null && closest > 0 && Number.isFinite(closest));
    const availableFilms = films.filter((f) => timed.some((s) => s.hoCode === f.hoCode));
    const ranking = availableFilms
      .map((film) => {
        const base = scoreFilm(
          {
            hoCode: film.hoCode,
            title: film.title,
            genreNames: film.genres,
            language: film.language,
            rating: film.rating,
            status: film.status,
          },
          profile,
        );
        const candidates = timed
          .filter((s) => s.hoCode === film.hoCode)
          .map((s) => {
            const explicitTimeScore =
              targetMinutes == null
                ? 0
                : -Math.abs(clockMinutes(s.showtime.slice(11, 16)) - targetMinutes) / 15;
            return {
              s,
              score:
                explicitTimeScore +
                (targetMinutes == null ? scorePreferredTime(s.showtime, inferred) : 0) +
                (s.cinemaId === preferredCinema ? 5 : 0) +
                scoreSession(s, profile) / 4,
            };
          })
          .sort((a, b) => b.score - a.score || a.s.showtime.localeCompare(b.s.showtime));
        const best = candidates[0]!;
        const preferredLanguageScore = !wantLang && inferred.movieLanguage === film.language ? 20 : 0;
        const familyScore = input.withChildren === true && isFamilyFilm(film.genres, film.rating) ? 10 : 0;
        return {
          film,
          best: best.s,
          score: base.score + best.score + preferredLanguageScore + familyScore,
          why: base.why,
        };
      })
      .sort((a, b) => b.score - a.score || a.best.showtime.localeCompare(b.best.showtime));
    const movieItems =
      input.kind === "fnb"
        ? []
        : ranking.slice(0, isAlternative ? 1 : input.limit).map((r) => {
            const cinema = cinemas.find((cn) => cn.id === r.best.cinemaId);
            return {
              ...filmCard(r.film, ctx.lang),
              why: r.why,
              family: isFamilyFilm(r.film.genres, r.film.rating),
              isAlternative,
              alternativeReason: isAlternative
                ? outsideWindow
                  ? "outside_requested_time_window"
                  : "different_requested_time"
                : undefined,
              suggestedSession: sessionCard(
                r.best,
                ctx.lang,
                ctx.nowLocal,
                cinema ? (ctx.lang === "ar" ? cinema.nameAlt || cinema.name : cinema.name) : undefined,
              ),
            };
          });
    let fnbItems: Record<string, unknown>[] = [];
    if (input.kind !== "movies") {
      const cinemaId = requestedCinema ?? preferredCinema ?? cinemaIds[0];
      if (cinemaId) {
        const { ConcessionTabs } = await ctx.vista.concessions(cinemaId);
        const items = ConcessionTabs.flatMap((tab) =>
          tab.Items.map((i) => ({
            id: i.Id,
            name: i.Description,
            nameAlt: i.DescriptionAlt,
            priceCents: i.PriceInCents,
            imageUrl: i.ImageUrl,
            dietaryTags: i.DietaryTags ?? [],
            isBestSeller: !!i.IsBestSeller,
            experiences: i.Experiences ?? [],
            tab: tab.Name,
          })),
        );
        fnbItems = recommendConcessions(
          items,
          profile,
          c?.preferences ?? {},
          profile.summary.experiences[0],
          3,
        ).map((x) => ({
          itemId: x.item.id,
          name: ctx.lang === "ar" ? x.item.nameAlt || x.item.name : x.item.name,
          priceCents: x.item.priceCents,
          price: money(x.item.priceCents, ctx.lang),
          imageUrl: x.item.imageUrl,
          tab: x.item.tab,
          why: profile.items.get(x.item.id) ? t(ctx.lang, "your usual", "طلبك المعتاد") : "",
        }));
      }
    }
    const first = movieItems[0];
    const speech =
      input.kind === "fnb"
        ? t(ctx.lang, "Snacks? Here are a few easy picks.", "سناكس؟ هذه بعض الخيارات.")
        : first
          ? isAlternative
            ? t(
                ctx.lang,
                `There isn't an available show ${outsideWindow ? "in that time window" : "at that exact time"}. The nearest option is ${first.titleEn} at ${first.suggestedSession.cinemaName}, ${first.suggestedSession.time}. Would that work?`,
                `لا يوجد عرض متاح ${outsideWindow ? "ضمن الفترة المطلوبة" : "في الوقت المطلوب تماماً"}. أقرب خيار هو ${first.title} في ${first.suggestedSession.cinemaName} الساعة ${first.suggestedSession.time}. هل يناسبك؟`,
              )
            : t(
                ctx.lang,
                `${first.titleEn} at ${first.suggestedSession.cinemaName} has a ${first.suggestedSession.time} that works.`,
                `${first.title} في ${first.suggestedSession.cinemaName} الساعة ${first.suggestedSession.time} يناسبك.`,
              )
          : t(
              ctx.lang,
              `I couldn't find an available${wantLang ? ` ${wantLang}` : ""} show${input.timeFrom || input.timeTo ? " in that time window" : ""} on ${date}. Want another time or cinema?`,
              "ما لقيت عرضاً متاحاً بهذه الخيارات. نجرّب وقتاً أو سينما ثانية؟",
            );
    return ok(
      {
        movies: movieItems,
        fnb: fnbItems,
        profile: { ...profile.summary, inferred },
        personalised: !!c,
        date,
        isAlternative,
        alternativeReason: isAlternative
          ? outsideWindow
            ? "outside_requested_time_window"
            : "different_requested_time"
          : undefined,
        requestedTime: input.time,
        requestedTimeFrom: input.timeFrom,
        requestedTimeTo: input.timeTo,
      },
      speech,
      { type: "recommendation", title: t(ctx.lang, "For you", "لك"), items: [...movieItems, ...fnbItems] },
      { name: "personalisation", status: "completed" },
    );
  },

  async submit_feedback(ctx, input) {
    const { action } = await enqueue(ctx.db, ctx.events, {
      conversationId: ctx.conversation.id,
      type: "submit_feedback",
      resourceKey: `conversation:${ctx.conversation.id}`,
      idempotencyKey: idem(
        ctx.conversation.id,
        input.idempotencyKey ?? `feedback:${input.rating}:${input.comment ?? ""}`,
      ),
      payload: {
        rating: input.rating,
        comment: input.comment ?? "",
        resolved: input.resolved,
        language: ctx.lang,
        customerId: ctx.conversation.customerId,
      },
      toolCallId: ctx.toolCallId,
    });
    return ok(
      { action: toRef(action) },
      t(
        ctx.lang,
        input.rating >= 4
          ? "Thank you! I'm glad I could help. Enjoy the movie!"
          : "Thanks for the honest feedback — I've passed it on so we can improve.",
        input.rating >= 4
          ? "شكراً لك! يسعدني أنني ساعدتك. استمتع بالفيلم!"
          : "شكراً على ملاحظاتك الصادقة — تم تسجيلها لتحسين خدمتنا.",
      ),
      undefined,
      { name: "feedback", status: "completed" },
    );
  },

  async create_complaint(ctx, input) {
    const c = await loadCustomer(ctx);
    const { action, created } = await enqueue(ctx.db, ctx.events, {
      conversationId: ctx.conversation.id,
      type: "create_complaint",
      resourceKey: `conversation:${ctx.conversation.id}`,
      idempotencyKey: idem(
        ctx.conversation.id,
        input.idempotencyKey ?? `complaint:${input.category}:${input.description.slice(0, 40)}`,
      ),
      payload: {
        ...input,
        customerId: c?.id,
        customerName: input.customerName ?? (c ? `${c.firstName} ${c.lastName}` : ""),
        customerEmail: input.customerEmail ?? c?.email ?? "",
        customerPhone: input.customerPhone ?? c?.phone ?? "",
        language: ctx.lang,
      },
      toolCallId: ctx.toolCallId,
    });
    await addTopic(ctx.db, ctx.conversation.id, "complaint");
    return ok(
      { action: toRef(action), created },
      t(
        ctx.lang,
        "I'm sorry about that experience — I've logged it and you'll get a reference in a second. Would you like me to connect you to a customer care agent as well?",
        "أعتذر عن هذه التجربة — سجلت الشكوى وستحصل على رقم مرجعي حالاً. هل تريد أن أوصلك بأحد موظفي خدمة العملاء أيضاً؟",
      ),
      undefined,
      { name: "complaint", status: "started" },
    );
  },

  async transfer_to_agent(ctx, input) {
    const { action, created } = await enqueue(ctx.db, ctx.events, {
      conversationId: ctx.conversation.id,
      type: "transfer_to_agent",
      resourceKey: `conversation:${ctx.conversation.id}`,
      idempotencyKey: idem(ctx.conversation.id, input.idempotencyKey ?? `transfer:${input.reason}`),
      payload: { reason: input.reason, agentSummary: input.summary ?? "", language: ctx.lang },
      toolCallId: ctx.toolCallId,
    });
    return ok(
      { action: toRef(action), created },
      t(
        ctx.lang,
        "Of course — I'm connecting you to a customer care agent now and passing on a summary so you won't need to repeat yourself. Please stay in this chat.",
        "بالطبع — أوصلك الآن بأحد موظفي خدمة العملاء وأرسل له ملخصاً حتى لا تضطر للتكرار. يرجى البقاء في هذه المحادثة.",
      ),
      { type: "transfer", items: [{ status: "requested", reason: input.reason }] },
      { name: "transfer", status: "started" },
    );
  },

  async log_journey(ctx, input) {
    await markJourney(ctx.db, ctx.conversation.id, input.journey, input.status);
    await addTopic(ctx.db, ctx.conversation.id, input.journey);
    return ok({ logged: true });
  },

  async get_action_result(ctx, input) {
    const row = await waitFor(ctx.db, input.actionId, input.waitMs);
    if (!row) return err(ErrorCodes.NOT_FOUND, "Unknown action");
    if (row.conversationId !== ctx.conversation.id) return err(ErrorCodes.NOT_FOUND, "Unknown action");
    const ref = toRef(row);
    if (row.status === "queued" || row.status === "running")
      return ok({ action: ref, pending: true }, actionSpeech(ctx, row.status));
    const speech =
      (row.result?.speech as string | undefined) ??
      (row.error ? row.error.message : actionSpeech(ctx, row.status));
    return ok(
      { action: ref, pending: false, result: row.result, error: row.error },
      speech,
      row.result?.ui as never,
    );
  },
};

export { fmtDateTime, S, eq };
