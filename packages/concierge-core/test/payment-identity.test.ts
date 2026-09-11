import { beforeEach, expect, it, vi } from "vitest";
import { createConfirmation } from "../src/services/confirmations.js";
import { orderingTools } from "../src/tools/ordering.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/confirmations.js", () => ({
  createConfirmation: vi.fn(async () => ({ id: "payment-confirmation" })),
}));
vi.mock("../src/services/checkout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/checkout.js")>()),
  pendingBasketActions: vi.fn(async () => []),
}));

const profile = {
  firstName: "Sara",
  lastName: "Al Mansoori",
  email: "sara.almansoori@example.com",
  phone: "+971500000001",
  savedCards: [],
};
const supplied = { name: "Guessed Name", email: "guessed@example.com", phone: "+971599999999" };
const verified = { name: "Sara Al Mansoori", email: profile.email, phone: profile.phone };

function context(signedIn: boolean, customer: typeof profile | null = profile): ToolCtx {
  return {
    conversation: {
      id: "payment-conversation",
      isLoggedIn: signedIn,
      customerId: signedIn ? "verified-customer" : null,
      metadata: {},
    },
    lang: "en",
    nowLocal: "2070-09-10T12:00:00",
    cfg: { confirmationTtlSeconds: 60 },
    catalog: { cinema: vi.fn(async () => ({ name: "Mall of the Emirates" })) },
    vista: {
      customer: vi.fn(async () => customer),
      getOrder: vi.fn(async () => ({
        Order: {
          UserSessionId: "food-order",
          CinemaId: "0002",
          State: "seats_selected",
          TotalValueCents: 1500,
          Sessions: [],
          Concessions: [
            { Id: "food", ItemId: "POP", Description: "Popcorn", Quantity: 1, FinalPriceCents: 1500 },
          ],
        },
      })),
    },
  } as unknown as ToolCtx;
}

beforeEach(() => vi.clearAllMocks());

it("directs guests to page sign-in for balances without asking for personal details or preparing payment", async () => {
  for (const method of ["VOX_CREDIT", "SHARE_POINTS"] as const) {
    const result = await orderingTools.prepare_payment(context(false), {
      userSessionId: "food-order",
      method,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("LOGIN_REQUIRED");
    expect(result.error?.message).toMatch(/sign in on the page/);
  }
  expect(createConfirmation).not.toHaveBeenCalled();
});

it("uses verified member contact for both the payment sheet and persisted confirmation", async () => {
  const result = await orderingTools.prepare_payment(context(true), {
    userSessionId: "food-order",
    method: "CARD",
    customer: supplied,
  });
  expect(result.ok).toBe(true);
  expect(result.ui?.meta?.customer).toEqual(verified);
  expect(result.data?.summary).toMatchObject({ customer: verified, customerId: "verified-customer" });
  expect(vi.mocked(createConfirmation).mock.calls[0]?.[1].summary.customer).toEqual(verified);
  expect(JSON.stringify(result)).not.toContain("guessed@example.com");
});

it("preserves guest-supplied checkout contact", async () => {
  const result = await orderingTools.prepare_payment(context(false), {
    userSessionId: "food-order",
    method: "CARD",
    customer: supplied,
  });
  expect(result.ok).toBe(true);
  expect(result.ui?.meta?.customer).toEqual(supplied);
  expect(vi.mocked(createConfirmation).mock.calls[0]?.[1].summary.customer).toEqual(supplied);
});

it("does not create a payment confirmation from guessed contact when a member profile is unavailable", async () => {
  const result = await orderingTools.prepare_payment(context(true, null), {
    userSessionId: "food-order",
    method: "CARD",
    customer: supplied,
  });
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("LOGIN_REQUIRED");
  expect(createConfirmation).not.toHaveBeenCalled();
});
