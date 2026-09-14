import { randomUUID } from "node:crypto";
import { schema as S, flattenLayout, nowLocalDate } from "@voxi/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
const ids: string[] = [];
const conversations: string[] = [];
beforeAll(async () => {
  assertLocalTestDatabase();
  h = await startHarness();
});
afterAll(async () => {
  if (conversations.length) {
    await h.db.delete(S.actions).where(inArray(S.actions.conversationId, conversations));
    await h.db
      .delete(S.pendingConfirmations)
      .where(inArray(S.pendingConfirmations.conversationId, conversations));
    await h.db
      .delete(S.conversationEvents)
      .where(inArray(S.conversationEvents.conversationId, conversations));
    await h.db.delete(S.conversations).where(inArray(S.conversations.id, conversations));
  }
  if (ids.length) await h.db.delete(S.bookings).where(inArray(S.bookings.vistaBookingId, ids));
  await h.stop();
});

it("delivers a scoped refund-choice UI and only prepares the chosen exchange without business actions", async () => {
  const conversationId = `conv_swap_choice_${randomUUID()}`;
  conversations.push(conversationId);
  const login = await h.login(conversationId, "RAHUL");
  expect(login.ok).toBe(true);
  const [source] = await h.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "JYRAHL1"));
  expect(source).toBeDefined();
  const id = `SWC${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  ids.push(id);
  // New local-only overpaid fixture, never alter the original booking or account.
  const total = source!.totalValueCents + 50000;
  await h.db.insert(S.bookings).values({
    ...source!,
    vistaBookingId: id,
    vistaBookingNumber: Math.floor(Math.random() * 1_000_000_000),
    tickets: source!.tickets.map((t, i) => ({
      ...t,
      FinalPriceCents: t.FinalPriceCents + (i === 0 ? 50000 : 0),
    })),
    totalValueCents: total,
    payments: [{ ...source!.payments[0]!, PaymentValueCents: total }],
    source: "test",
    qrPayload: "",
  });
  const alternatives = (await h.catalog.sessions(source!.cinemaId)).filter(
    (s) =>
      s.hoCode === source!.hoCode &&
      s.sessionId !== source!.sessionId &&
      s.experience === source!.experience &&
      s.allowTicketSales &&
      !s.soldOut &&
      s.showtime > source!.showtime.toISOString().slice(0, 19),
  );
  expect(alternatives.length).toBeGreaterThan(0);
  const targetSessionKey = alternatives[0]!.key;
  const before = await h.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, id));
  const balancesBefore = await h.ctx.vista.balances(login.customer.memberId);
  const options = await h.tool("prepare_swap", conversationId, { bookingId: id, targetSessionKey });
  expect(options.ok).toBe(true);
  expect(options.data.needs).toBe("swap_refund_method");
  expect(options.data.confirmationId).toBeUndefined();
  expect(
    await h.db
      .select()
      .from(S.pendingConfirmations)
      .where(eq(S.pendingConfirmations.conversationId, conversationId)),
  ).toHaveLength(0);
  const events = await h.db
    .select()
    .from(S.conversationEvents)
    .where(
      and(
        eq(S.conversationEvents.conversationId, conversationId),
        eq(S.conversationEvents.type, "ui.render"),
      ),
    );
  const ui = (events.at(-1)!.payload as any).ui;
  expect(ui.type).toBe("refund_options");
  expect(ui.actions).toEqual([]);
  const command = {
    type: "swap.refund.choose",
    bookingId: id,
    targetSessionKey,
    keepSeatsIfPossible: true,
    refundMethod: "VOX_CREDIT",
    refundChoiceProof: ui.meta.refundChoiceProof,
  };
  const invalid = await h.widget("command", login.token, {
    ...command,
    targetSessionKey: "unrelated-target",
  });
  expect(invalid.ok).toBe(false);
  const result = await h.widget("command", login.token, command);
  expect(result.ok).toBe(true);
  expect(result.data.summary.refundMethod).toBe("VOX_CREDIT");
  expect(result.data.summary.refundMethodSelected).toBe(true);
  expect(result.ui.meta.confirmationId).toBe(result.data.confirmationId);
  expect(result.ui.actions[0].value).toBe(`confirm:${result.data.confirmationId}`);
  expect(
    await h.db.select().from(S.actions).where(eq(S.actions.conversationId, conversationId)),
  ).toHaveLength(0);
  expect(await h.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, id))).toEqual(before);
  expect(await h.ctx.vista.balances(login.customer.memberId)).toEqual(balancesBefore);
  await h.widget("logout", login.token, {});
  const stale = await h.api.request("/widget/command", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` },
    body: JSON.stringify(command),
  });
  expect(stale.status).toBe(401);
  expect(await stale.json()).toEqual({ error: "unauthorized" });
});

