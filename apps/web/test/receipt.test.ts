import { describe, expect, it, vi } from "vitest";
import type { CommandResult, UiHint } from "../src/lib/api";
import { receiptCompletesCurrentOrder, renderVerifiedReceipt } from "../src/lib/receipt";

const png = "data:image/png;base64,c3ludGhldGljLWltYWdl";
const booking = { bookingId: "BOOK-A", status: "confirmed", qrPayload: "actual-provider-ticket", totalCents: 9700 };
function receipt(): CommandResult {
  return { ok: true, ui: { type: "qr", items: [{ ...booking }], meta: { qrPayload: booking.qrPayload, receiptLookup: true } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("verified existing-booking QR display", () => {
  it("uses only the exact server receipt, prepares its real payload and acknowledges after rendering", async () => {
    const loading = deferred<CommandResult>();
    const image = deferred<string>();
    const displayed = deferred<void>();
    const load = vi.fn(() => loading.promise);
    const generate = vi.fn(() => image.promise);
    const render = vi.fn(() => displayed.promise);
    let settled = false;
    const result = renderVerifiedReceipt(" book-a ", load, generate, render, () => true)
      .then((value) => { settled = true; return value; });
    expect(load).toHaveBeenCalledWith("BOOK-A");
    expect(generate).not.toHaveBeenCalled();
    loading.resolve(receipt());
    await Promise.resolve();
    expect(generate).toHaveBeenCalledWith("actual-provider-ticket");
    expect(render).not.toHaveBeenCalled();
    image.resolve(png);
    await Promise.resolve();
    expect(render).toHaveBeenCalledWith({ type: "qr", items: [booking], meta: { qrPayload: booking.qrPayload, receiptLookup: true, preparedQr: { payload: booking.qrPayload, src: png } } });
    expect(settled).toBe(false);
    displayed.resolve();
    expect(await result).toEqual({ ok: true, rendered: true, bookingId: "BOOK-A" });
  });

  it.each([undefined, null, "", "  ", { bookingId: "BOOK-A" }])("rejects an absent or malformed booking reference: %s", async (id) => {
    const load = vi.fn();
    expect(await renderVerifiedReceipt(id, load, vi.fn(), vi.fn(), () => true)).toMatchObject({ ok: false, rendered: false });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "Receipt unavailable" },
    { ok: true, ui: { type: "booking", items: [booking] } },
    { ok: true, ui: { type: "qr", items: [{ ...booking, bookingId: "BOOK-B" }] } },
    { ok: true, ui: { type: "qr", items: [booking, booking] } },
    { ok: true, ui: { type: "qr", items: [{ ...booking, status: "cancelled" }] } },
    { ok: true, ui: { type: "qr", items: [{ ...booking, status: "pending" }] } },
    { ok: true, ui: { type: "qr", items: [{ ...booking, qrPayload: undefined }] } },
    { ok: true, ui: { type: "qr", items: [{ ...booking, qrPayload: " " }] } },
    { ok: true, ui: { type: "qr", items: [booking], meta: { qrPayload: "different-receipt" } } },
  ])("never draws an unverified, unavailable, cancelled or mismatched receipt: %#", async (response) => {
    const generate = vi.fn();
    const render = vi.fn();
    expect(await renderVerifiedReceipt("BOOK-A", async () => response, generate, render, () => true)).toMatchObject({ ok: false, rendered: false });
    expect(generate).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("permits an owned collected ticket with its unchanged provider payload", async () => {
    const response = receipt();
    response.ui!.items[0].status = "collected";
    expect(await renderVerifiedReceipt("BOOK-A", async () => response, async () => png, vi.fn(), () => true)).toMatchObject({ ok: true, rendered: true });
  });

  it.each(["before lookup", "after lookup", "after QR preparation", "during render"])("does not acknowledge a stale account %s", async (stage) => {
    let current = stage !== "before lookup";
    const load = vi.fn(async () => { if (stage === "after lookup") current = false; return receipt(); });
    const generate = vi.fn(async () => { if (stage === "after QR preparation") current = false; return png; });
    const render = vi.fn(async () => { if (stage === "during render") current = false; });
    expect(await renderVerifiedReceipt("BOOK-A", load, generate, render, () => current)).toMatchObject({ ok: false, rendered: false });
    if (stage === "before lookup") expect(load).not.toHaveBeenCalled();
    if (stage === "after lookup") expect(generate).not.toHaveBeenCalled();
    if (stage !== "during render") expect(render).not.toHaveBeenCalled();
  });

  it("rejects a delayed old-account lookup after a new session is installed", async () => {
    const loading = deferred<CommandResult>();
    const expected = { token: "old-token", epoch: 1 };
    let active = expected;
    const render = vi.fn();
    const result = renderVerifiedReceipt("BOOK-A", () => loading.promise, async () => png, render,
      () => active.token === expected.token && active.epoch === expected.epoch);
    active = { token: "new-token", epoch: 2 };
    loading.resolve(receipt());
    expect(await result).toMatchObject({ ok: false, rendered: false });
    expect(render).not.toHaveBeenCalled();
    expect(active).toEqual({ token: "new-token", epoch: 2 });
  });

  it.each(["lookup", "image", "render"])("returns an honest failure when %s fails", async (stage) => {
    const failure = () => { throw new Error("synthetic failure"); };
    const result = await renderVerifiedReceipt("BOOK-A", async () => stage === "lookup" ? failure() : receipt(),
      async () => stage === "image" ? failure() : png, async () => { if (stage === "render") failure(); }, () => true);
    expect(result).toMatchObject({ ok: false, rendered: false });
  });

  it("does not claim an image appeared when QR generation returned no valid PNG", async () => {
    const render = vi.fn();
    expect(await renderVerifiedReceipt("BOOK-A", async () => receipt(), async () => "BOOK-A", render, () => true)).toMatchObject({ ok: false, rendered: false });
    expect(render).not.toHaveBeenCalled();
  });

  it("preserves a current hold when reading an old receipt, while a new payment receipt completes it", () => {
    const lookup = receipt().ui!;
    expect(receiptCompletesCurrentOrder(lookup)).toBe(false);
    expect(receiptCompletesCurrentOrder({ type: "qr", items: [booking] })).toBe(true);
    expect(receiptCompletesCurrentOrder({ type: "payment", items: [] })).toBe(false);
  });

  it("does not forward agent-like actions, credentials or unrelated metadata into the receipt", async () => {
    const result = receipt();
    result.ui!.meta = { ...result.ui!.meta, token: "must-not-render", customerPassword: "must-not-render" };
    result.ui!.actions = [{ label: "Retry payment", value: "pay" }];
    let displayed: UiHint | undefined;
    await renderVerifiedReceipt("BOOK-A", async () => result, async () => png, (ui) => { displayed = ui; }, () => true);
    expect(displayed).not.toHaveProperty("actions");
    expect(JSON.stringify(displayed)).not.toContain("must-not-render");
  });
});
