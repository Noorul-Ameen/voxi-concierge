import { ErrorCodes } from "@voxi/contracts";
import { prefixedId } from "@voxi/db";
import { describeBenefit } from "@voxi/domain";
import { VistaClientError } from "@voxi/vista-client";
import { enqueue, idem, toRef } from "../actions/ledger.js";
import { createConfirmation } from "../services/confirmations.js";
import { updateConversation } from "../services/conversation.js";
import { fmtDateTime, joinList, money, seatLabels, t } from "../services/format.js";
import { loadCustomer } from "./customer.js";
import { experienceLabel } from "./movies.js";
import { type ToolCtx, type ToolHandlers, err, ok } from "./types.js";

/** Child-only ticket types make no sense for 15+/18+/21+ films — hide them so the agent never offers them. */
function adultsOnly(rating: string | undefined) {
  return /^(15|18|21)\+?$/.test((rating ?? "").trim());
}

export type VistaOrder = Record<string, any>;

export function orderSummary(o: VistaOrder, lang: "en" | "ar", nowLocal: string, cinemaName?: string) {
  const sess = o.Sessions?.[0];
  const tickets = (sess?.Tickets ?? []) as any[];
  const concessions = (o.Concessions ?? []) as any[];
  return {
    userSessionId: o.UserSessionId,
    state: o.State,
    cinemaId: o.CinemaId,
    cinemaName,
    sessionId: sess?.SessionId != null ? String(sess.SessionId) : undefined,
    filmTitle: sess ? (lang === "ar" && sess.AltFilmTitle ? sess.AltFilmTitle : sess.FilmTitle) : undefined,
    showtime: sess?.ShowingRealDateTimeOffset?.slice(0, 19),
    showtimeLabel: sess?.ShowingRealDateTimeOffset
      ? fmtDateTime(sess.ShowingRealDateTimeOffset.slice(0, 19), lang, nowLocal)
      : undefined,
    experience: sess?.Experience,
    screenName: sess?.ScreenName,
    tickets: tickets.map((t) => ({
      id: t.Id,
      description: t.Description,
      seat: t.SeatData,
      priceCents: t.PriceCents,
      discountCents: t.DiscountPriceCents,
      finalCents: t.FinalPriceCents,
      deal: t.DealDescription,
    })),
    seats: seatLabels(tickets),
    seatsAllocated: !!sess?.SeatsAllocated,
    concessions: concessions.map((c) => ({
      id: c.Id,
      itemId: c.ItemId,
      description: c.Description,
      quantity: c.Quantity,
      unitCents: c.UnitPriceCents ?? c.PriceCents,
      finalCents: c.FinalPriceCents,
      modifiers: (c.Modifiers ?? []).map((m: any) => m.Description),
    })),
    offers: (o.AppliedOffers ?? []).map((a: any) => ({
      id: a.offerId,
      title: a.title,
      discountCents: a.discountCents,
      type: a.type,
    })),
    subtotalCents:
      tickets.reduce((a, t) => a + t.PriceCents, 0) +
      concessions.reduce((a, c) => a + (c.UnitPriceCents ?? c.PriceCents) * c.Quantity, 0),
    discountCents: o.DiscountValueCents ?? 0,
    loyaltyRedeemedCents: o.LoyaltyPointsPayableValueInCents ?? 0,
    bookingFeeCents: o.BookingFeeValueCents ?? 0,
    taxCents: o.TaxValueCents ?? 0,
    totalCents: o.TotalValueCents ?? 0,
    total: money(o.TotalValueCents ?? 0, lang),
    expiresAtUtc: o.ExpiryDateUtc,
  };
}

/**
 * Order edits are idempotent per order *version*: the same request repeated while nothing changed is deduplicated
 * (double-tap safe), but after the basket changes — 2 tickets → 4 → 2 again — it runs again instead of replaying
 * the earlier result.
 */
async function orderVersion(ctx: ToolCtx, userSessionId: string): Promise<string> {
  const cur = await ctx.vista.getOrder(userSessionId).catch(() => null);
  const o = cur?.Order;
  return o ? `v${o.Version ?? ""}` : "v0";
}

const activeOrder = (ctx: ToolCtx): string | undefined =>
  (ctx.conversation.metadata as { activeOrder?: string })?.activeOrder;

async function cinemaName(ctx: ToolCtx, id?: string) {
  if (!id) return undefined;
  const c = await ctx.catalog.cinema(id);
  return c ? (ctx.lang === "ar" ? c.nameAlt || c.name : c.name) : id;
}

async function enqueueOrderAction(
  ctx: ToolCtx,
  type: string,
  userSessionId: string,
  payload: Record<string, unknown>,
  key: string,
  speech: string,
  journey?: string,
) {
  const { action, created } = await enqueue(ctx.db, ctx.events, {
    conversationId: ctx.conversation.id,
    type,
    resourceKey: `order:${userSessionId}`,
    idempotencyKey: idem(ctx.conversation.id, key),
    payload: { userSessionId, ...payload },
    toolCallId: ctx.toolCallId,
    correlationId: ctx.correlationId,
  });
  return ok(
    { action: toRef(action), created, userSessionId },
    speech,
    undefined,
    journey ? { name: journey, status: "started" } : undefined,
  );
}

export const orderingTools: Pick<
  ToolHandlers,
  | "browse_menu"
  | "get_ticket_types"
  | "get_seat_plan"
  | "start_order"
  | "add_tickets"
  | "select_seats"
  | "add_concessions"
  | "apply_offer"
  | "redeem_points"
  | "get_order"
  | "prepare_payment"
  | "pay_order"
  | "cancel_order"
