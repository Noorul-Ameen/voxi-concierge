/** SHARE loyalty: 10 points = AED 1 (uae.voxcinemas.com shows "105.8 points = 10.58 AED"). */
export const SHARE_POINT_VALUE_CENTS = 10;
export const pointsToCents = (pts: number) => Math.round(pts * SHARE_POINT_VALUE_CENTS);
export const centsToPoints = (cents: number) => Math.round((cents / SHARE_POINT_VALUE_CENTS) * 10) / 10;

/**
 * Offers engine rules — pure functions shared by the Offers Engine mock and the concierge.
 * Vista-agnostic: works on plain offer/order snapshots.
 */
export type OfferRules = {
  cinemaIds?: string[];
  experiences?: string[];
  days?: number[];
  timeFrom?: string;
  timeTo?: string;
  hoCodes?: string[];
  minTickets?: number;
  maxTicketsPerRedemption?: number;
  ticketTypeCodes?: string[];
  membersOnly?: boolean;
  tiers?: string[];
  bankBins?: string[];
  bankName?: string;
  /** How the real site verifies the card for a bank offer: first N digits + last 4 ("Card Number (first 6 and last 4 digits)"). */
  cardDigits?: { first: number; last: number };
  /** Bank offers usually cap redemptions per card per calendar month (e.g. ENBD: 2–3 tickets). */
  monthlyLimit?: number;
  promoCode?: string;
  validFrom?: string;
  validTo?: string;
  channels?: string[];
};
export type OfferBenefit =
  | { type: "percent_off"; percent: number; appliesTo: "tickets" | "concessions" | "order" }
  | { type: "amount_off_cents"; amountCents: number; appliesTo: "tickets" | "concessions" | "order" }
  | { type: "bogo"; buy: number; get: number }
  | { type: "fixed_price_cents"; priceCents: number; appliesTo: "tickets" }
  | { type: "points_multiplier"; multiplier: number }
  | { type: "free_item"; itemId: string };

export type Offer = {
  id: string;
  title: string;
  type: string;
  rules: OfferRules;
  benefit: OfferBenefit;
  remainingBudget?: number | null;
  perMemberLimit?: number | null;
  active: boolean;
};

export type OfferContext = {
  cinemaId?: string;
  experience?: string;
  hoCode?: string;
  showtime?: string; // local ISO
  ticketCount?: number;
  ticketTypeCodes?: string[];
  memberId?: string;
  tier?: string;
  cardBin?: string;
  promoCode?: string;
  channel?: string;
  memberRedemptions?: number;
  /** Committed redemptions of this offer by this member (or card) in the current calendar month. */
  monthlyRedemptions?: number;
  now?: string; // local ISO
};

export type Eligibility = {
  eligible: boolean;
  reasons: string[];
  requires: ("member" | "card" | "promo_code")[];
};

function dayOf(iso: string): number {
  return new Date(`${iso}Z`).getUTCDay();
}
function hm(iso: string): string {
  return iso.slice(11, 16);
}

