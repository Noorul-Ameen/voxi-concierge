import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFoodSuggestions, offerFoodSuggestions } from "../src/services/food-suggestions.js";

function port() {
  const menu = {
    ConcessionTabs: [
      {
        Name: "Food",
        Items: [
          {
            Id: "combo",
            Description: "Popcorn combo",
            DescriptionAlt: "وجبة فشار",
            PriceInCents: 4200,
            IsCombo: true,
            IsBestSeller: true,
            ModifierGroups: [
              {
                Name: "Drink",
                IsRequired: true,
                Modifiers: [{ Id: "cola", Description: "Cola", PriceInCents: 0 }],
              },
            ],
          },
          {
            Id: "water",
            Description: "Water",
            DescriptionAlt: "ماء",
            PriceInCents: 1000,
            IsBestSeller: true,
          },
        ],
      },
    ],
  };
  return {
    concessions: vi.fn(async (_cinemaId: string) => menu),
    customerHistory: vi.fn(async (_customerId: string) => ({
      history: [
        { concessionItemIds: [] },
        { concessionItemIds: ["combo", "removed", "combo"] },
        { concessionItemIds: ["water"] },
      ],
    })),
  };
}

afterEach(() => vi.useRealTimers());

describe("verified food suggestions", () => {
  it("uses the current cinema menu, retains usual quantity/options and excludes removed items", async () => {
    const vista = port();
    const result = await loadFoodSuggestions(vista as any, "0002", "signed-in-guest", "ar");
    expect(vista.concessions).toHaveBeenCalledWith("0002");
    expect(vista.customerHistory).toHaveBeenCalledWith("signed-in-guest");
    expect(result.usual).toEqual([{ itemId: "combo", quantity: 2 }]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      itemId: "combo",
      name: "وجبة فشار",
      isCombo: true,
      priceCents: 4200,
      modifiers: [{ required: true, options: [{ id: "cola" }] }],
    });
    expect(result.items[1]).toMatchObject({ itemId: "water", tag: "الأكثر طلباً" });
    expect(JSON.stringify(result)).not.toContain("signed-in-guest");
    expect(JSON.stringify(result)).not.toContain("removed");
  });

  it("does not read history for a guest or call popular items their usual order", async () => {
    const vista = port();
    const result = await loadFoodSuggestions(vista as any, "0001", null, "en");
    expect(vista.customerHistory).not.toHaveBeenCalled();
    expect(result.usual).toEqual([]);
    expect(result.items.every((item) => item.tag === "Popular")).toBe(true);
  });

  it("uses current popular items without claiming history when history lookup fails", async () => {
    const vista = port();
    vista.customerHistory.mockRejectedValue(new Error("History unavailable"));
    const result = await offerFoodSuggestions(vista as any, "0002", "guest", "en");
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.usual).toEqual([]);
      expect(result.items.every((item) => item.tag === "Popular")).toBe(true);
      expect(result.purchaseRequiresConsent).toBe(true);
    }
  });

  it("does not invent a replacement usual order when its items are no longer sold", async () => {
    const vista = port();
    vista.customerHistory.mockResolvedValue({ history: [{ concessionItemIds: ["removed"] }] });
    const result = await loadFoodSuggestions(vista as any, "0002", "guest", "en");
    expect(result.usual).toEqual([]);
    expect(result.items.every((item) => item.tag === "Popular")).toBe(true);
  });

  it("keeps optional enrichment failure separate from successful offer status", async () => {
    const vista = port();
    vista.concessions.mockRejectedValue(new Error("Menu unavailable"));
    await expect(offerFoodSuggestions(vista as any, "0002", "guest", "en")).resolves.toEqual({
      status: "unavailable",
      cinemaId: "0002",
    });
  });

  it("bounds optional lookup time and does not let a late response change its result", async () => {
    vi.useFakeTimers();
    const vista = port();
    let releaseMenu!: (value: Awaited<ReturnType<typeof vista.concessions>>) => void;
    const menu = await vista.concessions("0002");
    vista.concessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMenu = resolve;
        }),
    );
    const result = offerFoodSuggestions(vista as any, "0002", "guest", "en", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({ status: "unavailable", cinemaId: "0002" });
    releaseMenu(menu);
    await Promise.resolve();
    await expect(result).resolves.toEqual({ status: "unavailable", cinemaId: "0002" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
