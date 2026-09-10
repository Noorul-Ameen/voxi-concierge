import { randomUUID } from "node:crypto";
import { schema as S, nowLocalDate } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness } from "./harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
const conversation = () => `conv_journey_${randomUUID()}`;
async function memberOrder() {
  const c = conversation();
  expect((await h.login(c, "SARA")).ok).toBe(true);
  const show = (await h.catalog.sessions("0005")).find(
    (s) =>
      s.experience === "Standard" &&
      s.allowTicketSales &&
      !s.soldOut &&
      Date.parse(`${s.showtime}Z`) > nowLocalDate().getTime() + 90 * 60_000,
  )!;
  expect(show).toBeTruthy();
  const proposal = await h.tool("propose_booking", c, { sessionKey: show.key, tickets: 1 });
  expect(proposal.ok, JSON.stringify(proposal)).toBe(true);
  const session = await h.session(c);
  const held = await h.widget("command", session.token, {
    type: "proposal.accept",
    proposalToken: proposal.data.proposalToken,
  });
  expect(held.ok, JSON.stringify(held)).toBe(true);
  const state = await h.widget("state", session.token);
  const orderId = state.conversation.metadata.activeOrder;
  expect(orderId).toEqual(expect.any(String));
  return { c, session, orderId, show };
}
async function paidBooking() {
  const state = await memberOrder();
  const prepared = await h.tool("prepare_payment", state.c, { userSessionId: state.orderId, method: "CARD" });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  const paid = await h.widget("command", state.session.token, {
    type: "payment.token",
    userSessionId: state.orderId,
    confirmationId: prepared.data.confirmationId,
    token: "tok_visa_424242_4242_test",
  });
  expect(paid.ok, JSON.stringify(paid)).toBe(true);
  return { ...state, bookingId: paid.action.result.bookingId as string };
}

