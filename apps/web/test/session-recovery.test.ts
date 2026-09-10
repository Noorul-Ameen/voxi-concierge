import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, sessionExpiryHandler, subscribe } from "../src/lib/api";

const session: Session = { conversationId: "fixture-conversation", token: "fixture-old-token", language: "en", mode: "bot", isLoggedIn: true, agentId: "fixture-agent", dynamicVariables: {} };
const response = (status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => "unauthorized", json: async () => ({ conversation: {} }) }) as Response;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  close = vi.fn();
  listeners = new Map<string, (event: { data: string }) => void>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, handler: (event: { data: string }) => void) { this.listeners.set(name, handler); }
  emit(name: string, value: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
}

describe("expired widget event sessions", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    fetchMock.mockReset();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([401, 403])("stops retries only after the same session confirms HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(response(status));
    const invalid = vi.fn();
    const statuses = vi.fn();
    const stop = subscribe(session, vi.fn(), statuses, invalid);
    const source = FakeEventSource.instances[0];
    source.onerror?.();
    source.onerror?.(); // duplicate transport errors share one probe
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/widget\/state$/);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer fixture-old-token" });
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenLastCalledWith("closed");
    expect(source.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no logout, cancellation or fresh booking request
    stop();
  });

  it.each([500, 503, "network"])("keeps backoff for %s without invalidating the account", async (failure) => {
    fetchMock.mockImplementation(async () => {
      if (failure === "network") throw new TypeError("offline");
      return response(failure);
    });
    const invalid = vi.fn();
    const stop = subscribe(session, vi.fn(), undefined, invalid);
    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1].onerror?.();
    await vi.advanceTimersByTimeAsync(3999);
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(invalid).not.toHaveBeenCalled();
    stop();
  });

  it("reconnects a valid session from the latest event and ignores old-source callbacks", async () => {
    fetchMock.mockResolvedValue(response());
    const received = vi.fn();
    const stop = subscribe(session, received);
    const first = FakeEventSource.instances[0];
    first.emit("ui.render", { type: "ui.render", seq: 17, ui: { type: "order", items: [] } });
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeEventSource.instances[1].url).toContain("after=17");
    first.onerror?.();
    first.emit("ui.render", { type: "ui.render", seq: 18 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledTimes(1);
    stop();
  });

  it("bounds a hung authentication probe and treats timeout as a transport failure", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const invalid = vi.fn();
    const stop = subscribe(session, vi.fn(), undefined, invalid);
    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(6999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(invalid).not.toHaveBeenCalled();
    stop();
  });

  it("ignores a late rejection after unsubscribe and leaves a new login subscribed", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const oldInvalid = vi.fn();
    const stopOld = subscribe(session, vi.fn(), undefined, oldInvalid);
    FakeEventSource.instances[0].onerror?.();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    stopOld();
    expect(signal?.aborted).toBe(true);
    const next = { ...session, token: "fixture-new-token" };
    const newInvalid = vi.fn();
    const stopNew = subscribe(next, vi.fn(), undefined, newInvalid);
    resolve(response(401));
    await vi.advanceTimersByTimeAsync(60000);
    expect(oldInvalid).not.toHaveBeenCalled();
    expect(newInvalid).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("fixture-new-token");
    expect(FakeEventSource.instances[1].close).not.toHaveBeenCalled();
    stopNew();
  });

  it("cancels scheduled reconnection when the component unsubscribes", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const stop = subscribe(session, vi.fn());
    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it.each(["token", "conversation", "epoch", "login", "cleared"])("does not invalidate private UI after %s changes during a probe", async (change) => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const current: { session: Session | null; epoch: number; busy: boolean } = { session, epoch: 7, busy: false };
    const expire = vi.fn();
    const guarded = sessionExpiryHandler(session, 7, () => current, expire);
    const stop = subscribe(session, vi.fn(), undefined, guarded);
    FakeEventSource.instances[0].onerror?.();
    if (change === "token") current.session = { ...session, token: "new-token" };
    if (change === "conversation") current.session = { ...session, conversationId: "new-conversation" };
    if (change === "epoch") current.epoch++;
    if (change === "login") current.busy = true;
    if (change === "cleared") current.session = null;
    resolve(response(401));
    await vi.advanceTimersByTimeAsync(0);
    expect(expire).not.toHaveBeenCalled();
    stop();
  });

  it("runs current-session recovery once even when state and stream both reject it", () => {
    const expire = vi.fn();
    const guarded = sessionExpiryHandler(session, 7, () => ({ session, epoch: 7, busy: false }), expire);
    guarded();
    guarded();
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
