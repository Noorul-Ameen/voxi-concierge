import type { Offer } from "@voxi/domain";
import { expect, it } from "vitest";
import { previewOffer } from "../src/services/offer-preview.js";

const order = () => ({
  State: "seats_selected",
  TotalValueCents: 12500,
  BookingFeeValueCents: 500,
  LoyaltyPointsPayableValueInCents: 0,
  Sessions: [
    {
      Tickets: [
        { Id: "1", TicketTypeCode: "ADULT", PriceCents: 6000, DiscountPriceCents: 0, FinalPriceCents: 6000 },
        { Id: "2", TicketTypeCode: "ADULT", PriceCents: 4000, DiscountPriceCents: 0, FinalPriceCents: 4000 },
      ],
    },
  ],
  Concessions: [{ Id: "food", ItemId: "POP", UnitPriceCents: 1000, Quantity: 2, FinalPriceCents: 2000 }],
  AppliedOffers: [],
});
const offer = (benefit: Offer["benefit"]) => ({ id: "preview", type: "bank", rules: {}, benefit });
it("prices ticket percent and BOGO savings without discounting food or fees", () => {
  const basket = order();
  const before = structuredClone(basket);
  expect(
    previewOffer(offer({ type: "percent_off", percent: 20, appliesTo: "tickets" }), basket),
  ).toMatchObject({
    currentTotalCents: 12500,
    discountCents: 2000,
    totalAfterOfferCents: 10500,
    bookingFeeCents: 500,
    redeemedCents: 0,
    applied: false,
  });
  expect(previewOffer(offer({ type: "bogo", buy: 1, get: 1 }), basket)).toMatchObject({
    discountCents: 4000,
    totalAfterOfferCents: 8500,
  });
  expect(basket).toEqual(before);
});
it("respects food scope, caps, eligibility and incompatible existing offers", () => {
  expect(
    previewOffer(offer({ type: "percent_off", percent: 50, appliesTo: "concessions" }), order()),
  ).toMatchObject({ discountCents: 1000, totalAfterOfferCents: 11500 });
  expect(
    previewOffer(
      {
        ...offer({ type: "percent_off", percent: 20, appliesTo: "tickets" }),
        rules: { maxTicketsPerRedemption: 1 },
      },
      order(),
    ),
  ).toMatchObject({ discountCents: 1200 });
  expect(
    previewOffer(offer({ type: "bogo", buy: 1, get: 1 }), {
      ...order(),
      AppliedOffers: [{ offerId: "existing", type: "promo" }],
    }),
  ).toMatchObject({ previewUnavailableReason: expect.stringContaining("cannot be combined") });
  expect(
    previewOffer(offer({ type: "bogo", buy: 1, get: 1 }), order(), {
      eligible: false,
      reasons: ["Wrong day"],
      requires: [],
    }).discountCents,
  ).toBeUndefined();
  expect(
    previewOffer(offer({ type: "bogo", buy: 1, get: 1 }), { ...order(), State: "expired" }).discountCents,
  ).toBeUndefined();
});
it("rejects bank-offer previews with reserved SHARE or VOX credit instead of quoting an unusable saving", () => {
  expect(
    previewOffer(offer({ type: "bogo", buy: 1, get: 1 }), {
      ...order(),
      TotalValueCents: 11500,
      LoyaltyPointsPayableValueInCents: 1000,
    }),
  ).toMatchObject({ previewUnavailableReason: expect.stringContaining("cannot be combined") });
});