it("requires an accepted account-bound proposal before its exact seats are held", async () => {
  const c = conversation();
  await h.login(c, "SARA");
  const session = await h.session(c);
  const show = (await h.catalog.sessions("0005")).find(
    (s) =>
      s.experience === "Standard" &&
      s.allowTicketSales &&
      !s.soldOut &&
      Date.parse(`${s.showtime}Z`) > nowLocalDate().getTime() + 90 * 60_000,
  )!;
  const preview = await h.widget("command", session.token, {
    type: "proposal.preview",
    input: { sessionKey: show.key, tickets: 1 },
  });
  expect(preview.ok).toBe(true);
  const before = await h.widget("state", session.token);
  expect(before.conversation.metadata.activeOrder).toBeFalsy();
  const other = conversation();
  await h.login(other, "JAMES");
  const second = await h.session(other);
  const stolen = await h.widget("command", second.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(stolen.ok).toBe(false);
  const accepted = await h.widget("command", session.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  const actual = await h.ctx.vista.getOrder(accepted.data.userSessionId);
  expect(actual.Order.TotalValueCents).toBe(preview.data.proposal.totalCents);
  expect(actual.Order.Sessions[0].Tickets.map((t: any) => t.SeatRowId + t.SeatNumber)).toEqual(
    preview.data.proposal.selectedSeats.map((s: any) => s.row + s.number),
  );
  const retry = await h.widget("command", session.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
    idempotencyKey: "different-client-retry",
  });
  expect(retry).toEqual(accepted);
  expect((await h.ctx.vista.getOrder(accepted.data.userSessionId)).Order).toEqual(actual.Order);
  const actions = await h.db
    .select()
    .from(S.actions)
    .where(and(eq(S.actions.conversationId, c), eq(S.actions.type, "quick_book")));
  expect(actions).toHaveLength(1);
  const otherRetry = await h.widget("command", second.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(otherRetry.ok).toBe(false);
  expect(otherRetry.data?.userSessionId).toBeUndefined();
  const linked = await h.widget("link", session.token, { elevenLabsConversationId: conversation() });
  const resumedRetry = await h.widget("command", linked.token, {
    type: "proposal.accept",
    proposalToken: preview.data.proposalToken,
  });
  expect(resumedRetry).toEqual(accepted);
  expect((await h.ctx.vista.getOrder(accepted.data.userSessionId)).Order).toEqual(actual.Order);
});
it("shows the actual reprice and requires separate consent before switching a card offer to wallet payment", async () => {
  const { c, orderId } = await memberOrder();
  const customer = await h.ctx.vista.customer("cust_sara");
  const offerId = `switch_${randomUUID().slice(0, 12)}`;
  await h.db.insert(S.offers).values({
    id: offerId,
    title: "Saved card offer",
    shortDescription: "Isolated test",
    type: "bank",
    rules: { bankBins: [customer.savedCards[0].first6] },
    benefit: { type: "percent_off", percent: 20, appliesTo: "tickets" },
  });
  const applied = await h.tool("apply_offer", c, { userSessionId: orderId, offerId });
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  const discounted = (await h.ctx.vista.getOrder(orderId)).Order;
  const switchPreview = await h.tool("prepare_payment", c, { userSessionId: orderId, method: "VOX_CREDIT" });
  expect(switchPreview.data.needs).toBe("payment_switch_confirmation");
  expect(switchPreview.ui.type).toBe("payment_switch");
  const untouched = (await h.ctx.vista.getOrder(orderId)).Order;
  expect(untouched.TotalValueCents).toBe(discounted.TotalValueCents);
  expect(untouched.AppliedOffers).toHaveLength(1);
  const removed = await h.tool("apply_offer", c, {
    userSessionId: orderId,
    remove: true,
    confirmed: true,
    confirmationId: switchPreview.data.confirmationId,
  });
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  const repriced = (await h.ctx.vista.getOrder(orderId)).Order;
  expect(repriced.TotalValueCents).toBe(switchPreview.data.summary.totalAfterCents);
  expect(repriced.AppliedOffers).toHaveLength(0);
  expect(repriced.ExpiryDateUtc).toBe(discounted.ExpiryDateUtc);
  const pay = await h.tool("prepare_payment", c, { userSessionId: orderId, method: "VOX_CREDIT" });
  expect(pay.ui.type).toBe("payment");
  expect(pay.data.confirmationId).not.toBe(switchPreview.data.confirmationId);
});
it("investigates real booking records, protects another account, and carries only verified evidence into handover", async () => {
  const paid = await paidBooking();
  const found = await h.tool("investigate_payment", paid.c, {
    bookingId: paid.bookingId,
    transactionReference: "reported-not-verified",
    cardLast4: "4242",
  });
  expect(found.ok).toBe(true);
  expect(found.data).toMatchObject({
    status: "found",
    bookingFound: true,
    bankDebitVerified: false,
    transactionReferenceVerified: false,
  });
  expect(found.data.bookings[0].qrPayload).toContain(paid.bookingId);
  const fresh = conversation();
  await h.login(fresh, "SARA");
  const options = await h.tool("investigate_payment", fresh, {});
  expect(options.data).toMatchObject({
    status: "unresolved",
    bookingFound: false,
    needs: "booking_selection",
    nextStep: "choose_booking",
  });
  expect(options.data.candidateBookings.length).toBeGreaterThan(0);
  const rejected = await h.tool("investigate_payment", paid.c, {
    transactionReference: "different-reported-debit",
  });
  expect(rejected.data.status).toBe("unresolved");
  expect(rejected.data.bookingFound).toBe(false);
  expect(rejected.data.bookings).toHaveLength(0);
  const other = conversation();
  await h.login(other, "JAMES");
  const denied = await h.tool("investigate_payment", other, { bookingId: paid.bookingId });
  expect(denied.data.status).toBe("verification_required");
  expect(denied.data.bookings).toBeUndefined();
  const unresolved = await h.tool("investigate_payment", paid.c, {
    bookingId: "ZZZZZZZ",
    transactionReference: "user-reported-reference",
    cardLast4: "1234",
  });
  expect(unresolved.data.bookingFound).toBe(false);
  const transfer = await h.tool("transfer_to_agent", paid.c, {
    reason: "payment_failed",
    summary: "Guest reports a debit",
    investigationId: unresolved.data.investigationId,
  });
  expect(transfer.ok, JSON.stringify(transfer)).toBe(true);
  const [saved] = await h.db
    .select()
    .from(S.transfers)
    .where(eq(S.transfers.id, transfer.data.result.transferId));
  expect(saved?.context.paymentInvestigation).toMatchObject({
    investigationId: unresolved.data.investigationId,
    bankDebitVerified: false,
    reportedTransactionReference: "user-reported-reference",
  });
});
it("requires an allowed refund choice before confirmation and binds the chosen original-card terms", async () => {
  const { c, session, bookingId } = await paidBooking();
  const choices = await h.tool("prepare_cancellation", c, { bookingId });
  expect(choices.data.needs).toBe("refund_method");
  expect(choices.data.confirmationId).toBeUndefined();
  expect(choices.data.refundMethods).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "VOX_CREDIT", validityDays: 90 }),
      expect.objectContaining({ method: "ORIGINAL_PAYMENT", eta: "5–10 days to the same original card" }),
    ]),
  );
  const unsupported = await h.tool("prepare_cancellation", c, { bookingId, refundMethod: "SHARE_POINTS" });
  expect(unsupported.data.needs).toBe("refund_method");
  expect(unsupported.data.requestedMethodAllowed).toBe(false);
  expect(unsupported.data.confirmationId).toBeUndefined();
  const selected = await h.widget("command", session.token, {
    type: "refund.choose",
    bookingId,
    refundMethod: "ORIGINAL_PAYMENT",
  });
  expect(selected.ok).toBe(true);
  expect(selected.data.summary).toMatchObject({ refundMethod: "ORIGINAL_PAYMENT", cardLast4: "4242" });
  expect(selected.speech).toMatch(/same original card.*5–10 days/);
});
it("finds closest same-cinema swap choices and quotes the exact difference without touching the original booking", async () => {
  const { c, bookingId } = await paidBooking();
  const original = (await h.ctx.vista.getBooking(bookingId)).Booking;
  const choices = await h.tool("prepare_swap", c, { bookingId });
  expect(choices.data.needs).toBe("swap_session");
  expect(choices.data.alternatives.length).toBeGreaterThan(0);
  expect(choices.data.alternatives.every((s: any) => s.cinemaId === original.CinemaId)).toBe(true);
  const chosen =
    choices.data.alternatives.find((s: any) => s.experience === original.Experience) ??
    choices.data.alternatives[0];
  const preview = await h.tool("prepare_swap", c, { bookingId, targetSessionKey: chosen.sessionKey });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  expect(preview.data.summary.settlementType).toBe("difference_only");
  expect(preview.data.summary.differenceCents).toBe(
    preview.data.summary.newTotalCents - original.TotalValueCents,
  );
  expect((await h.ctx.vista.getBooking(bookingId)).Booking).toEqual(original);
});