/** Evaluate rule-by-rule and explain; `requires` lists inputs still needed (so the agent can ask). */
export function evaluateOffer(offer: Offer, ctx: OfferContext): Eligibility {
  const r = offer.rules;
  const reasons: string[] = [];
  const requires: Eligibility["requires"] = [];
  if (!offer.active) reasons.push("Offer is not active");
  if (offer.remainingBudget != null && offer.remainingBudget <= 0) reasons.push("Offer budget exhausted");
  const now = ctx.now ?? new Date().toISOString().slice(0, 19);
  if (r.validFrom && now < r.validFrom) reasons.push(`Offer starts on ${r.validFrom.slice(0, 10)}`);
  if (r.validTo && now > r.validTo) reasons.push(`Offer ended on ${r.validTo.slice(0, 10)}`);
  if (r.cinemaIds?.length && ctx.cinemaId && !r.cinemaIds.includes(ctx.cinemaId))
    reasons.push("Not valid at this cinema");
  if (r.experiences?.length && ctx.experience && !r.experiences.includes(ctx.experience))
    reasons.push(`Valid only for ${r.experiences.join(", ")}`);
  if (r.hoCodes?.length && ctx.hoCode && !r.hoCodes.includes(ctx.hoCode))
    reasons.push("Not valid for this movie");
  if (r.days?.length && ctx.showtime && !r.days.includes(dayOf(ctx.showtime)))
    reasons.push(
      `Valid only on ${r.days.map((d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]).join(", ")}`,
    );
  if (r.timeFrom && ctx.showtime && hm(ctx.showtime) < r.timeFrom) reasons.push(`Valid from ${r.timeFrom}`);
  if (r.timeTo && ctx.showtime && hm(ctx.showtime) > r.timeTo) reasons.push(`Valid until ${r.timeTo}`);
  if (r.minTickets && ctx.ticketCount != null && ctx.ticketCount < r.minTickets)
    reasons.push(`Requires at least ${r.minTickets} tickets`);
  // Buy-one-get-one bank offers apply to exactly one pair: the free ticket needs a paid partner and the
  // monthly cap stops a second pair — so the order must hold exactly buy+get eligible tickets.
  if (offer.benefit.type === "bogo" && ctx.ticketCount != null) {
    const need = offer.benefit.buy + offer.benefit.get;
    if (ctx.ticketCount !== need)
      reasons.push(
        `Buy ${offer.benefit.buy} get ${offer.benefit.get} free needs exactly ${need} tickets in the order (you have ${ctx.ticketCount})`,
      );
  }
  if (
    r.ticketTypeCodes?.length &&
    ctx.ticketTypeCodes?.length &&
    !ctx.ticketTypeCodes.some((c) => r.ticketTypeCodes!.some((x) => c.endsWith(x)))
  )
    reasons.push("Not valid for these ticket types");
  if (r.membersOnly) {
    if (!ctx.memberId) {
      requires.push("member");
      reasons.push("SHARE membership required — please log in");
    } else if (r.tiers?.length && ctx.tier && !r.tiers.includes(ctx.tier))
      reasons.push(`Valid for ${r.tiers.join("/")} members`);
  }
  if (r.bankBins?.length) {
    if (!ctx.cardBin) requires.push("card");
    else if (!r.bankBins.some((b) => ctx.cardBin!.startsWith(b)))
      reasons.push(`Requires an eligible ${r.bankName ?? "bank"} card`);
  }
  if (r.promoCode) {
    if (!ctx.promoCode) requires.push("promo_code");
    else if (ctx.promoCode.toUpperCase() !== r.promoCode.toUpperCase())
      reasons.push("Promo code does not match");
  }
  if (
    offer.perMemberLimit != null &&
    ctx.memberRedemptions != null &&
    ctx.memberRedemptions >= offer.perMemberLimit
  )
    reasons.push("Per-member limit reached");
  if (r.monthlyLimit != null && ctx.monthlyRedemptions != null && ctx.monthlyRedemptions >= r.monthlyLimit)
    reasons.push(`Monthly limit reached for this offer (${r.monthlyLimit} a month)`);
  if (r.channels?.length && ctx.channel && !r.channels.includes(ctx.channel))
    reasons.push("Not available on this channel");
  return { eligible: reasons.length === 0 && requires.length === 0, reasons, requires };
}

/** Does an offer belong to the bank the guest named ("ENBD", "Emirates NBD", "hsbc card")? */
export function offerMatchesBank(offer: Pick<Offer, "title" | "rules">, query: string): boolean {
  const q = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(bank|card|credit|debit|my|the)\b/g, " ")
    .trim();
  if (!q) return false;
  const name = (offer.rules.bankName ?? "").toLowerCase();
  const title = offer.title.toLowerCase();
  const aliases: Record<string, string[]> = {
    "emirates nbd": ["enbd", "emirates nbd", "nbd"],
    hsbc: ["hsbc"],
    adcb: ["adcb", "abu dhabi commercial"],
    cbd: ["cbd", "commercial bank of dubai"],
    mashreq: ["mashreq"],
    citi: ["citi", "citibank"],
    rakbank: ["rak", "rakbank"],
    fab: ["fab", "first abu dhabi"],
    "standard chartered": ["scb", "standard chartered", "stanchart"],
  };
  const words = q.split(/\s+/).filter(Boolean);
  const hits = (s: string) => words.some((w) => w.length >= 3 && s.includes(w)) || s.includes(q);
  if (name && (hits(name) || (aliases[name] ?? []).some((a) => q.includes(a)))) return true;
  return hits(title);
}

/** Card BIN → offer match, shared by list_offers (saved-card hints) and payment validation. */
export function offerAcceptsBin(offer: Pick<Offer, "rules">, bin: string | undefined): boolean {
  if (!offer.rules.bankBins?.length) return true;
  if (!bin) return false;
  return offer.rules.bankBins.some((b) => bin.startsWith(b));
}

export type PricedTicket = {
  Id: string;
  PriceCents: number;
  DiscountPriceCents: number;
  FinalPriceCents: number;
  TicketTypeCode: string;
};
export type PricedConcession = {
  Id: string;
  ItemId: string;
  PriceCents: number;
  Quantity: number;
  FinalPriceCents: number;
};