it.each(["VOX_CREDIT", "ORIGINAL_PAYMENT"] as const)(
  "executes only the separately confirmed %s refund difference once",
  async (refundMethod) => {
    // Each case starts a fresh catalogue cache before adding its isolated sessions.
    await h.stop();
    h = await startHarness();
    const tag = randomUUID().replaceAll("-", "").slice(0, 10);
    const conversationId = `conv_swap_execute_${tag}`;
    conversations.push(conversationId);
    const login = await h.login(conversationId, "RAHUL");
    expect(login.ok).toBe(true);
    const [source] = await h.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "JYRAHL1"));
    const [base] = await h.db
      .select()
      .from(S.sessions)
      .where(and(eq(S.sessions.cinemaId, source!.cinemaId), eq(S.sessions.sessionId, source!.sessionId)));
    const [template] = await h.db
      .select()
      .from(S.seatLayoutTemplates)
      .where(eq(S.seatLayoutTemplates.id, base!.seatLayoutTemplateId!));
    const memberId = `SWAP_${tag}`;
    const bookingId = `SWX${tag.toUpperCase()}`;
    const sessionIds = [`s${tag}a`, `s${tag}b`];
    const namedBalanceBefore = await h.ctx.vista.balances(login.customer.memberId);
    const showtime = new Date(nowLocalDate().getTime() + 48 * 60 * 60_000);
    const total = source!.totalValueCents + 50000;
    const sessionWhere = and(
      eq(S.sessions.cinemaId, base!.cinemaId),
      inArray(S.sessions.sessionId, sessionIds),
    );
    const seatWhere = and(
      eq(S.sessionSeatState.cinemaId, base!.cinemaId),
      inArray(S.sessionSeatState.sessionId, sessionIds),
    );
    try {
      // Isolated local sessions and member ledger: no named booking, seat or balance is edited.
      await h.db.insert(S.loyaltyAccounts).values({
        memberId,
        customerId: source!.customerId!,
        voxRewardsBalanceCents: 3500,
        sharePointsBalance: 620,
      });
      for (const [index, sessionId] of sessionIds.entries()) {
        const time = new Date(showtime.getTime() + index * 120 * 60_000);
        await h.db.insert(S.sessions).values({
          ...base!,
          sessionId,
          showtime: time,
          sessionBusinessDate: time.toISOString().slice(0, 10),
          allowTicketSales: true,
          soldoutStatus: 0,
        });
        const seats = Object.fromEntries(
          flattenLayout(template!.layout).map((s) => [`${s.row}:${s.number}`, { status: 0 }]),
        ) as typeof S.sessionSeatState.$inferInsert.seats;
        if (index === 0)
          for (const t of source!.tickets) seats[`${t.SeatRowId}:${t.SeatNumber}`] = { status: 1, bookingId };
        await h.db.insert(S.sessionSeatState).values({ cinemaId: base!.cinemaId, sessionId, seats });
      }
      await h.db.insert(S.bookings).values({
        ...source!,
        vistaBookingId: bookingId,
        vistaBookingNumber: Math.floor(Math.random() * 1_000_000_000),
        sessionId: sessionIds[0]!,
        showtime,
        customer: { ...source!.customer, MemberId: memberId },
        totalValueCents: total,
        tickets: source!.tickets.map((t, i) => ({
          ...t,
          FinalPriceCents: t.FinalPriceCents + (i === 0 ? 50000 : 0),
        })),
        payments: [{ ...source!.payments[0]!, PaymentValueCents: total }],
        source: "test",
        qrPayload: "",
      });
      const targetSessionKey = `${base!.cinemaId}-${sessionIds[1]}`;
      const options = await h.tool("prepare_swap", conversationId, { bookingId, targetSessionKey });
      expect(options.ok, JSON.stringify(options)).toBe(true);
      expect(options.data.needs).toBe("swap_refund_method");
      expect(options.data.confirmationId).toBeUndefined();
      const events = await h.db
        .select()
        .from(S.conversationEvents)
        .where(
          and(
            eq(S.conversationEvents.conversationId, conversationId),
            eq(S.conversationEvents.type, "ui.render"),
          ),
        );
      const ui = (events.at(-1)!.payload as any).ui;
      const review = await h.widget("command", login.token, {
        type: "swap.refund.choose",
        bookingId,
        targetSessionKey,
        keepSeatsIfPossible: true,
        refundMethod,
        refundChoiceProof: ui.meta.refundChoiceProof,
      });
      expect(review.ok, JSON.stringify(review)).toBe(true);
      const summary = review.data.summary;
      expect(summary).toMatchObject({ refundMethod, refundMethodSelected: true, chargeCents: 0 });
      expect(summary.refundCents).toBeGreaterThan(0);
      expect(summary.refundCents).toBe(total - summary.newTotalCents);
      expect(
        await h.db.select().from(S.actions).where(eq(S.actions.conversationId, conversationId)),
      ).toHaveLength(0);
      expect(await h.db.select().from(S.refunds).where(eq(S.refunds.bookingId, bookingId))).toHaveLength(0);
      const command = { bookingId, confirmationId: review.data.confirmationId, confirmed: true };
      const denied = await h.tool("swap_booking", conversationId, { ...command, confirmed: false });
      expect(denied.ok).toBe(false);
      expect(
        await h.db.select().from(S.actions).where(eq(S.actions.conversationId, conversationId)),
      ).toHaveLength(0);
      const done = await h.tool("swap_booking", conversationId, command);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      const actions = await h.db.select().from(S.actions).where(eq(S.actions.conversationId, conversationId));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.status, JSON.stringify(actions[0]!.error)).toBe("succeeded");
      const retry = await h.tool("swap_booking", conversationId, command);
      expect(retry.ok, JSON.stringify(retry)).toBe(true);
      expect(
        await h.db.select().from(S.actions).where(eq(S.actions.conversationId, conversationId)),
      ).toHaveLength(1);
      const [refund] = await h.db.select().from(S.refunds).where(eq(S.refunds.bookingId, bookingId));
      expect(await h.db.select().from(S.refunds).where(eq(S.refunds.bookingId, bookingId))).toHaveLength(1);
      expect(refund).toMatchObject({
        amountCents: summary.refundCents,
        method: refundMethod,
        tenderCategory: refundMethod === "VOX_CREDIT" ? "EWALLET" : "CREDIT",
        status: refundMethod === "VOX_CREDIT" ? "completed" : "pending",
      });
      const [replacement] = await h.db
        .select()
        .from(S.bookings)
        .where(eq(S.bookings.swappedFromBookingId, bookingId));
      expect(replacement).toMatchObject({
        totalValueCents: summary.newTotalCents,
        sessionId: sessionIds[1],
        status: "confirmed",
      });
      expect(replacement!.payments.reduce((sum, p) => sum + p.PaymentValueCents, 0)).toBe(
        summary.newTotalCents,
      );
      expect(replacement!.payments.every((p) => p.Reference.endsWith(":carry"))).toBe(true);
      const [account] = await h.db
        .select()
        .from(S.loyaltyAccounts)
        .where(eq(S.loyaltyAccounts.memberId, memberId));
      const ledger = await h.db.select().from(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, memberId));
      expect(account!.sharePointsBalance).toBe(620);
      expect(account!.voxRewardsBalanceCents).toBe(
        3500 + (refundMethod === "VOX_CREDIT" ? summary.refundCents : 0),
      );
      expect(ledger).toHaveLength(refundMethod === "VOX_CREDIT" ? 1 : 0);
      if (refundMethod === "VOX_CREDIT") {
        expect(ledger[0]).toMatchObject({
          delta: summary.refundCents,
          remainingValueCents: summary.refundCents,
          balanceType: "VOX_REWARDS",
        });
        expect(ledger[0]!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(89.99 * 24 * 60 * 60_000);
        expect(ledger[0]!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(90 * 24 * 60 * 60_000);
      } else {
        expect(summary.refundEta).toBe("5–10 days to the same original card");
        expect(replacement!.payments[0]!.CardNumberMasked).toBe(source!.payments[0]!.CardNumberMasked);
      }
      expect(await h.db.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "JYRAHL1"))).toEqual([
        source,
      ]);
      expect(await h.ctx.vista.balances(login.customer.memberId)).toEqual(namedBalanceBefore);
    } finally {
      await h.widget("logout", login.token, {});
      await h.db.delete(S.refunds).where(eq(S.refunds.bookingId, bookingId));
      await h.db.delete(S.loyaltyLedger).where(eq(S.loyaltyLedger.memberId, memberId));
      await h.db.delete(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId));
      await h.db
        .delete(S.bookings)
        .where(or(eq(S.bookings.vistaBookingId, bookingId), eq(S.bookings.swappedFromBookingId, bookingId)));
      await h.db.delete(S.sessionSeatState).where(seatWhere);
      await h.db.delete(S.sessions).where(sessionWhere);
    }
  },
);