it("preserves guest verification for an exact refund choice without exposing contact details or cancelling early", async () => {
  const { bookingId } = await paidBooking();
  const original = (await h.ctx.vista.getBooking(bookingId)).Booking;
  const guest = conversation();
  const session = await h.session(guest);
  const ticketIds = [original.Tickets[0].Id];
  const choices = await h.tool("prepare_cancellation", guest, {
    bookingId,
    ticketIds,
    verification: { email: original.Customer.Email },
  });
  expect(choices.ok).toBe(true);
  // Tool responses intentionally omit full card data; the authenticated widget receives this event.
  const events = await h.db
    .select()
    .from(S.conversationEvents)
    .where(and(eq(S.conversationEvents.conversationId, guest), eq(S.conversationEvents.type, "ui.render")));
  const ui = events.map((event) => event.payload.ui as any).find((value) => value?.type === "refund_options");
  const proof = ui?.meta.refundChoiceProof;
  expect(proof).toEqual(expect.any(String));
  expect(JSON.stringify(ui)).not.toContain(original.Customer.Email);
  const missing = await h.widget("command", session.token, {
    type: "refund.choose",
    bookingId,
    ticketIds,
    refundMethod: "ORIGINAL_PAYMENT",
  });
  expect(missing.ok).toBe(false);
  const select = {
    type: "refund.choose",
    bookingId,
    ticketIds,
    refundMethod: "ORIGINAL_PAYMENT",
    refundChoiceProof: proof,
  };
  const selected = await h.widget("command", session.token, select);
  expect(selected.ok, JSON.stringify(selected)).toBe(true);
  expect(selected.data.summary).toMatchObject({
    bookingId,
    ticketIds,
    refundMethod: "ORIGINAL_PAYMENT",
    cardLast4: "4242",
  });
  expect(selected.ui.items[0].refund).toMatchObject({
    cardLast4: "4242",
    eta: "5–10 days to the same original card",
  });
  expect((await h.ctx.vista.getBooking(bookingId)).Booking).toEqual(original);
  const outsider = await h.session(conversation());
  expect((await h.widget("command", outsider.token, select)).ok).toBe(false);
  expect((await h.widget("command", session.token, { ...select, ticketIds: [] })).ok).toBe(false);
  expect((await h.widget("command", session.token, { ...select, refundChoiceProof: `${proof}x` })).ok).toBe(
    false,
  );
  const loggedOut = await h.widget("logout", session.token, {});
  expect((await h.widget("command", loggedOut.token, select)).ok).toBe(false);
});
