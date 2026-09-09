import { describe, expect, it } from "vitest";
import {
  GetRecommendationsInput,
  LoginCustomerInput,
  OrderFnbInput,
  QuickBookInput,
  RecoverOrderInput,
} from "../src/tools.js";

describe("booking request contracts", () => {
  it("keeps an unknown ticket count unknown", () => {
    expect(QuickBookInput.parse({ sessionKey: "0002-123" }).tickets).toBeUndefined();
    expect(QuickBookInput.parse({ tickets: 2 }).tickets).toBe(2);
  });
  it("only permits missing food items for an explicit repeat-usual request", () => {
    expect(OrderFnbInput.safeParse({ repeatUsual: true }).success).toBe(true);
    expect(OrderFnbInput.safeParse({}).success).toBe(false);
    expect(OrderFnbInput.safeParse({ repeatUsual: false }).success).toBe(false);
    expect(OrderFnbInput.safeParse({ items: [{ itemId: "popcorn", quantity: 2 }] }).success).toBe(true);
  });
  it("retains explicit recommendation constraints and never defaults recovery consent", () => {
    const request = {
      language: "English",
      cinemaName: "Mirdif",
      timeFrom: "16:00",
      timeTo: "18:00",
      withChildren: false,
    };
    expect(GetRecommendationsInput.parse(request)).toMatchObject(request);
    expect(RecoverOrderInput.parse({}).confirmed).toBeUndefined();
    expect(LoginCustomerInput.parse({ email: "guest@example.com", password: "private" })).toEqual({});
  });
});
