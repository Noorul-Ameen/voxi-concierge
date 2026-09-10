import { describe, expect, it } from "vitest";
import {
  type BookingSnapshot,
  DEFAULT_POLICY,
  applyBenefit,
  bestMatch,
  centsToPoints,
  evaluateCancellation,
  evaluateOffer,
  evaluateSwap,
  pointsToCents,
  similarity,
} from "../src/index.js";

const base: BookingSnapshot = {
  bookingId: "B1",
  status: "confirmed",
  showtime: "2026-09-10T20:00:00",
  ticketsCollected: false,
  isThirdParty: false,
  hasMember: true,
  tickets: [
    { Id: "1", FinalPriceCents: 4500, DiscountPriceCents: 0, DealDefinitionId: null, Status: "valid" },
    { Id: "2", FinalPriceCents: 4500, DiscountPriceCents: 0, DealDefinitionId: null, Status: "valid" },
  ],
  concessions: [{ Id: "1", FinalPriceCents: 4500 }],
  appliedOffers: [],
  bookingFeeValueCents: 500,
  totalValueCents: 14000,
  refundedValueCents: 0,
};

describe("cancellation policy (uae.voxcinemas.com/refunds)", () => {
  it("quotes SHARE refunds in the same units as payment and balance conversion", () => {
    const quote = evaluateCancellation(base, "2026-09-10T12:00:00");
    const points = quote.refundMethods.find((method) => method.method === "SHARE_POINTS")!.points!;
    expect(points).toBe(1400); // AED 140 at 10 points per AED
    expect(points).toBe(centsToPoints(quote.amounts.totalCents));
    expect(pointsToCents(points)).toBe(quote.amounts.totalCents);
    expect(centsToPoints(1058)).toBe(105.8);
  });
  it("eligible well before showtime; refunds tickets + F&B + fee", () => {
    const e = evaluateCancellation(base, "2026-09-10T12:00:00");
    expect(e.eligible).toBe(true);
    expect(e.amounts.totalCents).toBe(14000);
    expect(e.refundMethods.map((m) => m.method)).toEqual(["VOX_CREDIT", "SHARE_POINTS"]);
  });
  it("blocks inside the 30-minute cut-off", () => {
    const e = evaluateCancellation(base, "2026-09-10T19:45:00");
    expect(e.eligible).toBe(false);
    expect(e.code).toBe("CUTOFF_PASSED");
  });
  it("blocks after the show started, collected tickets, bank offers, already refunded", () => {
    expect(evaluateCancellation(base, "2026-09-10T20:05:00").code).toBe("SHOW_STARTED");
    expect(evaluateCancellation({ ...base, ticketsCollected: true }, "2026-09-10T12:00:00").code).toBe(
      "TICKETS_USED",
    );
    expect(
      evaluateCancellation(
        { ...base, appliedOffers: [{ offerId: "BANK-X", type: "bank" }] },
        "2026-09-10T12:00:00",
      ).code,
    ).toBe("BOOKING_NOT_ELIGIBLE");
    expect(evaluateCancellation({ ...base, status: "refunded" }, "2026-09-10T12:00:00").code).toBe(
      "BOOKING_ALREADY_CANCELLED",
    );
  });
  it("partial cancellation refunds selected tickets + proportional fee, keeps F&B", () => {
    const e = evaluateCancellation(base, "2026-09-10T12:00:00", ["1"]);
    expect(e.amounts.ticketsCents).toBe(4500);
    expect(e.amounts.concessionsCents).toBe(0);
    expect(e.amounts.bookingFeeCents).toBe(250);
  });
  it("guests get original-payment refunds only", () => {
    const e = evaluateCancellation({ ...base, hasMember: false }, "2026-09-10T12:00:00");
    expect(e.refundMethods.map((m) => m.method)).toEqual(["ORIGINAL_PAYMENT"]);
  });
  it("swap computes the price difference and blocks a too-soon target", () => {
    const ok = evaluateSwap(base, "2026-09-10T12:00:00", {
      showtime: "2026-09-11T20:00:00",
      experience: "MAX",
      seatsAvailable: 50,
      ticketPriceCentsByCode: { a: 6000, b: 6000 },
    });
    expect(ok.allowed).toBe(true);
    expect(ok.differenceCents).toBe(3000);
    const soon = evaluateSwap(base, "2026-09-10T12:00:00", {
      showtime: "2026-09-10T12:20:00",
      experience: "MAX",
      seatsAvailable: 50,
      ticketPriceCentsByCode: {},
    });
    expect(soon.allowed).toBe(false);
  });
  it("policy is configurable", () => {
    const e = evaluateCancellation(base, "2026-09-10T19:45:00", undefined, {
      ...DEFAULT_POLICY,
      cutoffMinutes: 10,
    });
    expect(e.eligible).toBe(true);
  });
});