/** Apply a benefit to an order snapshot; returns new lines + total discount. Pure. */
export function applyBenefit(
  benefit: OfferBenefit,
  tickets: PricedTicket[],
  concessions: PricedConcession[],
  maxTickets?: number,
): {
  tickets: PricedTicket[];
  concessions: PricedConcession[];
  discountCents: number;
  freeItemId?: string;
  pointsMultiplier?: number;
} {
  const t = tickets.map((x) => ({ ...x, DiscountPriceCents: 0, FinalPriceCents: x.PriceCents }));
  const c = concessions.map((x) => ({ ...x, FinalPriceCents: x.PriceCents * x.Quantity }));
  let discount = 0;
  const cap = maxTickets ?? Number.POSITIVE_INFINITY;
  switch (benefit.type) {
    case "percent_off": {
      if (benefit.appliesTo !== "concessions") {
        let n = 0;
        for (const x of t) {
          if (n++ >= cap) break;
          const d = Math.round((x.PriceCents * benefit.percent) / 100);
          x.DiscountPriceCents = d;
          x.FinalPriceCents = x.PriceCents - d;
          discount += d;
        }
      }
      if (benefit.appliesTo !== "tickets")
        for (const x of c) {
          const d = Math.round((x.FinalPriceCents * benefit.percent) / 100);
          x.FinalPriceCents -= d;
          discount += d;
        }
      break;
    }
    case "amount_off_cents": {
      let remaining = benefit.amountCents;
      const pool =
        benefit.appliesTo === "tickets" ? t : benefit.appliesTo === "concessions" ? c : [...t, ...c];
      for (const x of pool) {
        if (remaining <= 0) break;
        const d = Math.min(remaining, x.FinalPriceCents);
        x.FinalPriceCents -= d;
        if ("DiscountPriceCents" in x) (x as PricedTicket).DiscountPriceCents += d;
        remaining -= d;
        discount += d;
      }
      break;
    }
    case "bogo": {
      // sort by price desc; every (buy+get) group gets `get` cheapest free
      const sorted = [...t].sort((a, b) => b.PriceCents - a.PriceCents);
      const group = benefit.buy + benefit.get;
      let freed = 0;
      for (let i = 0; i < sorted.length; i += group) {
        const g = sorted.slice(i, i + group);
        if (g.length < group) break;
        const free = g.slice(benefit.buy);
        for (const f of free) {
          if (freed >= cap) break;
          f.DiscountPriceCents = f.PriceCents;
          f.FinalPriceCents = 0;
          discount += f.PriceCents;
          freed++;
        }
      }
      break;
    }
    case "fixed_price_cents": {
      let n = 0;
      for (const x of t) {
        if (n++ >= cap) break;
        if (x.PriceCents > benefit.priceCents) {
          const d = x.PriceCents - benefit.priceCents;
          x.DiscountPriceCents = d;
          x.FinalPriceCents = benefit.priceCents;
          discount += d;
        }
      }
      break;
    }
    case "free_item":
      return { tickets: t, concessions: c, discountCents: 0, freeItemId: benefit.itemId };
    case "points_multiplier":
      return { tickets: t, concessions: c, discountCents: 0, pointsMultiplier: benefit.multiplier };
  }
  return { tickets: t, concessions: c, discountCents: discount };
}

/** Human-readable benefit text (EN/AR) for cards and speech. */
export function describeBenefit(b: OfferBenefit, lang: "en" | "ar" = "en"): string {
  const ar = lang === "ar";
  switch (b.type) {
    case "percent_off":
      return ar
        ? `خصم ${b.percent}% على ${b.appliesTo === "tickets" ? "التذاكر" : b.appliesTo === "concessions" ? "المأكولات والمشروبات" : "الطلب"}`
        : `${b.percent}% off ${b.appliesTo === "order" ? "your order" : b.appliesTo === "tickets" ? "tickets" : "food & drinks"}`;
    case "amount_off_cents":
      return ar
        ? `خصم ${(b.amountCents / 100).toFixed(0)} درهم`
        : `AED ${(b.amountCents / 100).toFixed(0)} off ${b.appliesTo === "concessions" ? "food & drinks" : b.appliesTo === "tickets" ? "tickets" : "your order"}`;
    case "bogo":
      return ar ? `اشترِ ${b.buy} واحصل على ${b.get} مجاناً` : `Buy ${b.buy} get ${b.get} free`;
    case "fixed_price_cents":
      return ar
        ? `تذاكر بـ ${(b.priceCents / 100).toFixed(0)} درهم`
        : `Tickets for AED ${(b.priceCents / 100).toFixed(0)}`;
    case "points_multiplier":
      return ar ? `نقاط شير مضاعفة ×${b.multiplier}` : `${b.multiplier}x Share Points`;
    case "free_item":
      return ar ? "عنصر مجاني" : "Free item";
  }
}
