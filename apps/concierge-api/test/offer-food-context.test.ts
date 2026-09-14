import { randomUUID } from "node:crypto";
import { schema as S, nowLocalDate } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await h.stop();
});

async function offeredOrder() {
  const c = `conv_offer_context_${randomUUID()}`;
  expect((await h.login(c, "SARA")).ok).toBe(true);
  const show = (await h.catalog.sessions("0005")).find(
    (s) =>
      s.experience === "Standard" &&
      s.allowTicketSales &&
      !s.soldOut &&
      Date.parse(`${s.showtime}Z`) > nowLocalDate().getTime() + 90 * 60_000,
  )!;
  expect(show).toBeTruthy();
  const preview = await h.tool("propose_booking", c, { sessionKey: show.key, tickets: 1 });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  const session = await h.session(c);
  const held = await h.widget("command", session.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(held.ok, JSON.stringify(held)).toBe(true);
  const orderId = held.data.userSessionId as string;
  const customer = await h.ctx.vista.customer("cust_sara");
  const offerId = `food_context_${randomUUID().slice(0, 12)}`;
  await h.db.insert(S.offers).values({
    id: offerId,
    title: "Saved card offer",
    shortDescription: "Isolated test",
    type: "bank",
    rules: { bankBins: [customer.savedCards[0].first6] },
    benefit: { type: "percent_off", percent: 20, appliesTo: "tickets" },
  });
  const before = (await h.ctx.vista.getOrder(orderId)).Order;
  return { c, session, orderId, offerId, before };
}

async function apply(state: Awaited<ReturnType<typeof offeredOrder>>) {
  const result = await h.tool("apply_offer", state.c, {
    userSessionId: state.orderId,
    offerId: state.offerId,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.action.status).toBe("succeeded");
  return result;
}

it("returns verified optional food context with offer success without opening a menu or adding food", async () => {
  const state = await offeredOrder();
  const result = await apply(state);
  const suggestion = result.data.result.snackSuggestions;
  expect(suggestion).toMatchObject({
    status: "ready",
    cinemaId: state.before.CinemaId,
    purchaseRequiresConsent: true,
  });
  expect(suggestion.items.length).toBeGreaterThan(0);
  expect(suggestion.usual.every((u: any) => suggestion.items.some((i: any) => i.itemId === u.itemId))).toBe(
    true,
  );
  expect(result.ui.type).toBe("order");
  const after = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(after.AppliedOffers).toHaveLength(1);
  expect(after.TotalValueCents).toBeLessThan(state.before.TotalValueCents);
  expect(after.Concessions ?? []).toEqual(state.before.Concessions ?? []);
  expect(after.ExpiryDateUtc).toBe(state.before.ExpiryDateUtc);
  expect(after.State).not.toBe("paid");
  const context = await h.tool("get_session_context", state.c, {});
  expect(context.data.customer?.id).toBe("cust_sara");
  expect(JSON.stringify(suggestion)).not.toContain("cust_sara");
});

it("keeps the applied discount successful when the optional menu read fails", async () => {
  const state = await offeredOrder();
  vi.spyOn(h.ctx.vista, "concessions").mockRejectedValue(new Error("Test menu failure"));
  const result = await apply(state);
  expect(result.data.result.snackSuggestions).toEqual({
    status: "unavailable",
    cinemaId: state.before.CinemaId,
  });
  expect(result.data.result.offer).toBeTruthy();
  const after = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(after.AppliedOffers).toHaveLength(1);
  expect(after.Concessions ?? []).toEqual(state.before.Concessions ?? []);
  expect(after.ExpiryDateUtc).toBe(state.before.ExpiryDateUtc);
});

it("makes an accepted usual-food request match the fresh suggestion instead of an older cached menu", async () => {
  const state = await offeredOrder();
  const menu = await h.ctx.vista.concessions(state.before.CinemaId);
  const item = menu.ConcessionTabs.flatMap((tab) => tab.Items).find(
    (candidate) => !candidate.IsCombo && !candidate.ModifierGroups?.some((group) => group.IsRequired),
  )!;
  const [conversation] = await h.db.select().from(S.conversations).where(eq(S.conversations.id, state.c));
  await h.db
    .update(S.conversations)
    .set({
      metadata: {
        ...conversation!.metadata,
        usualFnb: [{ itemId: "old-menu-item", quantity: 9 }],
      },
    })
    .where(eq(S.conversations.id, state.c));
  vi.spyOn(h.ctx.vista, "customerHistory").mockResolvedValue({
    history: [{ concessionItemIds: [item.Id] }],
  } as any);
  const applied = await apply(state);
  expect(applied.data.result.snackSuggestions.usual).toEqual([{ itemId: item.Id, quantity: 1 }]);
  const beforeFood = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(beforeFood.Concessions ?? []).toEqual([]);
  const accepted = await h.tool("order_fnb", state.c, { repeatUsual: true });
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  const after = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(after.Concessions).toHaveLength(1);
  expect(after.Concessions![0]).toMatchObject({ ItemId: item.Id, Quantity: 1 });
  expect(after.ExpiryDateUtc).toBe(beforeFood.ExpiryDateUtc);
  expect(after.State).not.toBe("paid");
});

it("keeps existing food unchanged and skips a redundant food suggestion", async () => {
  const state = await offeredOrder();
  const menu = await h.ctx.vista.concessions(state.before.CinemaId);
  const item = menu.ConcessionTabs.flatMap((tab) => tab.Items).find(
    (candidate) => !candidate.IsCombo && !candidate.ModifierGroups?.some((group) => group.IsRequired),
  )!;
  expect(item).toBeTruthy();
  const added = await h.tool("add_concessions", state.c, {
    userSessionId: state.orderId,
    items: [{ itemId: item.Id, quantity: 1 }],
  });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  const beforeOffer = (await h.ctx.vista.getOrder(state.orderId)).Order;
  const menuRead = vi.spyOn(h.ctx.vista, "concessions");
  const historyRead = vi.spyOn(h.ctx.vista, "customerHistory");
  const result = await apply(state);
  expect(result.data.result.snackSuggestions).toBeUndefined();
  expect(menuRead).not.toHaveBeenCalled();
  expect(historyRead).not.toHaveBeenCalled();
  const after = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(after.Concessions).toEqual(beforeOffer.Concessions);
  expect(after.ExpiryDateUtc).toBe(beforeOffer.ExpiryDateUtc);
  expect(after.State).not.toBe("paid");
});

it("does not enrich offer removal or replace the requested payment-switch flow", async () => {
  const state = await offeredOrder();
  await apply(state);
  const preview = await h.tool("prepare_payment", state.c, {
    userSessionId: state.orderId,
    method: "VOX_CREDIT",
  });
  expect(preview.data.needs).toBe("payment_switch_confirmation");
  const menu = vi.spyOn(h.ctx.vista, "concessions");
  const history = vi.spyOn(h.ctx.vista, "customerHistory");
  const removed = await h.tool("apply_offer", state.c, {
    userSessionId: state.orderId,
    remove: true,
    confirmed: true,
    confirmationId: preview.data.confirmationId,
  });
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  expect(removed.data.action.status).toBe("succeeded");
  expect(removed.data.result.snackSuggestions).toBeUndefined();
  expect(menu).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect((await h.ctx.vista.getOrder(state.orderId)).Order.AppliedOffers).toHaveLength(0);
});

it("does not read or suggest food after an offer request fails", async () => {
  const state = await offeredOrder();
  const menu = vi.spyOn(h.ctx.vista, "concessions");
  const history = vi.spyOn(h.ctx.vista, "customerHistory");
  const failed = await h.tool("apply_offer", state.c, {
    userSessionId: state.orderId,
    offerId: "missing-offer",
  });
  expect(failed.ok).toBe(false);
  expect(menu).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  const after = (await h.ctx.vista.getOrder(state.orderId)).Order;
  expect(after.AppliedOffers ?? []).toEqual(state.before.AppliedOffers ?? []);
  expect(after.Concessions ?? []).toEqual(state.before.Concessions ?? []);
});
