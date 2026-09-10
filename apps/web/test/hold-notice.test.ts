import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/lib/api";
import { isCurrentHold, verifyHoldNotice, type HoldNoticeSnapshot } from "../src/lib/widget-state";

const deadline = Date.parse("2030-06-03T13:00:00Z");
const hold: HoldNoticeSnapshot = {
  token: "synthetic-token", conversationId: "conversation-a", epoch: 1,
  userSessionId: "order-a", expiresAtUtc: new Date(deadline).toISOString(),
};
const booking = {
  userSessionId: hold.userSessionId, seatHoldExpiry: hold.expiresAtUtc,
  currentJourneyStage: "payment", requiresFreshHold: false,
};
const state = (metadata: Record<string, unknown> = { activeOrder: hold.userSessionId, bookingState: booking }) => ({
  conversation: { id: hold.conversationId, metadata },
});
const expired: CommandResult = {
  ok: true,
  data: { active: false, expired: true, userSessionId: hold.userSessionId, summary: { expiresAtUtc: hold.expiresAtUtc } },
  ui: { type: "order", items: [], meta: { userSessionId: hold.userSessionId, expired: true } },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("hold notices verify the current booking before announcing", () => {
  it.each([deadline - 60000, deadline + 60000])("clears a paid replay silently at %s, without replacing its receipt or payment UI", async (now) => {
    // Payment clears activeOrder; historical bookingState and SSE cards can retain the old deadline.
    const readOrder = vi.fn(async () => expired);
    const result = await verifyHoldNotice(hold, () => hold,
      async () => state({ activeOrder: null, bookingState: booking, lastBookingId: "paid-booking" }), readOrder, () => now);
    expect(result).toEqual({ kind: "clear" });
    expect(result.ui).toBeUndefined();
    expect(readOrder).not.toHaveBeenCalled();
  });

  it("waits for actual expiry confirmation before returning a notice or recovery card", async () => {
    const response = deferred<CommandResult>();
    const readOrder = vi.fn(() => response.promise);
    let settled = false;
    const pending = verifyHoldNotice(hold, () => hold, async () => state(), readOrder, () => deadline)
      .then((notice) => { settled = true; return notice; });
    await Promise.resolve();
    expect(readOrder).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    response.resolve(expired);
    expect(await pending).toEqual({ kind: "expired", ui: expired.ui });
  });

  it("rechecks the clock after a slow state read instead of issuing an already-expired two-minute notice", async () => {
    let now = deadline - 1000;
    const response = deferred<ReturnType<typeof state>>();
    const readOrder = vi.fn(async () => expired);
    const pending = verifyHoldNotice(hold, () => hold, () => response.promise, readOrder, () => now);
    now = deadline + 1000;
    response.resolve(state());
    expect(await pending).toEqual({ kind: "expired", ui: expired.ui });
    expect(readOrder).toHaveBeenCalledOnce();
  });

  it("warns about a verified live hold without emitting an order review over checkout", async () => {
    const readOrder = vi.fn(async () => expired);
    expect(await verifyHoldNotice(hold, () => hold, async () => state(), readOrder, () => deadline - 60000))
      .toEqual({ kind: "soon" });
    expect(readOrder).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...booking, userSessionId: "other-order" },
    { ...booking, seatHoldExpiry: new Date(deadline + 60000).toISOString() },
    { ...booking, currentJourneyStage: "expired" },
    { ...booking, currentJourneyStage: undefined },
    { ...booking, requiresFreshHold: true },
  ])("does not infer a live warning from incomplete, expired or mismatched booking state: %j", async (bookingState) => {
    const readOrder = vi.fn(async () => expired);
    expect(await verifyHoldNotice(hold, () => hold,
      async () => state({ activeOrder: hold.userSessionId, bookingState }), readOrder, () => deadline - 60000))
      .toEqual({ kind: "none" });
    expect(readOrder).not.toHaveBeenCalled();
  });

  it("clears a paid order when checkout finishes between the state and expiry reads", async () => {
    const response = deferred<CommandResult>();
    const pending = verifyHoldNotice(hold, () => hold, async () => state(), () => response.promise, () => deadline);
    await Promise.resolve();
    response.resolve({ ok: true, data: { active: false, paid: true, bookingId: "paid-booking" } });
    expect(await pending).toEqual({ kind: "clear" });
  });

  it.each([
    { ...hold, token: "new-token" },
    { ...hold, conversationId: "new-conversation" },
    { ...hold, epoch: hold.epoch + 1 },
    { ...hold, userSessionId: "new-order" },
    { ...hold, expiresAtUtc: new Date(deadline + 600000).toISOString() },
    null,
  ])("discards a pending expiry response after the current session/hold changes: %j", async (next) => {
    let current: HoldNoticeSnapshot | null = hold;
    const response = deferred<CommandResult>();
    const pending = verifyHoldNotice(hold, () => current, async () => state(), () => response.promise, () => deadline);
    await Promise.resolve();
    current = next;
    response.resolve(expired);
    expect(await pending).toEqual({ kind: "none" });
    expect(isCurrentHold(hold, current)).toBe(false);
  });

  it("ignores a stale silent-state response before any order command is sent", async () => {
    let current: HoldNoticeSnapshot | null = hold;
    const response = deferred<ReturnType<typeof state>>();
    const readOrder = vi.fn(async () => expired);
    const pending = verifyHoldNotice(hold, () => current, () => response.promise, readOrder, () => deadline);
    current = null; // A receipt, logout or disposed subscription has already cleared this hold.
    response.resolve(state());
    expect(await pending).toEqual({ kind: "none" });
    expect(readOrder).not.toHaveBeenCalled();
  });

  it("does not use another conversation's state", async () => {
    const readOrder = vi.fn(async () => expired);
    expect(await verifyHoldNotice(hold, () => hold, async () => ({ conversation: { ...state().conversation, id: "other-conversation" } }), readOrder, () => deadline))
      .toEqual({ kind: "none" });
    expect(readOrder).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "Temporarily unavailable" },
    { ok: true, data: { ...expired.data, userSessionId: "other-order" } },
    { ok: true, data: { ...expired.data, summary: { expiresAtUtc: new Date(deadline + 600000).toISOString() } } },
    { ok: true, data: { active: true } },
  ])("does not announce expiry from failed, mismatched or still-live order responses: %j", async (result) => {
    expect(await verifyHoldNotice(hold, () => hold, async () => state(), async () => result, () => deadline))
      .toEqual({ kind: "none" });
  });

  it("leaves the basket alone on network failures and allows a subsequent verified attempt", async () => {
    const failure = async () => { throw new Error("network unavailable"); };
    const readOrder = vi.fn(async () => expired);
    expect(await verifyHoldNotice(hold, () => hold, failure, readOrder, () => deadline)).toEqual({ kind: "none" });
    expect(readOrder).not.toHaveBeenCalled();
    expect(await verifyHoldNotice(hold, () => hold, async () => state(), failure, () => deadline)).toEqual({ kind: "none" });
    expect(await verifyHoldNotice(hold, () => hold, async () => state(), readOrder, () => deadline)).toEqual({ kind: "expired", ui: expired.ui });
  });

  it("does not create notices when no current hold exists or its deadline is outside the warning window", async () => {
    const readState = vi.fn(async () => state());
    const readOrder = vi.fn(async () => expired);
    expect(await verifyHoldNotice(hold, () => null, readState, readOrder, () => deadline)).toEqual({ kind: "none" });
    expect(readState).not.toHaveBeenCalled();
    expect(await verifyHoldNotice(hold, () => hold, readState, readOrder, () => deadline - 180000)).toEqual({ kind: "none" });
    expect(readOrder).not.toHaveBeenCalled();
  });
});
