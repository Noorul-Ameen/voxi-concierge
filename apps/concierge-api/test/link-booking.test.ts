import { randomUUID } from "node:crypto";
import { schema as S, nowLocalDate } from "@voxi/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness } from "./harness.js";

/** Guest refunds go to the original payment method; linking to a matching signed-in account unlocks VOX Credit. */
let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
const conversation = () => `conv_link_${randomUUID()}`;

/** A card-paid booking made by SARA, then detached from her account so it looks like a guest checkout. */
async function guestBooking(minutesAhead = 90) {
  const c = conversation();
  expect((await h.login(c, "SARA")).ok).toBe(true);
  const show = (await h.catalog.sessions("0005")).find(
    (s) =>
      s.experience === "Standard" &&
      s.allowTicketSales &&
      !s.soldOut &&
      Date.parse(`${s.showtime}Z`) > nowLocalDate().getTime() + minutesAhead * 60_000,
  )!;
  const proposal = await h.tool("propose_booking", c, { sessionKey: show.key, tickets: 1 });
  expect(proposal.ok, JSON.stringify(proposal)).toBe(true);
  const session = await h.session(c);
  const held = await h.widget("command", session.token, {
    type: "proposal.accept",
    proposalToken: proposal.data.proposalToken,
  });
  expect(held.ok, JSON.stringify(held)).toBe(true);
  const orderId = (await h.widget("state", session.token)).conversation.metadata.activeOrder;
  const prepared = await h.tool("prepare_payment", c, {
    userSessionId: orderId,
    method: "CARD",
    offerDeclined: true,
  });
  const paid = await h.widget("command", session.token, {
    type: "payment.token",
    userSessionId: orderId,
    confirmationId: prepared.data.confirmationId,
    token: "tok_visa_424242_4242_test",
  });
  expect(paid.ok, JSON.stringify(paid)).toBe(true);
  const bookingId = paid.action.result.bookingId as string;
  await h.db
    .update(S.bookings)
    .set({ customerId: null, customer: sql`${S.bookings.customer} - 'MemberId'` })
    .where(eq(S.bookings.vistaBookingId, bookingId));
  return bookingId;
}

async function guestRefundOptions(bookingId: string) {
  const guest = conversation();
  const original = (await h.ctx.vista.getBooking(bookingId)).Booking;
  const choices = await h.tool("prepare_cancellation", guest, {
    bookingId,
    verification: { email: original.Customer.Email },
  });
  expect(choices.ok, JSON.stringify(choices)).toBe(true);
  const [event] = (
    await h.db
      .select()
      .from(S.conversationEvents)
      .where(and(eq(S.conversationEvents.conversationId, guest), eq(S.conversationEvents.type, "ui.render")))
  )
    .map((e) => e.payload.ui as any)
    .filter((ui) => ui?.type === "refund_options");
  return { guest, choices, ui: event };
}

it("offers a guest only the original payment method, pre-selected, with a sign-in-and-link route", async () => {
  const bookingId = await guestBooking();
  const { choices, ui } = await guestRefundOptions(bookingId);
  expect(choices.data.refundMethods.map((m: any) => m.method)).toEqual(["ORIGINAL_PAYMENT"]);
  expect(choices.data.eligibility.recommendedMethod).toBe("ORIGINAL_PAYMENT");
  expect(choices.data.refundMethods[0].badges).toEqual(["default"]);
  expect(ui.meta).toMatchObject({
    recommendedMethod: "ORIGINAL_PAYMENT",
    canLinkForCredit: true,
    signedIn: false,
  });
  expect(choices.speech).toMatch(/sign in and link/);
});

