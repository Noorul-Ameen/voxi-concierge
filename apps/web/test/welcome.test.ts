import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConnectionDetails, type Session, getSignedUrl } from "../src/lib/api";
import { connectionVariables, isCurrentConnection, nextWelcomeVariant } from "../src/lib/welcome";

const session: Session = { conversationId: "conversation", token: "current-token", language: "en", mode: "bot", isLoggedIn: true, agentId: "agent", dynamicVariables: { firstName: "Previous", greetingEn: "Hi Previous", customerId: "old-account" } };
const details: ConnectionDetails = { agentId: "agent", isLoggedIn: true, dynamicVariables: { firstName: "James", customerId: "james-account", memberId: "member", welcomeEn: "Welcome back, James!", welcomeAr: "أهلاً بعودتك يا James!", greetingEn: "Welcome back, James! What would you like to watch?", greetingAr: "أهلاً بعودتك يا James! ما الفيلم الذي نختاره اليوم؟" } };

afterEach(() => vi.unstubAllGlobals());

describe("fresh connection welcomes", () => {
  it("rotates across new starts with only an anonymous counter in storage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(Array.from({ length: 5 }, () => nextWelcomeVariant(storage))).toEqual([0, 1, 2, 3, 4]);
    expect([...data]).toEqual([["voxi.welcome.variant", "5"]]);
    data.set("voxi.welcome.variant", "corrupt");
    expect(nextWelcomeVariant(storage)).toBe(0);
  });

  it("continues rotating when browser storage is unavailable", () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: vi.fn() };
    const first = nextWelcomeVariant(storage);
    expect(nextWelcomeVariant(storage)).toBe(first + 1);
  });

  it("uses the fresh account greeting rather than cached previous-account details", () => {
    const value = connectionVariables(session, details, "ar");
    expect(value).toMatchObject({ firstName: "James", customerId: "james-account", language: "ar", greetingAr: details.dynamicVariables!.greetingAr });
    expect(JSON.stringify(value)).not.toContain("Previous");
    expect(JSON.stringify(value)).not.toContain("old-account");
  });

  it("uses the server's nameless guest greeting so guests also get a varied welcome", () => {
    const guest = connectionVariables(session, { agentId: "agent", isLoggedIn: false, dynamicVariables: { firstName: "", customerId: "", memberId: "", welcomeEn: "Good evening, welcome to VOX Cinemas.", welcomeAr: "مساء الخير، أهلاً بك في فوكس سينما.", greetingEn: "Good evening, welcome to VOX Cinemas. How can I help you today?", greetingAr: "مساء الخير، أهلاً بك في فوكس سينما. كيف أساعدك اليوم؟" } }, "en");
    expect(guest.greetingEn).toBe("Good evening, welcome to VOX Cinemas. How can I help you today?");
    expect(guest.firstName).toBe("");
    expect(JSON.stringify(guest)).not.toContain("Previous");
  });

  it.each([{}, { isLoggedIn: false, dynamicVariables: details.dynamicVariables }, { isLoggedIn: true }])("never falls back to a cached member greeting without fresh account data: %j", (value) => {
    const result = connectionVariables(session, { agentId: "agent", ...value }, "en");
    expect(result.firstName).toBe("");
    expect(result.customerId).toBe("");
    expect(result.greetingEn).toBe("Hi, welcome to VOX Cinemas. What are you in the mood to watch?");
    expect(result.greetingAr).not.toContain("James");
    expect(JSON.stringify(result)).not.toContain("Previous");
  });

  it("keeps hold continuation distinct from discovery without silently renewing it", () => {
    const active = connectionVariables(session, details, "en", "active");
    const expired = connectionVariables(session, details, "ar", "expired");
    expect(active.greetingEn).toBe("Welcome back, James! Shall we pick up your booking?");
    expect(expired.greetingEn).toContain("shall I check and hold seats again?");
    expect(expired.greetingAr).toContain("هل أتحقق وأحجز المقاعد مجدداً؟");
    expect(expired.greetingEn).not.toContain("would you like to watch");
  });

  it.each(["epoch", "attempt", "token", "conversationId", "busy"])("rejects a late startup result after %s changes", async (field) => {
    const expected = { attempt: 3, epoch: 4, token: "token", conversationId: "conversation" };
    const current = { ...expected, busy: false };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn();
    const work = pending.then(() => { if (isCurrentConnection(expected, current)) start(); });
    if (field === "epoch") current.epoch++;
    if (field === "attempt") current.attempt++;
    if (field === "token") current.token = "new-token";
    if (field === "conversationId") current.conversationId = "new-conversation";
    if (field === "busy") current.busy = true;
    release(); await work;
    expect(start).not.toHaveBeenCalled();
  });

  it("allows only the matching current authenticated startup", () => {
    const expected = { attempt: 3, epoch: 4, token: "token", conversationId: "conversation" };
    expect(isCurrentConnection(expected, { ...expected, busy: false })).toBe(true);
  });
});

describe("connection authentication", () => {
  it.each([401, 403, 500])("does not start the public agent with cached identity after HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response('{"error":"unavailable"}', { status })));
    await expect(getSignedUrl(session, 2)).rejects.toMatchObject({ status });
    await expect(getSignedUrl(session, 2)).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts a server-authorized public connection and sends no name in the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(details), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSignedUrl(session, 3)).toEqual(details);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/widget\/signed-url\?welcomeVariant=3$/);
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { authorization: "Bearer current-token" } });
  });
});
