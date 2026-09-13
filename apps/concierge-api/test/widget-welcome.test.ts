import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { startHarness } from "./harness.js";

let harness: Awaited<ReturnType<typeof startHarness>>;
let api: ReturnType<typeof createApp>;
type WelcomeResponse = { isLoggedIn: boolean; dynamicVariables: Record<string, string> };
beforeAll(async () => {
  harness = await startHarness();
  // Exercise the authenticated public-agent branch without any provider network call.
  api = createApp(
    { ...harness.ctx, cfg: { ...harness.ctx.cfg, elevenLabsApiKey: undefined } },
    { logging: false },
  );
});
afterAll(async () => {
  await harness?.stop();
});

const welcome = (token: string, variant = 0, extra = "") =>
  api.request(`/widget/signed-url?welcomeVariant=${variant}${extra}`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("verified connection greetings", () => {
  it("keeps guests generic and ignores client-supplied identity query fields", async () => {
    const session = await harness.session();
    const response = await welcome(session.token, 2, "&firstName=Sara&customerId=cus_sara");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as WelcomeResponse;
    expect(result.isLoggedIn).toBe(false);
    expect(result.dynamicVariables).toMatchObject({ firstName: "", customerId: "", memberId: "" });
    expect(result.dynamicVariables.greetingEn).toBe(
      "Hi, welcome to VOX Cinemas. What are you in the mood to watch?",
    );
    expect(JSON.stringify(result.dynamicVariables)).not.toContain("Sara");
  });

  it("returns varied paired welcomes from the verified account without profile or credentials", async () => {
    const session = await harness.session();
    const login = await harness.login(session.conversationId, "SARA");
    expect(login.ok).toBe(true);
    const responses = await Promise.all(
      [0, 1, 2, 3].map(async (variant) => {
        const response = await welcome(login.token, variant);
        expect(response.status).toBe(200);
        return (await response.json()) as WelcomeResponse;
      }),
    );
    expect(new Set(responses.map((result) => result.dynamicVariables.greetingEn)).size).toBe(4);
    expect(new Set(responses.map((result) => result.dynamicVariables.greetingAr)).size).toBe(4);
    for (const result of responses) {
      expect(result.isLoggedIn).toBe(true);
      expect(result.dynamicVariables.firstName).toBe("Sara");
      expect(result.dynamicVariables.greetingEn).toContain("Sara");
      expect(result.dynamicVariables.greetingAr).toContain("Sara");
      expect(Object.keys(result.dynamicVariables).sort()).toEqual(
        [
          "channel",
          "conversationId",
          "customerId",
          "firstName",
          "greetingAr",
          "greetingEn",
          "language",
          "memberId",
          "welcomeAr",
          "welcomeEn",
        ].sort(),
      );
      expect(JSON.stringify(result).includes(process.env.DEMO_SARA_PASSWORD!)).toBe(false);
      expect(JSON.stringify(result)).not.toContain("sara.almansoori@example.com");
    }
  });

  it("uses only the new account after a switch and removes the name after logout", async () => {
    const session = await harness.session();
    const sara = await harness.login(session.conversationId, "SARA");
    const james = await harness.login(session.conversationId, "JAMES");
    expect(james.ok).toBe(true);
    expect((await welcome(sara.token)).status).toBe(401);
    const current = await welcome(james.token, 1).then(
      (response) => response.json() as Promise<WelcomeResponse>,
    );
    expect(current.dynamicVariables.firstName).toBe("James");
    expect(JSON.stringify(current.dynamicVariables)).not.toContain("Sara");
    const loggedOut = await harness.widget("logout", james.token, {});
    expect((await welcome(james.token)).status).toBe(401);
    const guest = await welcome(loggedOut.token, 2).then(
      (response) => response.json() as Promise<WelcomeResponse>,
    );
    expect(guest.isLoggedIn).toBe(false);
    expect(guest.dynamicVariables).toMatchObject({ firstName: "", customerId: "", memberId: "" });
    expect(JSON.stringify(guest.dynamicVariables)).not.toMatch(/Sara|James/);
  });

  it("rejects a greeting lookup that finishes after its account token was revoked", async () => {
    const session = await harness.session();
    const login = await harness.login(session.conversationId, "RAHUL");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = harness.ctx.vista.customer.bind(harness.ctx.vista);
    const lookup = vi.spyOn(harness.ctx.vista, "customer").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    try {
      const response = welcome(login.token);
      await pending;
      const loggedOut = await harness.widget("logout", login.token, {});
      expect(loggedOut.ok).toBe(true);
      release();
      const expired = await response;
      expect(expired.status).toBe(401);
      expect(await expired.text()).not.toContain("Rahul");
    } finally {
      release();
      lookup.mockRestore();
    }
  });
});