it("recommends VOX Credit for a member booking and marks it faster", async () => {
  const bookingId = await guestBooking();
  const c = conversation();
  await h.login(c, "SARA");
  const linked = await h.tool("link_booking", c, { bookingId });
  expect(linked.data.linked).toBe(true);
  const choices = await h.tool("prepare_cancellation", c, { bookingId });
  const credit = choices.data.refundMethods.find((m: any) => m.method === "VOX_CREDIT");
  expect(credit.badges).toEqual(["recommended", "faster"]);
  expect(choices.data.eligibility.recommendedMethod).toBe("VOX_CREDIT");
  expect(choices.data.eligibility.canLinkForCredit).toBe(false);
});

it("asks a signed-out guest to sign in before linking", async () => {
  const bookingId = await guestBooking();
  const r = await h.tool("link_booking", conversation(), { bookingId });
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("LOGIN_REQUIRED");
  expect(r.data.needs).toBe("login");
});

it("links a matching guest booking from the refund card and reopens the refund with VOX Credit", async () => {
  const bookingId = await guestBooking();
  const { guest: c, ui } = await guestRefundOptions(bookingId);
  // The guest signs in inside the same conversation, so the refund review's proof still applies.
  await h.login(c, "SARA");
  const session = await h.session(c);
  const r = await h.widget("command", session.token, {
    type: "booking.link",
    bookingId,
    resume: { kind: "cancel" },
    refundChoiceProof: ui.meta.refundChoiceProof,
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.data.linked).toBe(true);
  expect(r.ui.type).toBe("refund_options");
  expect(r.ui.meta.recommendedMethod).toBe("VOX_CREDIT");
  expect(r.ui.items.map((m: any) => m.method)).toContain("VOX_CREDIT");
  expect(r.speech).toMatch(/now on your account/);
  const after = (await h.ctx.vista.getBooking(bookingId)).Booking;
  expect(after.Customer.MemberId).toEqual(expect.any(String));
  // Idempotent: a second link reports it is already on the account.
  const again = await h.tool("link_booking", c, { bookingId });
  expect(again.data).toMatchObject({ linked: true, alreadyLinked: true });
});

it("refuses to link when the booking's email and phone don't match the account and keeps the original payment", async () => {
  const bookingId = await guestBooking();
  const { guest: c, ui } = await guestRefundOptions(bookingId);
  // The guest signs in inside the same conversation, so the refund review's proof still applies.
  await h.login(c, "JAMES");
  const session = await h.session(c);
  const r = await h.widget("command", session.token, {
    type: "booking.link",
    bookingId,
    resume: { kind: "cancel" },
    refundChoiceProof: ui.meta.refundChoiceProof,
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.data).toMatchObject({ linked: false, reason: "contact_mismatch" });
  expect(r.ui.type).toBe("refund_options");
  expect(r.ui.items.map((m: any) => m.method)).toEqual(["ORIGINAL_PAYMENT"]);
  expect((await h.ctx.vista.getBooking(bookingId)).Booking.Customer.MemberId ?? null).toBeNull();
});

it("applies the 30-minute cut-off to linking", async () => {
  const bookingId = await guestBooking();
  const b = (await h.ctx.vista.getBooking(bookingId)).Booking;
  const soon = new Date(nowLocalDate().getTime() + 20 * 60_000);
  await h.db
    .update(S.bookings)
    .set({ showtime: soon })
    .where(eq(S.bookings.vistaBookingId, b.VistaBookingId));
  const c = conversation();
  await h.login(c, "SARA");
  const r = await h.tool("link_booking", c, { bookingId });
  expect(r.data).toMatchObject({ linked: false, reason: "cutoff" });
  expect((await h.ctx.vista.getBooking(bookingId)).Booking.Customer.MemberId ?? null).toBeNull();
});

it("refuses a booking already on another account", async () => {
  const bookingId = await guestBooking();
  const sara = conversation();
  await h.login(sara, "SARA");
  expect((await h.tool("link_booking", sara, { bookingId })).data.linked).toBe(true);
  const james = conversation();
  await h.login(james, "JAMES");
  const r = await h.tool("link_booking", james, { bookingId });
  expect(r.data).toMatchObject({ linked: false, reason: "linked_elsewhere" });
});
