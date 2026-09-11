import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness } from "./harness.js";

let harness: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.stop();
});
const request = (token: string, body: unknown) =>
  harness.api.request("/widget/command", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

async function complete(member: boolean) {
  const guest = await harness.session();
  const login = member ? await harness.login(guest.conversationId, "JAMES") : null;
  const token = login?.token ?? guest.token;
  const choices = await harness.tool("search_sessions", guest.conversationId, {
    cinemaId: "0002",
    date: "tomorrow",
    limit: 30,
  });
  expect(choices.ok, JSON.stringify(choices.error)).toBe(true);
  const show = choices.data.sessions.find((item: any) => item.seatsAvailable > 5);
  const held = await request(token, { type: "booking.select", sessionKey: show.sessionKey, tickets: 1 }).then(
    (r) => r.json() as any,
  );
  expect(held.ok).toBe(true);
  const orderId = held.data.order.userSessionId;
  const prepared = await harness.tool("prepare_payment", guest.conversationId, {
    userSessionId: orderId,
    method: "CARD",
  });
  expect(prepared.ok).toBe(true);
  const command = {
    type: "payment.token",
    userSessionId: orderId,
    confirmationId: prepared.data.confirmationId,
    token: "tok_visa_424242_4242_retry",
    ...(!member
      ? { customer: { name: "Receipt Guest", email: "receipt-test@example.com", phone: "0500000001" } }
      : {}),
  };
  const beforeBookings = await harness.db.select({ id: S.bookings.vistaBookingId }).from(S.bookings);
  const response = await request(token, command);
  const paid = (await response.json()) as any;
  expect(response.status).toBe(200);
  expect(paid.action.status).toBe("succeeded");
  return { conversationId: guest.conversationId, token, command, paid, orderId, beforeBookings };
}

it.each([false, true])(
  "replays a completed payment once and isolates its authentication generation (member=%s)",
  async (member) => {
    const state = await complete(member);
    const retry = await request(state.token, state.command);
    const result = (await retry.json()) as any;
    expect(retry.status).toBe(200);
    expect(result.action.actionId).toBe(state.paid.action.actionId);
    expect(result.data.bookingId).toBe(state.paid.data.bookingId);
    expect(result.ui.type).toBe("qr");
    const afterBookings = await harness.db.select({ id: S.bookings.vistaBookingId }).from(S.bookings);
    expect(
      afterBookings.filter((b) => !state.beforeBookings.some((previous) => previous.id === b.id)),
    ).toEqual([{ id: state.paid.data.bookingId }]);
    const order = (
      await harness.db.select().from(S.orders).where(eq(S.orders.userSessionId, state.orderId))
    )[0]!;
    expect(order.state).toBe("paid");
    expect(order.completedBookingId).toBe(state.paid.data.bookingId);
    expect(order.customerId).toBe(member ? "cust_james" : null);
    expect(order.customer?.Email).toBe(member ? "james.whitfield@example.com" : "receipt-test@example.com");
    const other = await harness.session();
    expect((await request(other.token, state.command)).status).toBe(403);
    const receipt = { type: "booking.receipt", bookingId: state.paid.data.bookingId };
    const ownReceipt = await request(state.token, receipt);
    expect(ownReceipt.status).toBe(200);
    expect(
      ((await ownReceipt.json()) as { data: { booking: { verified: boolean } } }).data.booking.verified,
    ).toBe(true);
    expect((await request(other.token, receipt)).status).toBe(403);
    let currentToken = state.token;
    if (member) {
      const switched = await harness.login(state.conversationId, "SARA");
      currentToken = switched.token;
      expect((await request(currentToken, state.command)).status).toBe(403);
      expect((await request(currentToken, receipt)).status).toBe(403);
    }
    const logout = await harness.api
      .request("/widget/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${currentToken}`, "content-type": "application/json" },
        body: "{}",
      })
      .then((r) => r.json() as any);
    expect((await request(logout.token, state.command)).status).toBe(403);
    expect((await request(logout.token, receipt)).status).toBe(403);
  },
);

it("returns only the exact member-owned valid receipt and rejects another account, cancelled and missing-QR records", async () => {
  const state = await complete(true);
  const bookingId = state.paid.data.bookingId;
  const receipt = { type: "booking.receipt", bookingId };
  const response = await request(state.token, receipt);
  const result = (await response.json()) as any;
  expect(response.status).toBe(200);
  expect(result.ui.type).toBe("qr");
  expect(result.ui.meta.qrPayload).toBe(state.paid.ui.meta.qrPayload);
  expect(result.ui.meta.receiptLookup).toBe(true);
  expect(result.data.booking.bookingId).toBe(bookingId);
  const other = await harness.session();
  const login = await harness.login(other.conversationId, "SARA");
  expect((await request(login.token, receipt)).status).toBe(403);
  expect((await request(state.token, { type: "booking.receipt", bookingId: "MISSING" })).status).toBe(403);
  await harness.db
    .update(S.bookings)
    .set({ status: "cancelled" })
    .where(eq(S.bookings.vistaBookingId, bookingId));
  expect((await request(state.token, receipt)).status).toBe(409);
  await harness.db
    .update(S.bookings)
    .set({ status: "confirmed", qrPayload: null })
    .where(eq(S.bookings.vistaBookingId, bookingId));
  expect((await request(state.token, receipt)).status).toBe(409);
});