describe("offers engine", () => {
  const bogo = {
    id: "o",
    title: "BOGO",
    type: "bank",
    active: true,
    rules: { days: [0, 1, 2, 3], bankBins: ["409255"], experiences: ["Standard"], minTickets: 2 },
    benefit: { type: "bogo" as const, buy: 1, get: 1 },
  };
  it("explains what is missing and what fails", () => {
    const e = evaluateOffer(bogo, {
      experience: "Standard",
      showtime: "2026-09-07T20:00:00",
      ticketCount: 2,
    });
    expect(e.eligible).toBe(false);
    expect(e.requires).toContain("card");
    const bad = evaluateOffer(bogo, {
      experience: "MAX",
      showtime: "2026-09-05T20:00:00",
      ticketCount: 1,
      cardBin: "999999",
    });
    expect(bad.reasons.length).toBeGreaterThanOrEqual(3);
    const good = evaluateOffer(bogo, {
      experience: "Standard",
      showtime: "2026-09-07T20:00:00",
      ticketCount: 2,
      cardBin: "409255",
    });
    expect(good.eligible).toBe(true);
  });
  it("applies BOGO to the cheapest of each pair and percent/amount/fixed benefits", () => {
    const tickets = [
      { Id: "1", PriceCents: 4500, DiscountPriceCents: 0, FinalPriceCents: 4500, TicketTypeCode: "A" },
      { Id: "2", PriceCents: 3500, DiscountPriceCents: 0, FinalPriceCents: 3500, TicketTypeCode: "C" },
      { Id: "3", PriceCents: 4500, DiscountPriceCents: 0, FinalPriceCents: 4500, TicketTypeCode: "A" },
    ];
    const b = applyBenefit({ type: "bogo", buy: 1, get: 1 }, tickets, []);
    expect(b.discountCents).toBe(4500); // one pair → the cheaper of the two 4500s free (sorted desc), third unpaired
    expect(
      applyBenefit({ type: "percent_off", percent: 50, appliesTo: "tickets" }, tickets, []).discountCents,
    ).toBe(6250);
    expect(
      applyBenefit({ type: "amount_off_cents", amountCents: 1000, appliesTo: "concessions" }, tickets, [
        { Id: "1", ItemId: "160", PriceCents: 4500, Quantity: 1, FinalPriceCents: 4500 },
      ]).discountCents,
    ).toBe(1000);
    expect(
      applyBenefit({ type: "fixed_price_cents", priceCents: 2500, appliesTo: "tickets" }, tickets, [])
        .discountCents,
    ).toBe(2000 + 1000 + 2000);
  });
});

describe("fuzzy matching", () => {
  it("matches spoken cinema names and aliases", () => {
    const items = [
      { id: "0002", names: ["Mall of the Emirates", "MOE"] },
      { id: "0001", names: ["City Centre Deira", "Deira"] },
    ];
    expect(bestMatch("moe", items, (i) => i.names)?.item.id).toBe("0002");
    expect(bestMatch("deira city center", items, (i) => i.names)?.item.id).toBe("0001");
    expect(similarity("spider man", "Spider-Man: Brand New Day")).toBeGreaterThan(0.5);
  });
});

describe("spoken dates", () => {
  it("resolves today/tomorrow/weekday/weekend in cinema-local time", async () => {
    const { resolveSpokenDate } = await import("../src/index.js");
    const now = "2026-09-03T22:30:00"; // Thursday
    expect(resolveSpokenDate("today", now)).toBe("2026-09-03");
    expect(resolveSpokenDate("tomorrow", now)).toBe("2026-09-04");
    expect(resolveSpokenDate("friday", now)).toBe("2026-09-04");
    expect(resolveSpokenDate("thursday", now)).toBe("2026-09-03");
    expect(resolveSpokenDate("next thursday", now)).toBe("2026-09-10");
    expect(resolveSpokenDate("weekend", now)).toBe("2026-09-05");
    expect(resolveSpokenDate("2026-09-20", now)).toBe("2026-09-20");
  });
  it("treats the weekend as Saturday–Sunday and normalises emirates and film languages", async () => {
    const { spokenDateRangeEnd, asEmirate, normaliseFilmLanguage } = await import("../src/index.js");
    expect(spokenDateRangeEnd("this weekend", "2026-09-05")).toBe("2026-09-06");
    expect(spokenDateRangeEnd("tomorrow", "2026-09-04")).toBe("2026-09-04");
    expect(asEmirate("Dubai")).toBe("Dubai");
    expect(asEmirate("in dubai")).toBe("Dubai");
    expect(asEmirate("أبوظبي")).toBe("Abu Dhabi");
    expect(asEmirate("Mall of the Emirates")).toBeUndefined();
    expect(normaliseFilmLanguage("ta")).toBe("Tamil");
    expect(normaliseFilmLanguage("Hindi")).toBe("Hindi");
  });
});
