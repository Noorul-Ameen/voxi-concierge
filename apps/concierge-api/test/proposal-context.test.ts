import { randomUUID } from "node:crypto";
import { schema as S } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
async function fixture() {
  const session = await h.session(`conv_context_${randomUUID()}`);
  const found = await h.tool("search_sessions", session.conversationId, {
    cinemaId: "0002",
    date: "tomorrow",
    limit: 60,
  });
  const show = found.data.sessions.find((s: any) => s.seatsAvailable >= 6 && !s.soldOut);
  expect(show).toBeDefined();
  return { ...session, sessionKey: show.sessionKey as string };
}
async function quote(s: Awaited<ReturnType<typeof fixture>>) {
  const result = await h.widget("command", s.token, {
    type: "proposal.preview",
    input: { intent: "initial", sessionKey: s.sessionKey, tickets: 1 },
  });
  expect(result.ok).toBe(true);
  expect(result.data.proposalRef).toEqual(expect.any(String));
  expect(result.ui.meta.proposalRef).toBe(result.data.proposalRef);
  return result;
}
async function orderRows(conversationId: string) {
  return h.db.select().from(S.orders).where(eq(S.orders.conversationId, conversationId));
}
it("enforces the new native intent capability before creating context or event rows", async () => {
  const conversationId = `conv_marker_${randomUUID()}`;
  const result = await h.api
    .request("/tools/propose_booking", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voxi-key": "test-secret",
        "x-voxi-proposal-context": "explicit",
      },
      body: JSON.stringify({ conversationId, tickets: 1 }),
    })
    .then((r) => r.json() as any);
  expect(result).toMatchObject({ ok: false, data: { needs: "proposal_intent" } });
  expect(
    await h.db.select().from(S.conversations).where(eq(S.conversations.id, conversationId)),
  ).toHaveLength(0);
  expect(
    await h.db
      .select()
      .from(S.conversationEvents)
      .where(eq(S.conversationEvents.conversationId, conversationId)),
  ).toHaveLength(0);
});
it("returns a safe draft context and fences superseded/legacy tokens before touching the existing basket", async () => {
  const s = await fixture();
  const oldLegacy = await h.tool("propose_booking", s.conversationId, {
    sessionKey: s.sessionKey,
    tickets: 1,
  });
  const first = await quote(s);
  const second = await h.tool("propose_booking", s.conversationId, {
    intent: "edit",
    baseProposalRef: first.data.proposalRef,
    tickets: 2,
  });
  expect(second.ok).toBe(true);
  const context = await h.tool("get_session_context", s.conversationId);
  expect(context.data.currentProposal).toMatchObject({
    proposalRef: second.data.proposalRef,
    status: "unheld",
    choices: { tickets: 2 },
  });
  for (const key of ["customerId", "generation", "acceptedActionId", "proposalToken"])
    expect(context.data.currentProposal).not.toHaveProperty(key);
  const before = await orderRows(s.conversationId);
  const add = vi.spyOn(h.ctx.vista, "addTickets");
  for (const proposalToken of [first.data.proposalToken, oldLegacy.data.proposalToken]) {
    const result = await h.tool("quick_book", s.conversationId, { proposalToken });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CONFIRMATION_EXPIRED");
  }
  expect(add).not.toHaveBeenCalled();
  add.mockRestore();
  expect(await orderRows(s.conversationId)).toEqual(before);
  expect(
    await h.db.select().from(S.actions).where(eq(S.actions.conversationId, s.conversationId)),
  ).toHaveLength(0);
});
it("accepts the displayed reference once, keeps the original deadline on retry, and cannot edit an accepted draft", async () => {
  const s = await fixture();
  const preview = await quote(s);
  const accepted = await h.widget("command", s.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(accepted.ok).toBe(true);
  const orderId = accepted.data.userSessionId;
  expect(orderId).toEqual(expect.any(String));
  const original = (await h.ctx.vista.getOrder(orderId)).Order;
  const retried = await h.tool("quick_book", s.conversationId, { proposalToken: preview.data.proposalToken });
  expect(retried.ok).toBe(true);
  expect(retried.data.userSessionId).toBe(orderId);
  expect((await h.ctx.vista.getOrder(orderId)).Order).toEqual(original);
  expect(await orderRows(s.conversationId)).toHaveLength(1);
  expect(
    await h.db
      .select()
      .from(S.actions)
      .where(and(eq(S.actions.conversationId, s.conversationId), eq(S.actions.type, "quick_book"))),
  ).toHaveLength(1);
  const edit = await h.tool("propose_booking", s.conversationId, {
    intent: "edit",
    baseProposalRef: preview.data.proposalRef,
    tickets: 2,
  });
  expect(edit.ok).toBe(false);
  const events = await h.db
    .select()
    .from(S.conversationEvents)
    .where(eq(S.conversationEvents.conversationId, s.conversationId));
  expect(
    events.some(
      (e) => e.type === "ui.render" && (e.payload.ui as any)?.meta?.proposalRef === preview.data.proposalRef,
    ),
  ).toBe(true);
  await h.tool("cancel_order", s.conversationId, { userSessionId: orderId });
});
it.each(["edit", "expiry", "cancel"])("does not replay obsolete accepted UI after %s", async (change) => {
  const s = await fixture();
  const preview = await quote(s);
  const accepted = await h.tool("quick_book", s.conversationId, {
    proposalToken: preview.data.proposalToken,
  });
  expect(accepted.ok).toBe(true);
  const orderId = accepted.data.userSessionId;
  if (change === "edit")
    expect(
      (
        await h.tool("add_concessions", s.conversationId, {
          userSessionId: orderId,
          items: [{ itemId: "2402", quantity: 1 }],
        })
      ).ok,
    ).toBe(true);
  if (change === "expiry") await h.expireOrder(orderId);
  if (change === "cancel")
    expect((await h.tool("cancel_order", s.conversationId, { userSessionId: orderId })).ok).toBe(true);
  const add = vi.spyOn(h.ctx.vista, "addTickets");
  const retry = await h.tool("quick_book", s.conversationId, { proposalToken: preview.data.proposalToken });
  expect(retry.ok).toBe(false);
  expect(retry.ui).toBeUndefined();
  expect(add).not.toHaveBeenCalled();
  add.mockRestore();
  expect(await orderRows(s.conversationId)).toHaveLength(1);
  if (change !== "cancel") await h.tool("cancel_order", s.conversationId, { userSessionId: orderId });
});
it("carries the exact draft across a trusted link and rejects it after logout", async () => {
  const s = await fixture();
  const preview = await quote(s);
  const target = `conv_relinked_${randomUUID()}`;
  const linked = await h.widget("link", s.token, { elevenLabsConversationId: target });
  expect(linked.token).toEqual(expect.any(String));
  const next = await h.tool("propose_booking", target, {
    intent: "edit",
    baseProposalRef: preview.data.proposalRef,
    tickets: 2,
  });
  expect(next.ok).toBe(true);
  const out = await h.widget("logout", linked.token, {});
  expect(out.ok).toBe(true);
  expect(
    (await h.tool("propose_booking", target, { intent: "edit", baseProposalRef: next.data.proposalRef })).ok,
  ).toBe(false);
  expect((await h.tool("quick_book", target, { proposalToken: next.data.proposalToken })).ok).toBe(false);
  expect(await orderRows(target)).toHaveLength(0);
});
it("rejects a superseded reference without invalidating an existing payment review or editing its basket", async () => {
  const s = await fixture();
  const held = await h.widget("command", s.token, {
    type: "booking.select",
    sessionKey: s.sessionKey,
    tickets: 1,
  });
  expect(held.ok).toBe(true);
  const orderId = held.data.userSessionId;
  const review = await h.tool("prepare_payment", s.conversationId, {
    userSessionId: orderId,
    method: "CARD",
    offerDeclined: true,
  });
  expect(review.ok).toBe(true);
  const first = await quote(s);
  expect(
    (
      await h.tool("propose_booking", s.conversationId, {
        intent: "edit",
        baseProposalRef: first.data.proposalRef,
        tickets: 2,
      })
    ).ok,
  ).toBe(true);
  const read = async () => ({
    order: (await h.ctx.vista.getOrder(orderId)).Order,
    confirmations: await h.db
      .select()
      .from(S.pendingConfirmations)
      .where(eq(S.pendingConfirmations.conversationId, s.conversationId)),
    actions: await h.db.select().from(S.actions).where(eq(S.actions.conversationId, s.conversationId)),
  });
  const before = await read();
  expect((await h.tool("quick_book", s.conversationId, { proposalToken: first.data.proposalToken })).ok).toBe(
    false,
  );
  expect(await read()).toEqual(before);
  await h.tool("cancel_order", s.conversationId, { userSessionId: orderId });
});
it("replays one accepted action after trusted relink without a second hold", async () => {
  const s = await fixture();
  const preview = await quote(s);
  const accepted = await h.tool("quick_book", s.conversationId, {
    proposalToken: preview.data.proposalToken,
  });
  expect(accepted.ok).toBe(true);
  const orderId = accepted.data.userSessionId;
  const before = (await h.ctx.vista.getOrder(orderId)).Order;
  const target = `conv_accepted_link_${randomUUID()}`;
  expect((await h.widget("link", s.token, { elevenLabsConversationId: target })).token).toEqual(
    expect.any(String),
  );
  const replay = await h.tool("quick_book", target, { proposalToken: preview.data.proposalToken });
  expect(replay.ok).toBe(true);
  expect(replay.data.userSessionId).toBe(orderId);
  expect((await h.ctx.vista.getOrder(orderId)).Order).toEqual(before);
  await h.tool("cancel_order", target, { userSessionId: orderId });
});
it.each(["native", "widget"])(
  "withholds obsolete proposal UI and proof from the %s response after a newer draft commits",
  async (surface) => {
    const s = await fixture();
    let notifySaved!: () => void;
    let resume!: () => void;
    const saved = new Promise<void>((resolve) => {
      notifySaved = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const transaction = h.db.transaction.bind(h.db);
    let pauseNextDraft = true;
    const spy = vi.spyOn(h.db, "transaction").mockImplementation(async (...args) => {
      const result = await transaction(...args);
      if (pauseNextDraft && result && typeof result === "object" && "ref" in result && "choices" in result) {
        pauseNextDraft = false;
        notifySaved();
        await paused;
      }
      return result;
    });
    const input = { intent: "initial", sessionKey: s.sessionKey, tickets: 1 };
    const pending =
      surface === "native"
        ? h.tool("propose_booking", s.conversationId, input)
        : h.widget("command", s.token, { type: "proposal.preview", input });
    try {
      await saved;
      const newer = await h.tool("propose_booking", s.conversationId, { ...input, tickets: 2 });
      expect(newer.ok).toBe(true);
      resume();
      const obsolete = await pending;
      expect(obsolete.ok).toBe(false);
      expect(obsolete.data).toEqual({ needs: "proposal_refresh" });
      expect(obsolete.ui).toBeUndefined();
      const events = await h.db
        .select()
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, s.conversationId));
      expect(events.some((event) => event.type === "audit.stale_ui")).toBe(true);
    } finally {
      resume();
      spy.mockRestore();
      await pending;
    }
  },
);
