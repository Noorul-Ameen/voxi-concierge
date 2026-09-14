import type { Language } from "@voxi/contracts";
import type { AppContext } from "../context.js";
import { money, t } from "./format.js";

type FoodPort = Pick<AppContext["vista"], "concessions" | "customerHistory">;
type MenuItem = Record<string, any>;

/** Read current menu/history only. Rendering and basket changes belong to the caller. */
export async function loadFoodSuggestions(
  vista: FoodPort,
  cinemaId: string,
  customerId: string | null | undefined,
  lang: Language,
) {
  const [menu, history] = await Promise.all([
    vista.concessions(cinemaId),
    customerId
      ? vista.customerHistory(customerId).catch(() => ({ history: [] as Record<string, any>[] }))
      : Promise.resolve({ history: [] as Record<string, any>[] }),
  ]);
  const available: MenuItem[] = menu.ConcessionTabs.flatMap((tab) =>
    tab.Items.map((item) => ({ ...item, Tab: tab.Name })),
  );
  const card = (item: MenuItem, tag: string) => ({
    itemId: item.Id as string,
    name: lang === "ar" && item.DescriptionAlt ? item.DescriptionAlt : item.Description,
    nameEn: item.Description,
    description: item.ExtendedDescription,
    priceCents: item.PriceInCents,
    price: money(item.PriceInCents, lang),
    imageUrl: item.ImageUrl,
    tab: item.Tab,
    isCombo: item.IsCombo,
    isBestSeller: item.IsBestSeller,
    tag,
    modifiers: (item.ModifierGroups ?? []).map((group: any) => ({
      name: group.Name,
      required: group.IsRequired,
      options: group.Modifiers.map((modifier: any) => ({
        id: modifier.Id,
        name: modifier.Description,
        priceCents: modifier.PriceInCents,
      })),
    })),
  });
  const last = history.history.find((entry) => (entry.concessionItemIds ?? []).length);
  const counts = new Map<string, number>();
  for (const id of (last?.concessionItemIds ?? []) as string[])
    if (available.some((item) => item.Id === id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  // History alone never makes a removed item available at this cinema.
  const usual = [...counts].map(([itemId, quantity]) => ({ itemId, quantity }));
  const usualCards = usual.map(({ itemId }) =>
    card(available.find((item) => item.Id === itemId)!, t(lang, "Your usual", "طلبك المعتاد")),
  );
  const popular = available
    .filter((item) => item.IsBestSeller && !counts.has(item.Id))
    .slice(0, 3)
    .map((item) => card(item, t(lang, "Popular", "الأكثر طلباً")));
  return {
    cinemaId,
    checkedAtUtc: new Date().toISOString(),
    usual,
    items: [...usualCards, ...popular],
  };
}

export type FoodSuggestions = Awaited<ReturnType<typeof loadFoodSuggestions>>;

/** Optional enrichment must never turn a successful offer into a failed action. */
export async function offerFoodSuggestions(
  vista: FoodPort,
  cinemaId: string,
  customerId: string | null | undefined,
  lang: Language,
  timeoutMs = 2000,
): Promise<
  | (FoodSuggestions & { status: "ready"; purchaseRequiresConsent: true })
  | { status: "unavailable"; cinemaId: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const suggestions = await Promise.race([
      loadFoodSuggestions(vista, cinemaId, customerId, lang),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Food suggestions timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { status: "ready", ...suggestions, purchaseRequiresConsent: true };
  } catch {
    return { status: "unavailable", cinemaId };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
