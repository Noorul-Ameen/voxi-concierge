import { randomUUID } from "node:crypto";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});

async function selection() {
  const conversationId = `conv_proposal_guard_${randomUUID()}`;
  const login = await h.login(conversationId, "SARA");
  expect(login.ok).toBe(true);
  const sessions = await h.tool("search_sessions", conversationId, {
    cinemaId: "0002",
    date: "tomorrow",
    limit: 60,
  });
  const show = sessions.data.sessions.find(
    (item: { seatsAvailable: number; soldOut: boolean }) => item.seatsAvailable >= 6 && !item.soldOut,
  );
  expect(show).toBeDefined();
  return { conversationId, token: login.token as string, sessionKey: show.sessionKey as string };
}

async function existingBasket() {
  const state = await selection();
  const held = await h.widget("command", state.token, {
    type: "booking.select",
    sessionKey: state.sessionKey,
    tickets: 1,
  });
  expect(held.ok).toBe(true);
  const orderId = held.data.order.userSessionId as string;
  const food = await h.tool("add_concessions", state.conversationId, {
    userSessionId: orderId,
    items: [{ itemId: "2402", quantity: 1 }],
  });
  expect(food.ok).toBe(true);
  const offerId = `guard_offer_${randomUUID().slice(0, 12)}`;
  await h.db.insert(S.offers).values({
    id: offerId,
    title: "Isolated proposal guard offer",
    shortDescription: "Local regression only",
    type: "general",
    rules: {},
    benefit: { type: "percent_off", percent: 10, appliesTo: "tickets" },
  });
  const offer = await h.tool("apply_offer", state.conversationId, { userSessionId: orderId, offerId });
  expect(offer.ok).toBe(true);
  const payment = await h.tool("prepare_payment", state.conversationId, {
    userSessionId: orderId,
    method: "CARD",
  });
  expect(payment.ok).toBe(true);
  expect(payment.data.confirmationId).toEqual(expect.any(String));
  return { ...state, orderId, confirmationId: payment.data.confirmationId as string };
}

it.each([
  { label: "missing", input: {}, errorCode: "CONFIRMATION_REQUIRED" },
  { label: "blank", input: { proposalToken: "  " }, errorCode: "CONFIRMATION_REQUIRED" },
  {
    label: "fabricated",
    input: { proposalToken: "fabricated.signature" },
    errorCode: "CONFIRMATION_EXPIRED",
  },
])(
  "rejects $label agent proposal proof before touching an existing checkout",
  async ({ input, errorCode }) => {
    const state = await existingBasket();
    const read = async () => ({
      conversation: await h.db
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, state.conversationId)),
      orders: await h.db.select().from(S.orders).where(eq(S.orders.conversationId, state.conversationId)),
      confirmation: await h.db
        .select()
        .from(S.pendingConfirmations)
        .where(eq(S.pendingConfirmations.id, state.confirmationId)),
      actions: await h.db.select().from(S.actions).where(eq(S.actions.conversationId, state.conversationId)),
    });
    const before = await read();
    const providerBefore = (await h.ctx.vista.getOrder(state.orderId)).Order;
    expect(providerBefore.Concessions).toHaveLength(1);
    expect(providerBefore.AppliedOffers).toHaveLength(1);
    expect(before.confirmation[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const addTickets = vi.spyOn(h.ctx.vista, "addTickets");
    const result = await h.tool("quick_book", state.conversationId, { tickets: 2, ...input });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(errorCode);
    expect(addTickets).not.toHaveBeenCalled();
    addTickets.mockRestore();
    const after = await read();
    expect(after.orders).toEqual(before.orders);
    expect(after.confirmation).toEqual(before.confirmation);
    expect(after.actions).toEqual(before.actions);
    expect(after.conversation[0]!.metadata).toEqual(before.conversation[0]!.metadata);
    expect((await h.ctx.vista.getOrder(state.orderId)).Order).toEqual(providerBefore);
  },
);

it("accepts a real proposal through the agent route and replays it without another hold", async () => {
  const state = await selection();
  const proposal = await h.tool("propose_booking", state.conversationId, {
    sessionKey: state.sessionKey,
    tickets: 1,
  });
  expect(proposal.ok).toBe(true);
  expect(proposal.data.proposal.held).toBe(false);
  const accepted = await h.tool("quick_book", state.conversationId, {
    proposalToken: proposal.data.proposalToken,
  });
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  expect(accepted.data.order.totalCents).toBe(proposal.data.proposal.totalCents);
  const before = (await h.ctx.vista.getOrder(accepted.data.userSessionId)).Order;
  const retry = await h.tool("quick_book", state.conversationId, {
    proposalToken: proposal.data.proposalToken,
  });
  expect(retry).toEqual(accepted);
  expect((await h.ctx.vista.getOrder(accepted.data.userSessionId)).Order).toEqual(before);
  const orders = await h.db.select().from(S.orders).where(eq(S.orders.conversationId, state.conversationId));
  expect(orders).toHaveLength(1);
});

it("preserves the authenticated widget's explicit session and quantity selection", async () => {
  const state = await selection();
  const selected = await h.widget("command", state.token, {
    type: "booking.select",
    sessionKey: state.sessionKey,
  });
  expect(selected.ok).toBe(true);
  expect(selected.data.needs).toBe("tickets");
  const held = await h.widget("command", state.token, {
    type: "booking.select",
    sessionKey: state.sessionKey,
    tickets: 2,
  });
  expect(held.ok).toBe(true);
  expect(held.data.order.tickets).toHaveLength(2);
});
