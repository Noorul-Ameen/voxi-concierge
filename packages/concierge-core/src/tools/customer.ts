import { ErrorCodes } from "@voxi/contracts";
import { schema as S } from "@voxi/db";
import {
  buildTasteProfile,
  normaliseFilmLanguage,
  recommendConcessions,
  recommendFilms,
  resolveSpokenDate,
  scoreSession,
  similarity,
} from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { eq } from "drizzle-orm";
import { enqueue, idem, toRef, waitFor } from "../actions/ledger.js";
import { addTopic, markJourney, updateConversation } from "../services/conversation.js";
import { fmtDateTime, joinList, money, t } from "../services/format.js";
import { actionSpeech } from "./bookings.js";
import { filmCard, sessionCard } from "./movies.js";
import { type ToolCtx, type ToolHandlers, err, ok } from "./types.js";

export async function loadCustomer(ctx: ToolCtx) {
  if (!ctx.conversation.customerId) return null;
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
          }
        : null,
      hasLocation: !!ctx.conversation.geo,
      location: ctx.conversation.geo?.label ?? (ctx.conversation.geo ? "shared GPS position" : null),
      activeOrder: active
        ? {
            userSessionId: active,
            sessionKey: (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey,
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

  async login_customer(ctx, input) {
    if (!input.email && !input.phone && !input.memberId)
      return err(
        ErrorCodes.VALIDATION,
        t(
          ctx.lang,
          "Please give me the email, mobile number or SHARE member id on the account.",
          "يرجى إعطائي البريد الإلكتروني أو رقم الجوال أو رقم عضوية شير.",
        ),
      );
    try {
      const r = await ctx.vista.validateMember({
        MemberId: input.memberId,
        Email: input.email,
        Phone: input.phone,
        Pin: input.pin,
      });
      const m = r.Member;
      await updateConversation(ctx.db, ctx.conversation.id, {
        customerId: m.CustomerId,
        memberId: m.MemberId,
        isLoggedIn: true,
        language: ctx.conversation.language,
      });
      ctx.conversation.customerId = m.CustomerId;
      ctx.conversation.memberId = m.MemberId;
      ctx.conversation.isLoggedIn = true;
      const c = await ctx.vista.customer(m.CustomerId);
      return ok(
        {
          customer: {
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            memberId: c.memberId,
            tier: c.tier,
            sharePoints: c.sharePoints,
            voxCreditCents: c.voxRewardsCents,
            preferredLanguage: c.preferredLanguage,
          },
        },
        t(
          ctx.lang,
          `Thanks ${c.firstName}, you're logged in. You have ${c.sharePoints} Share Points and ${money(c.voxRewardsCents, ctx.lang)} VOX credit.`,
          `شكراً ${c.firstName}، تم تسجيل دخولك. لديك ${c.sharePoints} نقطة شير و${money(c.voxRewardsCents, "ar")} رصيد فوكس.`,
        ),
        {
          type: "loyalty",
          items: [
            {
              firstName: c.firstName,
              tier: c.tier,
              sharePoints: c.sharePoints,
              voxCreditCents: c.voxRewardsCents,
            },
          ],
        },
        { name: "login", status: "completed" },
      );
    } catch (e) {
      if (e instanceof VistaClientError && e.kind === "result") {
        const pinIssue = e.extendedResultCode === 401;
        return err(
          pinIssue ? "INVALID_PIN" : ErrorCodes.NOT_FOUND,
          pinIssue
            ? t(ctx.lang, "That PIN doesn't match. Please try again.", "رمز PIN غير صحيح. حاول مرة أخرى.")
            : t(
                ctx.lang,
                "I couldn't find a SHARE account with those details.",
                "لم أجد حساب شير بهذه البيانات.",
              ),
        );
      }
      throw e;
    }
  },

  async get_loyalty_balance(ctx, input) {
    const memberId = input.memberId ?? ctx.conversation.memberId;
    if (!memberId)
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
    const customerId = input.customerId ?? ctx.conversation.customerId;
    const c = customerId ? await ctx.vista.customer(customerId).catch(() => null) : null;
    const history = customerId
      ? (await ctx.vista.customerHistory(customerId).catch(() => ({ history: [] }))).history
      : [];
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
    );
    const FAMILY = new Set(["Family", "Animation", "Kids"]);
    const isFamilyFilm = (genres: string[], rating?: string | null) =>
      genres.some((g) => FAMILY.has(g)) || rating === "G";
    // Children's films in the history → ask before suggesting family options (never assume kids are joining)
    const familyHistory = history.some(
      (h) => isFamilyFilm(h.genres ?? [], h.rating) || h.experience === "KIDS" || (h.childTickets ?? 0) > 0,
    );
    const name = c?.firstName;
    const historyLine = c
      ? t(
          ctx.lang,
          `${[
            profile.summary.languages.length ? `${joinList(profile.summary.languages)} films` : "",
            profile.summary.genres.length
              ? joinList(profile.summary.genres.slice(0, 2).map((g) => g.toLowerCase()))
              : "",
          ]
            .filter(Boolean)
            .join(", ")}`,
          `${profile.summary.languages.length ? `أفلام ${joinList(profile.summary.languages, "ar")}` : ""}`,
        )
      : "";
    if (c && familyHistory && input.withChildren === undefined && input.kind !== "fnb") {
      return ok(
        { movies: [], fnb: [], profile: profile.summary, personalised: true, askChildren: true },
        t(
          ctx.lang,
          `${name ? `${name}, based` : "Based"} on your previous bookings${historyLine ? ` — ${historyLine}` : ""} — I can suggest a few. I also see family films in your history: will children be joining this time, or is it just adults?`,
          `${name ? `${name}، بناءً` : "بناءً"} على حجوزاتك السابقة يمكنني اقتراح بعض الأفلام. لاحظت أفلاماً عائلية في سجلك: هل سيرافقك أطفال هذه المرة، أم الكبار فقط؟`,
        ),
        undefined,
        { name: "personalisation", status: "started" },
      );
    }
    const wantLang = normaliseFilmLanguage(input.language);
    let films = (await ctx.catalog.films()).filter((f) => f.status === "now_showing");
    if (wantLang) {
      const inLang = films.filter((f) => similarity(f.language, wantLang) >= 0.7);
      if (inLang.length) films = inLang;
    }
    if (input.withChildren === true) films = films.filter((f) => !/^(15|18|21)\+?$/.test(f.rating ?? ""));
    else if (input.withChildren === false) films = films.filter((f) => !isFamilyFilm(f.genres, f.rating));
    const recsRaw = recommendFilms(
      films.map((f) => ({
        hoCode: f.hoCode,
        title: f.title,
        genreNames: f.genres,
        language: f.language,
        rating: f.rating,
        status: f.status,
      })),
      profile,
      input.limit + 4,
    );
    // family first when children are coming
    const recs = (
      input.withChildren === true
        ? [...recsRaw].sort(
            (a, b) =>
              Number(isFamilyFilm(b.film.genreNames, b.film.rating)) -
              Number(isFamilyFilm(a.film.genreNames, a.film.rating)),
          )
        : recsRaw
    ).slice(0, input.limit);
    // where: the guest's shared/selected location wins over history; then the requested cinema; then their usual cinemas
    let cinemaIds: string[];
    let nearLabel = "";
    if (input.cinemaId) cinemaIds = [input.cinemaId];
    else if (ctx.conversation.geo) {
      const near = await ctx.catalog.nearestCinemas(ctx.conversation.geo.lat, ctx.conversation.geo.lng, 3);
      cinemaIds = near.map((x) => x.id);
      nearLabel = ctx.conversation.geo.label ?? "";
    } else
      cinemaIds = profile.summary.cinemas.length
        ? profile.summary.cinemas
        : c?.homeCinemaId
          ? [c.homeCinemaId]
          : ["0002"];
    const date = resolveSpokenDate(input.date, ctx.nowLocal);
    const sessions = (await Promise.all(cinemaIds.map((id) => ctx.catalog.sessions(id))))
      .flat()
      .filter((s) => s.showtime >= ctx.nowLocal && s.showtime.slice(0, 10) >= date);
    const movieItems = await Promise.all(
      recs.map(async (r) => {
        const f = films.find((x) => x.hoCode === r.film.hoCode)!;
        const best = sessions
          .filter((s) => s.hoCode === f.hoCode)
          .map((s) => ({
            s,
            score: scoreSession(
              {
                cinemaId: s.cinemaId,
                hoCode: s.hoCode,
                experience: s.experience,
                showtime: s.showtime,
                seatsAvailable: s.seatsAvailable,
              },
              profile,
            ),
          }))
          .sort((a, b) => b.score - a.score)[0]?.s;
        const cn = best ? await ctx.catalog.cinema(best.cinemaId) : null;
        return {
          ...filmCard(f, ctx.lang),
          why: r.why,
          family: isFamilyFilm(f.genres, f.rating),
          suggestedSession: best
            ? sessionCard(
                best,
                ctx.lang,
                ctx.nowLocal,
                cn ? (ctx.lang === "ar" ? cn.nameAlt || cn.name : cn.name) : undefined,
              )
            : undefined,
        };
      }),
    );
    let fnbItems: Record<string, unknown>[] = [];
    if (input.kind !== "movies") {
      const cinemaId = input.cinemaId ?? cinemaIds[0]!;
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
        why: profile.items.get(x.item.id)
          ? t(ctx.lang, "you've ordered this before", "طلبته من قبل")
          : x.item.isBestSeller
            ? t(ctx.lang, "best seller", "الأكثر مبيعاً")
            : "",
      }));
    }
    const speech = c
      ? t(
          ctx.lang,
          `${name ? `${name}, based` : "Based"} on your previous bookings${wantLang ? ` — you asked for ${wantLang} films, so I've kept to those` : historyLine ? ` — ${historyLine}` : ""}${input.withChildren === true ? ", and with the children coming" : ""} — here are some you may enjoy: ${joinList(movieItems.slice(0, 3).map((m) => m.titleEn))}${movieItems[0]?.suggestedSession ? `. ${movieItems[0].titleEn} has a ${movieItems[0].suggestedSession.experience} show ${movieItems[0].suggestedSession.dateLabel} at ${movieItems[0].suggestedSession.time} at ${movieItems[0].suggestedSession.cinemaName}${nearLabel ? ` near ${nearLabel}` : ""}` : ""}.${fnbItems.length ? ` Your usual ${fnbItems[0]!.name as string} is on the menu too.` : ""} Which one appeals, or would you like a different kind of film?`,
          `${name ? `${name}، بناءً` : "بناءً"} على حجوزاتك السابقة، إليك بعض الأفلام التي قد تعجبك: ${joinList(
            movieItems.slice(0, 3).map((m) => m.title),
            "ar",
          )}.${fnbItems.length ? ` وطلبك المعتاد ${fnbItems[0]!.name as string} متوفر.` : ""} أيها يناسبك، أم تفضل نوعاً آخر؟`,
        )
      : t(
          ctx.lang,
          `Popular right now${wantLang ? ` in ${wantLang}` : ""}: ${joinList(movieItems.slice(0, 3).map((m) => m.titleEn))}. Tell me what you like — action, family, Bollywood — and I'll narrow it down.`,
          `الأكثر رواجاً الآن: ${joinList(
            movieItems.slice(0, 3).map((m) => m.title),
            "ar",
          )}. أخبرني بما تحب وسأقترح لك.`,
        );
    return ok(
      { movies: movieItems, fnb: fnbItems, profile: profile.summary, personalised: !!c },
      speech,
      {
        type: "recommendation",
        title: t(ctx.lang, name ? `For you, ${name}` : "Recommended", name ? `لك يا ${name}` : "مقترحات"),
        items: [...movieItems, ...fnbItems],
      },
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