> = {
  async browse_menu(ctx, input) {
    const cinemaId =
      input.cinemaId ?? (await orderCinema(ctx)) ?? ctx.conversation.metadata?.lastCinemaId ?? "0002";
    const { ConcessionTabs } = await ctx.vista.concessions(String(cinemaId), activeOrder(ctx));
    let items: Record<string, any>[] = ConcessionTabs.flatMap((tab) =>
      tab.Items.map((i) => ({ ...i, Tab: tab.Name })),
    );
    const exp = input.experience ?? (await orderExperience(ctx));
    items = items.filter(
      (i) => !(i.Experiences ?? []).length || (exp && (i.Experiences ?? []).includes(exp)),
    );
    if (input.tab) items = items.filter((i) => i.Tab.toLowerCase().includes(input.tab!.toLowerCase()));
    if (input.dietary?.length)
      items = items.filter((i) => input.dietary!.every((d) => (i.DietaryTags ?? []).includes(d)));
    if (input.query) {
      // Tolerant matching: "7up" → "7 Up", "cocacola" → "Coca-Cola", "nachos cheese" → "Cheese Nachos".
      const norm = (s: string) =>
        String(s ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
      const hay = (i: Record<string, any>) =>
        norm(`${i.Description} ${i.DescriptionAlt} ${i.ExtendedDescription} ${i.Tab}`);
      const tokens = String(input.query)
        .toLowerCase()
        .split(/[^a-z0-9\u0600-\u06ff]+/)
        .filter(Boolean);
      const q = norm(input.query);
      let hits = items.filter((i) => hay(i).includes(q));
      if (!hits.length && tokens.length > 1)
        hits = items.filter((i) => tokens.every((t) => hay(i).includes(t)));
      if (!hits.length) {
        const stem = (t: string) => t.replace(/(es|s)$/, "");
        hits = items.filter((i) => tokens.some((t) => t.length >= 3 && hay(i).includes(stem(t))));
      }
      items = hits;
    }
    items = items.sort((a, b) => Number(b.IsBestSeller) - Number(a.IsBestSeller)).slice(0, input.limit);
    const cards = items.map((i) => ({
      itemId: i.Id,
      name: ctx.lang === "ar" && i.DescriptionAlt ? i.DescriptionAlt : i.Description,
      nameEn: i.Description,
      description: i.ExtendedDescription,
      priceCents: i.PriceInCents,
      price: money(i.PriceInCents, ctx.lang),
      imageUrl: i.ImageUrl,
      tab: i.Tab,
      dietaryTags: i.DietaryTags ?? [],
      allergens: i.Allergens ?? [],
      calories: i.Calories,
      isCombo: i.IsCombo,
      isBestSeller: i.IsBestSeller,
      modifiers: (i.ModifierGroups ?? []).map((g: any) => ({
        name: g.Name,
        required: g.IsRequired,
        options: g.Modifiers.map((m: any) => ({ id: m.Id, name: m.Description, priceCents: m.PriceInCents })),
      })),
    }));
    if (!cards.length)
      return ok(
        { items: [] },
        t(
          ctx.lang,
          "I couldn't find anything matching that on the menu. Want to see combos, popcorn, hot food or desserts?",
          "لم أجد شيئاً مطابقاً في القائمة. هل تريد رؤية الكومبو أو الفشار أو الأطباق الساخنة أو الحلويات؟",
        ),
      );
    const tabs = [...new Set(cards.map((c) => c.tab))];
    // spoken price = what the tile shows: "from AED 21" when a size modifier makes it cheaper than the base price
    const spokenPrice = (c: (typeof cards)[number]) => {
      const sizes = c.modifiers.find((g: { name: string }) => /size/i.test(g.name));
      const from = sizes?.options?.length
        ? Math.min(
            ...sizes.options.map((o: { priceCents: number }) => (c.priceCents ?? 0) + (o.priceCents ?? 0)),
          )
        : null;
      return from !== null && from < (c.priceCents ?? 0)
        ? t(ctx.lang, `from ${money(from, ctx.lang)}`, `من ${money(from, "ar")}`)
        : c.price;
    };
    const speech =
      input.tab || input.query || input.dietary?.length
        ? t(
            ctx.lang,
            `Here's what I found: ${joinList(cards.slice(0, 4).map((c) => `${c.name} ${spokenPrice(c)}`))}${cards.length > 4 ? ` and ${cards.length - 4} more` : ""}. Want to add any to your order?`,
            `إليك ما وجدت: ${joinList(
              cards.slice(0, 4).map((c) => `${c.name} ${spokenPrice(c)}`),
              "ar",
            )}. هل تريد إضافة شيء إلى طلبك؟`,
          )
        : t(
            ctx.lang,
            `The menu has ${joinList(tabs.slice(0, 5))}${tabs.length > 5 ? " and more" : ""}. Best sellers include ${joinList(
              cards
                .filter((c) => c.isBestSeller)
                .slice(0, 3)
                .map((c) => `${c.name} (${spokenPrice(c)})`),
            )}. I can filter by vegetarian, vegan or gluten-free too.`,
            `تشمل القائمة ${joinList(tabs.slice(0, 5), "ar")}${tabs.length > 5 ? " وغيرها" : ""}. الأكثر مبيعاً: ${joinList(
              cards
                .filter((c) => c.isBestSeller)
                .slice(0, 3)
                .map((c) => `${c.name} (${c.price})`),
              "ar",
            )}. يمكنني التصفية حسب النباتي أو الخالي من الغلوتين.`,
          );
    return ok(
      { items: cards, tabs },
      speech,
      {
        type: "menu",
        title: t(ctx.lang, "Food & Drinks", "المأكولات والمشروبات"),
        items: cards,
        meta: { tabs },
      },
      { name: "fnb_info", status: "completed" },
    );
  },

  async get_ticket_types(ctx, input) {
    const s = await ctx.catalog.sessionByKey(input.sessionKey);
    if (!s)
      return err(ErrorCodes.NOT_FOUND, t(ctx.lang, "I couldn't find that showtime.", "لم أجد هذا الموعد."));
    const r = await ctx.vista.ticketTypes(s.cinemaId, s.sessionId);
    if (r.ResponseCode !== 0)
      return err(ErrorCodes.VISTA_ERROR, r.ErrorDescription ?? "Ticket types unavailable");
    const filmRating = (await ctx.catalog.film(s.hoCode))?.rating;
    const noKids = adultsOnly(filmRating);
    const types = r.Tickets.filter(
      (x) =>
        (!x.IsAvailableForLoyaltyMembersOnly || ctx.conversation.memberId) &&
        !(noKids && x.IsChildOnlyTicket),
    ).map((x) => ({
      code: x.TicketTypeCode,
      description: x.Description,
      descriptionAlt: x.DescriptionAlt,
      priceCents: x.PriceInCents,
      price: money(x.PriceInCents, ctx.lang),
      area:
        x.AreaCategoryCode === "0000000001"
          ? "premium"
          : x.AreaCategoryCode === "0000000003"
            ? "preferred_view"
            : "regular",
      isChild: x.IsChildOnlyTicket,
      membersOnly: x.IsAvailableForLoyaltyMembersOnly,
      note: x.LongDescription,
    }));
    const regular = types.filter((x) => x.area === "regular");
    const tiers = types.filter((x) => x.area !== "regular" && !x.isChild && !x.membersOnly);
    const speech = t(
      ctx.lang,
      `For ${s.filmTitle} ${experienceLabel(s.experience, "en")} at ${fmtDateTime(s.showtime, "en", ctx.nowLocal)}: ${joinList(regular.map((x) => `${x.description.replace(/^[A-Z0-9 ]+? /, "").toLowerCase()} ${x.price}`))}${tiers.length ? `, ${joinList(tiers.map((x) => `${x.description.replace(/^[A-Z0-9]+ /, "").toLowerCase()} ${x.price}`))}` : ""}. ${noKids ? `This film is rated ${filmRating}, so adults only. How many tickets?` : "How many tickets, and adults or children?"}`,
      `لفيلم ${s.filmTitle} ${experienceLabel(s.experience, "ar")} في ${fmtDateTime(s.showtime, "ar", ctx.nowLocal)}: ${joinList(
        regular.map((x) => `${x.descriptionAlt || x.description} ${x.price}`),
        "ar",
      )}. كم عدد التذاكر، للكبار أم الأطفال؟`,
    );
    return ok(
      {
        session: {
          key: s.key,
          cinemaId: s.cinemaId,
          sessionId: s.sessionId,
          showtime: s.showtime,
          experience: s.experience,
          filmTitle: s.filmTitle,
          seatsAvailable: s.seatsAvailable,
        },
        ticketTypes: types,
      },
      speech,
      { type: "order", title: t(ctx.lang, "Tickets", "التذاكر"), items: types, meta: { sessionKey: s.key } },
    );
  },

  async get_seat_plan(ctx, input) {
    const s = await ctx.catalog.sessionByKey(input.sessionKey);
    if (!s)
      return err(ErrorCodes.NOT_FOUND, t(ctx.lang, "I couldn't find that showtime.", "لم أجد هذا الموعد."));
    const usid = input.userSessionId ?? activeOrder(ctx);
    const plan = await ctx.vista.seatPlan(s.cinemaId, s.sessionId, usid);
    if (!plan.SeatLayoutData)
      return err(ErrorCodes.VISTA_ERROR, plan.ErrorDescription ?? "Seat plan unavailable");
    const areas = plan.SeatLayoutData.Areas as any[];
    const rows = areas.flatMap((a) =>
      a.Rows.map((r: any) => ({
        area: a.Description,
        areaCategoryCode: a.AreaCategoryCode,
        row: r.PhysicalName,
        rowIndex: r.RowIndexZeroBased,
        seats: r.Seats.map((x: any) => ({
          id: x.Id,
          col: x.Position.ColumnIndex,
          status: x.Status,
          style: x.SeatStyle,
        })),
      })),
    );
    const available = rows.reduce((n, r) => n + r.seats.filter((x: any) => x.status === 0).length, 0);
    const held = rows.flatMap((r) =>
      r.seats.filter((x: any) => x.status === 2).map((x: any) => `${r.row}${x.id}`),
    );
    // price per seat tier, as the real site shows it ("x1 Regular – 46.00 AED per ticket")
    const ttypes = await ctx.vista.ticketTypes(s.cinemaId, s.sessionId).catch(() => null);
    const tierLabel = (code: string) =>
      code === "0000000001" ? "Premium" : code === "0000000003" ? "Preferred View" : "Regular";
    const tiers = [...new Set(rows.map((r: any) => String(r.areaCategoryCode)))].map((code) => {
      const tt = (ttypes?.Tickets ?? []).find(
        (x: any) =>
          x.AreaCategoryCode === code && !x.IsChildOnlyTicket && !x.IsAvailableForLoyaltyMembersOnly,
      );
      return {
        area: code,
        label: tierLabel(code),
        priceCents: tt?.PriceInCents ?? null,
        price: tt ? money(tt.PriceInCents, ctx.lang) : null,
      };
    });
    // 2–3 concrete options per area of the room so the agent can offer instead of pick: adjacent free seats
    // near the centre, with the tier and price of that row (back rows are often Preferred View at a higher price)
    const need = Math.max(1, held.length || 1);
    const sorted = [...rows].sort((a: any, b: any) => (a.rowIndex ?? 0) - (b.rowIndex ?? 0));
    const third = Math.max(1, Math.ceil(sorted.length / 3));
    const regions: [string, string, any[]][] = [
      ["front", t(ctx.lang, "front", "الأمام"), sorted.slice(0, third)],
      ["middle", t(ctx.lang, "middle", "الوسط"), sorted.slice(third, third * 2)],
      ["back", t(ctx.lang, "back", "الخلف"), sorted.slice(third * 2)],
    ];
    const centreCol = Number(plan.SeatLayoutData.ColumnCount ?? 20) / 2;
    const suggestions = regions
      .map(([region, label, rs]) => {
        const options: { seats: string[]; row: string; tier: string; price: string | null }[] = [];
        for (const r of rs) {
          const free = r.seats
            .filter((x: any) => x.status === 0 || x.status === 2)
            .sort((a: any, b: any) => a.col - b.col);
          let best: any[] | null = null;
          for (let i = 0; i + need <= free.length; i++) {
            const run = free.slice(i, i + need);
            if (run[run.length - 1].col - run[0].col !== need - 1) continue;
            const off = Math.abs((run[0].col + run[run.length - 1].col) / 2 - centreCol);
            if (!best || off < Math.abs((best[0].col + best[best.length - 1].col) / 2 - centreCol))
              best = run;
          }
          if (best) {
            const code = String(r.areaCategoryCode);
            options.push({
              seats: best.map((x: any) => `${r.row}${x.id}`),
              row: r.row,
              tier: tierLabel(code),
              price: tiers.find((tt) => tt.area === code)?.price ?? null,
            });
          }
          if (options.length >= 2) break;
        }
        return { region, label, options };
      })
      .filter((x) => x.options.length);
    const optionText = suggestions
      .map(
        (sg) =>
          `${sg.label}: ${sg.options.map((o) => `${o.seats.join("-")} (${o.tier}${o.price ? ` ${o.price}` : ""})`).join(" or ")}`,
      )
      .join("; ");
    const tierText = tiers
      .filter((x) => x.price)
      .map((x) => `${x.label} ${x.price}`)
      .join(", ");
    const speech = t(
      ctx.lang,
      `${available} seats are free${held.length ? `; you currently hold ${held.join(", ")}` : ""}. The map is on screen. ${tierText ? `Seat prices: ${tierText}. ` : ""}${optionText ? `Good options — ${optionText}. ` : ""}Which would you like, or tap seats on the map?`,
      `${available} مقعداً متاحاً${held.length ? `؛ مقاعدك المحجوزة حالياً ${held.join("، ")}` : ""}. الخريطة على الشاشة. ${tierText ? `أسعار المقاعد: ${tierText}. ` : ""}${optionText ? `خيارات جيدة — ${optionText}. ` : ""}أيها تفضل، أم تختار من الخريطة؟`,
    );
    return ok(
      {
        sessionKey: s.key,
        userSessionId: usid,
        columnCount: plan.SeatLayoutData.ColumnCount,
        rowCount: plan.SeatLayoutData.RowCount,
        rows,
        available,
        held,
        tiers,
        suggestions,
      },
      speech,
      {
        type: "seatmap",
        title: t(ctx.lang, "Choose seats", "اختر المقاعد"),
        items: rows,
        meta: {
          sessionKey: s.key,
          userSessionId: usid,
          columnCount: plan.SeatLayoutData.ColumnCount,
          screenLabel: t(ctx.lang, "SCREEN", "الشاشة"),
          tiers,
          filmTitle: s.filmTitle,
          experience: s.experience,
          screenName: s.screenName,
        },
      },
    );
  },

  async start_order(ctx, input) {
    const s = await ctx.catalog.sessionByKey(input.sessionKey);
    if (!s)
      return err(ErrorCodes.NOT_FOUND, t(ctx.lang, "I couldn't find that showtime.", "لم أجد هذا الموعد."));
    if (s.soldOut || !s.allowTicketSales)
      return err(
        ErrorCodes.SEATS_UNAVAILABLE,
        t(
          ctx.lang,
          "That show is sold out. Shall I look for another time?",
          "هذا العرض مكتمل. هل أبحث عن موعد آخر؟",
        ),
      );
    if (s.showtime < ctx.nowLocal)
      return err(
        ErrorCodes.VALIDATION,
        t(ctx.lang, "That show has already started.", "بدأ هذا العرض بالفعل."),
      );
    const existing = activeOrder(ctx);
    const userSessionId = `usid_${prefixedId("o", 12).slice(2)}`;
    await updateConversation(ctx.db, ctx.conversation.id, {
      metadata: {
        ...(ctx.conversation.metadata ?? {}),
        activeOrder: userSessionId,
        activeSessionKey: s.key,
        lastCinemaId: s.cinemaId,
        previousOrder: existing,
      },
    });
    ctx.conversation.metadata = {
      ...(ctx.conversation.metadata ?? {}),
      activeOrder: userSessionId,
      activeSessionKey: s.key,
    };
    const tt = await ctx.vista.ticketTypes(s.cinemaId, s.sessionId);
    const filmRating = (await ctx.catalog.film(s.hoCode))?.rating;
    const noKids = adultsOnly(filmRating);
    const types = tt.Tickets.filter(
      (x) =>
        (!x.IsAvailableForLoyaltyMembersOnly || ctx.conversation.memberId) &&
        !(noKids && x.IsChildOnlyTicket),
    ).map((x) => ({
      code: x.TicketTypeCode,
      description: x.Description,
      priceCents: x.PriceInCents,
      price: money(x.PriceInCents, ctx.lang),
      area:
        x.AreaCategoryCode === "0000000001"
          ? "premium"
          : x.AreaCategoryCode === "0000000003"
            ? "preferred_view"
            : "regular",
      isChild: x.IsChildOnlyTicket,
    }));
    if (existing)
      await enqueue(ctx.db, ctx.events, {
        conversationId: ctx.conversation.id,
        type: "cancel_order",
        resourceKey: `order:${existing}`,
        idempotencyKey: idem(ctx.conversation.id, `cancel_order:${existing}`),
        payload: { userSessionId: existing },
        requestedBy: "system",
      });
    const speech = t(
      ctx.lang,
      `Starting your booking for ${s.filmTitle}, ${experienceLabel(s.experience, "en")} at ${await cinemaName(ctx, s.cinemaId)} ${fmtDateTime(s.showtime, "en", ctx.nowLocal)}. Tickets are ${joinList(
        types
          .filter((x) => x.area === "regular")
          .slice(0, 3)
          .map((x) => `${x.description.toLowerCase()} ${x.price}`),
      )}. ${noKids ? `It's rated ${filmRating}, so adults only — how many tickets?` : "How many, and any children?"}`,
      `بدأت حجزك لفيلم ${s.filmTitle}، ${experienceLabel(s.experience, "ar")} في ${await cinemaName(ctx, s.cinemaId)} ${fmtDateTime(s.showtime, "ar", ctx.nowLocal)}. التذاكر: ${joinList(
        types
          .filter((x) => x.area === "regular")
          .slice(0, 3)
          .map((x) => `${x.description} ${x.price}`),
        "ar",
      )}. ${noKids ? `الفيلم مصنف ${filmRating} للكبار فقط — كم عدد التذاكر؟` : "كم عدد التذاكر، وهل هناك أطفال؟"}`,
    );
    return ok(
      {
        userSessionId,
        sessionKey: s.key,
        session: {
          cinemaId: s.cinemaId,
          sessionId: s.sessionId,
          showtime: s.showtime,
          experience: s.experience,
          filmTitle: s.filmTitle,
          seatsAvailable: s.seatsAvailable,
        },
        ticketTypes: types,
        expiresInMinutes: ctx.cfg.orderExpiryMinutes,
      },
      speech,
      {
        type: "order",
        title: t(ctx.lang, "New booking", "حجز جديد"),
        items: types,
        meta: { userSessionId, sessionKey: s.key },
      },
      { name: "guided_booking", status: "started" },
    );
  },

  async add_tickets(ctx, input) {
    const key =
      input.idempotencyKey ??
      `add_tickets:${input.userSessionId}:${JSON.stringify(input.tickets)}:${await orderVersion(ctx, input.userSessionId)}`;
    return enqueueOrderAction(
      ctx,
      "add_tickets",
      input.userSessionId,
      {
        tickets: input.tickets,
        preference: (ctx.conversation.metadata as { seatPreference?: string })?.seatPreference,
      },
      key,
      t(
        ctx.lang,
        "Adding those tickets and holding the best seats for you…",
        "أضيف التذاكر وأحجز أفضل المقاعد لك…",
      ),
    );
  },

  async select_seats(ctx, input) {
    const key =
      input.idempotencyKey ??
      `select_seats:${input.userSessionId}:${input.autoAllocate ? `auto:${input.preference ?? ""}` : input.seats.map((s) => `${s.row}${s.number}`).join(",")}:${await orderVersion(ctx, input.userSessionId)}`;
    return enqueueOrderAction(
      ctx,
      "select_seats",
      input.userSessionId,
      { seats: input.seats, autoAllocate: input.autoAllocate, preference: input.preference },
      key,
      t(ctx.lang, "Let me grab those seats…", "دعني أحجز هذه المقاعد…"),
    );
  },

  async add_concessions(ctx, input) {
    const key =
      input.idempotencyKey ??
      `add_concessions:${input.userSessionId}:${JSON.stringify(input.items)}:${await orderVersion(ctx, input.userSessionId)}`;
    return enqueueOrderAction(
      ctx,
      "add_concessions",
      input.userSessionId,
      { items: input.items },
      key,
      t(ctx.lang, "Adding that to your order…", "أضيف ذلك إلى طلبك…"),
      "fnb_preorder",
    );
  },

  async apply_offer(ctx, input) {
    const key =
      input.idempotencyKey ??
      `apply_offer:${input.userSessionId}:${input.offerId ?? input.promoCode ?? ""}:${input.cardBin ?? ""}:${await orderVersion(ctx, input.userSessionId)}`;
    return enqueueOrderAction(
      ctx,
      "apply_offer",
      input.userSessionId,
      {
        offerId: input.offerId,
        promoCode: input.promoCode,
        cardBin: input.cardBin,
        memberId: ctx.conversation.memberId,
      },
      key,
      t(ctx.lang, "Checking that offer against your order…", "أتحقق من العرض على طلبك…"),
      "apply_offer",
    );
  },

  async redeem_points(ctx, input) {
    const memberId = input.memberId ?? ctx.conversation.memberId;
    if (!memberId)
      return err(
        ErrorCodes.LOGIN_REQUIRED,
        t(
          ctx.lang,
          "Please log in to your SHARE account first so I can use your points.",
          "يرجى تسجيل الدخول إلى حساب شير أولاً لاستخدام نقاطك.",
        ),
      );
    const key = input.idempotencyKey ?? `redeem_points:${input.userSessionId}:${input.points ?? "max"}`;
    return enqueueOrderAction(
      ctx,
      "redeem_points",
      input.userSessionId,
      { memberId, points: input.points },
      key,
      t(ctx.lang, "Applying your Share Points…", "أطبق نقاط شير…"),
    );
  },

  async get_order(ctx, input) {
    const r = await ctx.vista.getOrder(input.userSessionId);
    if (!r.Order)
      return err(
        ErrorCodes.NOT_FOUND,
        t(ctx.lang, "There's no active order. Shall we start one?", "لا يوجد طلب نشط. هل نبدأ واحداً؟"),
      );
    const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cinemaName(ctx, r.Order.CinemaId));
    if (s.state === "expired")
      return err(
        ErrorCodes.ORDER_EXPIRED,
        t(
          ctx.lang,
          "That order expired because it wasn't completed in time — seats were released. I can start again quickly.",
          "انتهت صلاحية الطلب لعدم إكماله في الوقت المحدد — تم تحرير المقاعد. يمكنني البدء من جديد بسرعة.",
        ),
      );
    const speech = t(
      ctx.lang,
      `Your order: ${s.tickets.length} ticket${s.tickets.length === 1 ? "" : "s"} for ${s.filmTitle}${s.seats ? `, seats ${s.seats}` : ""}${s.concessions.length ? `, plus ${joinList(s.concessions.map((c) => `${c.quantity}× ${c.description}`))}` : ""}${s.offers.length ? `, with ${joinList(s.offers.map((o: { title: string }) => o.title))} applied` : ""}. Total ${s.total} including VAT. Ready to pay?`,
      `طلبك: ${s.tickets.length} تذكرة لفيلم ${s.filmTitle}${s.seats ? `، المقاعد ${s.seats}` : ""}${
        s.concessions.length
          ? `، بالإضافة إلى ${joinList(
              s.concessions.map((c) => `${c.quantity}× ${c.description}`),
              "ar",
            )}`
          : ""
      }. الإجمالي ${s.total}. هل أنت مستعد للدفع؟`,
    );
    return ok({ order: s }, speech, {
      type: "order",
      title: t(ctx.lang, "Your order", "طلبك"),
      items: [s],
      actions: [
        { label: t(ctx.lang, "Pay now", "ادفع الآن"), value: "pay:start", style: "primary" },
        { label: t(ctx.lang, "Add food & drinks", "أضف مأكولات"), value: "menu:open" },
      ],
    });
  },

  async prepare_payment(ctx, input) {
    const r = await ctx.vista.getOrder(input.userSessionId);
    if (!r.Order)
      return err(
        ErrorCodes.NOT_FOUND,
        t(ctx.lang, "There's no active order to pay for.", "لا يوجد طلب نشط للدفع."),
      );
    const s = orderSummary(r.Order, ctx.lang, ctx.nowLocal, await cinemaName(ctx, r.Order.CinemaId));
    if (s.state === "expired")
      return err(
        ErrorCodes.ORDER_EXPIRED,
        t(ctx.lang, "The order expired — let's start again.", "انتهت صلاحية الطلب — لنبدأ من جديد."),
      );
    if (!s.seatsAllocated)
      return err(
        ErrorCodes.ORDER_INVALID_STATE,
        t(
          ctx.lang,
          "Seats haven't been chosen yet. Shall I pick the best available?",
          "لم يتم اختيار المقاعد بعد. هل أختار الأفضل المتاح؟",
        ),
      );
    let customer = input.customer;
    // logged-in members: pre-fill details and surface stored cards + balances, like the real "Review & pay" step
    let savedCards: { token: string; brand: string; masked: string; expiry: string; default: boolean }[] = [];
    let wallet: { sharePoints: number; sharePointsValueCents: number; voxCreditCents: number } | undefined;
    // unknown / stale customer ids (e.g. a widget reloaded after a reseed) fall back to the guest path
    const c = ctx.conversation.customerId ? await loadCustomer(ctx) : null;
    if (c) {
      customer ??= { name: `${c.firstName} ${c.lastName}`, email: c.email, phone: c.phone };
      savedCards = (c.savedCards ?? []) as typeof savedCards;
      if (ctx.conversation.memberId) {
        const bal = await ctx.vista
          .balances(ctx.conversation.memberId)
          .catch(() => ({ Balances: [] as any[] }));
        const pts = bal.Balances.find((x) => x.BalanceTypeId === "SHARE_POINTS");
        const cr = bal.Balances.find((x) => x.BalanceTypeId === "VOX_REWARDS");
        wallet = {
          sharePoints: pts?.Points ?? 0,
          sharePointsValueCents: pts?.ValueCents ?? 0,
          voxCreditCents: cr?.ValueCents ?? 0,
        };
      }
    }
    if (!customer)
      return err(
        ErrorCodes.VALIDATION,
        t(
          ctx.lang,
          "I need a name, email and mobile number for the tickets. What should I use?",
          "أحتاج الاسم والبريد الإلكتروني ورقم الجوال للتذاكر. ما هي البيانات؟",
        ),
      );
    if (input.method === "VOX_CREDIT" || input.method === "SHARE_POINTS") {
      if (!ctx.conversation.memberId)
        return err(
          ErrorCodes.LOGIN_REQUIRED,
          t(
            ctx.lang,
            "Please log in to pay with VOX credit or Share Points.",
            "يرجى تسجيل الدخول للدفع برصيد فوكس أو نقاط شير.",
          ),
        );
      const bal = await ctx.vista.balances(ctx.conversation.memberId);
      const b = bal.Balances.find(
        (x) => x.BalanceTypeId === (input.method === "VOX_CREDIT" ? "VOX_REWARDS" : "SHARE_POINTS"),
      )!;
      if (b.ValueCents < s.totalCents)
        return err(
          ErrorCodes.INSUFFICIENT_POINTS,
          t(
            ctx.lang,
            `Your ${input.method === "VOX_CREDIT" ? "VOX credit" : "Share Points"} cover ${money(b.ValueCents, ctx.lang)} of the ${s.total} total. I can apply them and take the rest by card — shall I?`,
            `رصيدك يغطي ${money(b.ValueCents, "ar")} من الإجمالي ${s.total}. يمكنني تطبيقه ودفع الباقي بالبطاقة — هل أفعل؟`,
          ),
        );
    }
    const sheetMethods = ["CARD", "SAVED_CARD", "APPLE_PAY", "SAMSUNG_PAY", "GOOGLE_PAY"];
    const usesSheet = sheetMethods.includes(input.method);
    const methodText = {
      CARD: t(ctx.lang, "card", "البطاقة"),
      SAVED_CARD: savedCards.length
        ? t(
            ctx.lang,
            `your saved card ending ${savedCards[0]!.masked.slice(-4)}`,
            `بطاقتك المحفوظة المنتهية بـ ${savedCards[0]!.masked.slice(-4)}`,
          )
        : t(ctx.lang, "card", "البطاقة"),
      VOX_CREDIT: t(ctx.lang, "VOX credit", "رصيد فوكس"),
      SHARE_POINTS: t(ctx.lang, "Share Points", "نقاط شير"),
      APPLE_PAY: "Apple Pay",
      SAMSUNG_PAY: "Samsung Pay",
      GOOGLE_PAY: "Google Pay",
    }[input.method];
    // bank offers for this session — the real "Review & pay" step lists them with a card-verification box.
    // Guests never see them: bank offers require a VOX account.
    const sessionKey = (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
    const isGuest = !c;
    const bankOffers = isGuest
      ? []
      : await ctx.vista
          .offers({
            sessionKey,
            cinemaId: s.cinemaId,
            type: "bank",
            memberId: ctx.conversation.memberId ?? undefined,
          })
          .then((r) =>
            (r.offers ?? [])
              .filter((o: any) => o.rules?.bankName)
              .slice(0, 8)
              .map((o: any) => ({
                offerId: o.id,
                title: o.title,
                benefit: describeBenefit(o.benefit, ctx.lang),
                imageUrl: o.imageUrl,
                bankName: o.rules?.bankName,
                cardDigits: o.rules?.cardDigits ?? { first: 6, last: 4 },
                monthlyLimit: o.rules?.monthlyLimit,
                requiresMember: !!o.rules?.membersOnly,
                eligible: o.eligibility?.eligible,
              })),
          )
          .catch(() => []);
    const summary = {
      userSessionId: input.userSessionId,
      method: input.method,
      amountCents: s.totalCents,
      customer,
      memberId: ctx.conversation.memberId ?? undefined,
      customerId: ctx.conversation.customerId ?? undefined,
      filmTitle: s.filmTitle,
      showtime: s.showtime,
      seats: s.seats,
      cinemaId: s.cinemaId,
    };
    const spoken = t(
      ctx.lang,
      `To confirm: ${s.tickets.length} ticket${s.tickets.length === 1 ? "" : "s"} for ${s.filmTitle}, ${s.showtimeLabel} at ${s.cinemaName}, seats ${s.seats}${s.concessions.length ? `, with ${joinList(s.concessions.map((c) => `${c.quantity}× ${c.description}`))}` : ""}. Total ${s.total}, paying by ${methodText} for ${customer.name}, tickets to ${customer.email}. ${usesSheet ? `I've opened the secure payment sheet${savedCards.length && input.method === "SAVED_CARD" ? ` with your ${savedCards[0]!.brand === "MASTERCARD" ? "Mastercard" : savedCards[0]!.brand === "VISA" ? "Visa" : "card"} ending ${savedCards[0]!.masked.slice(-4)} selected` : ""} — complete it there and I'll confirm.${isGuest ? " Log in or create an account to view eligible offers and earn Share Points." : ""}` : "Shall I complete the payment?"}`,
      `للتأكيد: ${s.tickets.length} تذكرة لفيلم ${s.filmTitle}، ${s.showtimeLabel} في ${s.cinemaName}، المقاعد ${s.seats}. الإجمالي ${s.total}، الدفع عبر ${methodText} باسم ${customer.name}، وتُرسل التذاكر إلى ${customer.email}. ${usesSheet ? `فتحت نافذة الدفع الآمن — أكمل الدفع هناك وسأؤكد.${isGuest ? " سجّل الدخول أو أنشئ حساباً لعرض العروض المؤهلة وكسب نقاط شير." : ""}` : "هل أكمل الدفع؟"}`,
    );
    const conf = await createConfirmation(ctx.db, {
      conversationId: ctx.conversation.id,
      actionType: "pay_order",
      resourceKey: `order:${input.userSessionId}`,
      summary,
      spokenSummary: spoken,
      ttlSeconds: ctx.cfg.confirmationTtlSeconds,
    });
    return ok({ confirmationId: conf.id, summary: { ...summary, order: s } }, spoken, {
      type: "payment",
      title: t(ctx.lang, "Payment", "الدفع"),
      items: [{ ...s, method: input.method, customer }],
      meta: {
        confirmationId: conf.id,
        userSessionId: input.userSessionId,
        method: input.method,
        amountCents: s.totalCents,
        vat: { beforeVatCents: s.totalCents - s.taxCents, vatCents: s.taxCents, rate: 5 },
        savedCards,
        wallet,
        bankOffers,
        customer,
        guest: isGuest,
        requiresSheet: usesSheet,
      },
      actions:
        input.method === "VOX_CREDIT" || input.method === "SHARE_POINTS"
          ? [
              {
                label: t(ctx.lang, "Confirm payment", "تأكيد الدفع"),
                value: `confirm:${conf.id}`,
                style: "primary",
              },
              { label: t(ctx.lang, "Cancel", "إلغاء"), value: "abort" },
            ]
          : [],
    });
  },

  async pay_order(ctx, input) {
    const { consumeConfirmation } = await import("../services/confirmations.js");
    let conf: Awaited<ReturnType<typeof consumeConfirmation>>;
    try {
      conf = await consumeConfirmation(ctx.db, {
        id: input.confirmationId,
        conversationId: ctx.conversation.id,
        actionType: "pay_order",
        resourceKey: `order:${input.userSessionId}`,
      });
    } catch (e) {
      const { findByKey } = await import("../actions/ledger.js");
      const existing = await findByKey(
        ctx.db,
        idem(ctx.conversation.id, input.idempotencyKey ?? `pay:${input.confirmationId}`),
      );
      if (existing)
        return ok(
          { action: toRef(existing), created: false },
          t(
            ctx.lang,
            "Payment is already being processed — one moment.",
            "الدفع قيد المعالجة بالفعل — لحظة.",
          ),
        );
      return err((e as { code?: string }).code ?? ErrorCodes.CONFIRMATION_REQUIRED, (e as Error).message);
    }
    const method = (conf.summary as { method: string }).method;
    if (
      ["CARD", "SAVED_CARD", "APPLE_PAY", "SAMSUNG_PAY", "GOOGLE_PAY"].includes(method) &&
      !input.paymentToken
    )
      return err(
        ErrorCodes.VALIDATION,
        t(
          ctx.lang,
          "I'm waiting for the payment sheet to be completed in the widget.",
          "أنتظر إكمال نافذة الدفع في الواجهة.",
        ),
      );
    const key = input.idempotencyKey ?? `pay:${input.confirmationId}`;
    return enqueueOrderAction(
      ctx,
      "pay_order",
      input.userSessionId,
      { ...conf.summary, paymentToken: input.paymentToken, confirmationId: conf.id },
      key,
      t(ctx.lang, "Processing your payment…", "أعالج الدفع…"),
      "payment",
    );
  },

  async cancel_order(ctx, input) {
    const r = await enqueueOrderAction(
      ctx,
      "cancel_order",
      input.userSessionId,
      {},
      input.idempotencyKey ?? `cancel_order:${input.userSessionId}`,
      t(ctx.lang, "No problem — I've released those seats.", "لا مشكلة — حررت المقاعد."),
      "guided_booking",
    );
    await updateConversation(ctx.db, ctx.conversation.id, {
      metadata: { ...(ctx.conversation.metadata ?? {}), activeOrder: null },
    });
    return { ...r, journey: { name: "guided_booking", status: "abandoned" } };
  },
};

async function orderCinema(ctx: ToolCtx): Promise<string | undefined> {
  const key = (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
  return key?.split("-")[0];
}
async function orderExperience(ctx: ToolCtx): Promise<string | undefined> {
  const key = (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
  if (!key) return undefined;
  return (await ctx.catalog.sessionByKey(key))?.experience;
}

export const offerTools: Pick<ToolHandlers, "list_offers" | "check_offer_eligibility"> = {
  async list_offers(ctx, input) {
    const memberId = input.memberId ?? ctx.conversation.memberId ?? undefined;
    const sessionKey =
      input.sessionKey ?? (ctx.conversation.metadata as { activeSessionKey?: string })?.activeSessionKey;
    // ticket count from the active order so "buy 1 get 1" is judged against what is actually in the basket
    let ticketCount: number | undefined;
    const usid = activeOrder(ctx);
    if (usid) {
      const o = await ctx.vista.getOrder(usid).catch(() => null);
      const tk = o?.Order?.Sessions?.[0]?.Tickets as unknown[] | undefined;
      if (tk?.length) ticketCount = tk.length;
    }
    const cardBin = input.cardBin?.replace(/\D/g, "").slice(0, 6) || undefined;
    const { offers } = await ctx.vista.offers({
      cinemaId: input.cinemaId,
      sessionKey,
      experience: input.experience,
      type: input.type === "any" ? undefined : input.type,
      memberId,
      bank: input.bank,
      cardBin,
      ticketCount,
    });
    // saved cards → "you have a card that qualifies"
    const savedCards = ctx.conversation.customerId
      ? (((await ctx.vista.customer(ctx.conversation.customerId).catch(() => null))?.savedCards ?? []) as {
          brand: string;
          first6: string;
          last4: string;
        }[])
      : [];
    const brandName = (b: string) =>
      b === "MASTERCARD" ? "Mastercard" : b === "VISA" ? "Visa" : b === "AMEX" ? "Amex" : "card";
    const cards = offers.slice(0, input.limit).map((o) => {
      const match = savedCards.find((c) =>
        (o.rules?.bankBins ?? []).some((b: string) => c.first6.startsWith(b)),
      );
      return {
        offerId: o.id,
        title: ctx.lang === "ar" && o.titleAlt ? o.titleAlt : o.title,
        titleEn: o.title,
        description: ctx.lang === "ar" && o.shortDescriptionAlt ? o.shortDescriptionAlt : o.shortDescription,
        benefit: describeBenefit(o.benefit, ctx.lang),
        benefitType: o.benefit?.type,
        type: o.type,
        imageUrl: o.imageUrl,
        terms: o.terms,
        howToRedeem: o.howToRedeem,
        eligible: o.eligibility?.eligible,
        requires: o.eligibility?.requires ?? [],
        reasons: o.eligibility?.reasons ?? [],
        remainingBudget: o.remainingBudget,
        validDays: o.rules?.days,
        experiences: o.rules?.experiences,
        bankName: o.rules?.bankName,
        monthlyLimit: o.rules?.monthlyLimit,
        membersOnly: !!o.rules?.membersOnly,
        savedCard: match
          ? {
              brand: match.brand,
              last4: match.last4,
              label: `${brandName(match.brand)} ending ${match.last4}`,
            }
          : undefined,
      };
    });
    const isGuest = !ctx.conversation.customerId;
    if (!cards.length)
      return ok(
        { offers: [] },
        input.bank || cardBin
          ? t(
              ctx.lang,
              `I don't have a VOX offer for ${input.bank ?? "that card"} right now${sessionKey ? " on this showtime" : ""}. Want me to list the bank offers that are available?`,
              `لا يوجد عرض من فوكس لـ ${input.bank ?? "هذه البطاقة"} حالياً. هل أعرض عروض البنوك المتاحة؟`,
            )
          : t(ctx.lang, "There are no offers available right now.", "لا توجد عروض متاحة حالياً."),
        undefined,
        { name: "offers_info", status: "completed" },
      );
    const usable = cards.filter((c) => c.eligible || c.requires.length);
    const withCard = cards.filter((c) => c.savedCard);
    const bankNote = cards.some((c) => c.type === "bank")
      ? isGuest
        ? t(
            ctx.lang,
            " Bank offers need a VOX account — Log in or create an account to view eligible offers and earn Share Points.",
            " تتطلب عروض البنوك حساب فوكس — سجّل الدخول أو أنشئ حساباً لعرض العروض المؤهلة وكسب نقاط شير.",
          )
        : t(
            ctx.lang,
            " Buy-one-get-one offers need exactly 2 tickets and must be paid with that bank's card; bank-offer tickets are non-refundable.",
            " عروض اشترِ واحدة واحصل على الثانية تتطلب تذكرتين بالضبط والدفع ببطاقة البنك نفسه؛ تذاكر عروض البنوك غير قابلة للاسترداد.",
          )
      : "";
    const speech = t(
      ctx.lang,
      `${input.bank || cardBin ? `For ${input.bank ?? "that card"} there ${cards.length === 1 ? "is 1 offer" : `are ${cards.length} offers`}` : `There are ${cards.length} offers${sessionKey ? " for this showtime" : ""}`}: ${joinList(
        usable.slice(0, 3).map((c) => `${c.titleEn} (${c.benefit})`),
      )}${cards.length > 3 ? " and more on screen" : ""}.${
        withCard.length
          ? ` You have a saved ${withCard[0]!.savedCard!.label} that qualifies for ${withCard[0]!.titleEn} — would you like to use it?`
          : ""
      }${bankNote} Want me to apply one?`,
      `يوجد ${cards.length} عروض: ${joinList(
        usable.slice(0, 3).map((c) => `${c.title} (${c.benefit})`),
        "ar",
      )}.${withCard.length ? ` لديك بطاقة ${withCard[0]!.savedCard!.label} محفوظة مؤهلة لعرض ${withCard[0]!.title} — هل تريد استخدامها؟` : ""}${bankNote} هل أطبق أحدها؟`,
    );
    return ok(
      { offers: cards, ticketCount, guest: isGuest },
      speech,
      {
        type: "offer",
        title: input.bank
          ? t(ctx.lang, `${input.bank} offers`, `عروض ${input.bank}`)
          : t(ctx.lang, "Offers", "العروض"),
        items: cards,
        meta: { guest: isGuest, ticketCount },
        actions: isGuest
          ? []
          : usable.slice(0, 3).map((c) => ({ label: c.titleEn, value: `offer:${c.offerId}` })),
      },
      { name: "offers_info", status: "completed" },
    );
  },
  async check_offer_eligibility(ctx, input) {
    const r = await ctx.vista.offerEligibility(input.offerId, {
      sessionKey: input.sessionKey,
      memberId: input.memberId ?? ctx.conversation.memberId,
      cardBin: input.cardBin,
      ticketCount: input.ticketCount,
    });
    const speech = r.eligible
      ? t(
          ctx.lang,
          "Yes, that offer applies. Shall I add it to the order?",
          "نعم، هذا العرض ينطبق. هل أضيفه إلى الطلب؟",
        )
      : r.requires.length
        ? t(
            ctx.lang,
            `It can apply, but I need ${joinList(r.requires.map((x) => (x === "member" ? "you to log in to SHARE" : x === "card" ? "the first six digits of the card you'll pay with" : "the promo code")))}.`,
            `يمكن تطبيقه، لكن أحتاج ${joinList(
              r.requires.map((x) =>
                x === "member"
                  ? "تسجيل الدخول إلى شير"
                  : x === "card"
                    ? "أول ستة أرقام من البطاقة"
                    : "رمز العرض",
              ),
              "ar",
            )}.`,
          )
        : t(ctx.lang, `Unfortunately not: ${r.reasons.join("; ")}.`, `للأسف لا: ${r.reasons.join("؛ ")}.`);
    return ok({ ...r }, speech);
  },
};

export { VistaClientError };
