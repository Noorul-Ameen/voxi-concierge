import { appendEvent } from "@voxi/concierge-core";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { redact } from "../src/app.js";
import { ingestPostCall } from "../src/webhooks.js";
import { startHarness } from "./harness.js";

let harness: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.stop();
});
const request = (path: string, body?: unknown, token?: string) =>
  harness.api.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("authenticated widget boundaries", () => {
  it("keeps a delayed prior call report from changing a reconnected conversation", async () => {
    const original = await request("/widget/session", { language: "en", modality: "voice" }).then(
      (r) => r.json() as any,
    );
    const targetId = `conv_postcall_${Date.now()}`;
    const linked = await request("/widget/link", { elevenLabsConversationId: targetId }, original.token).then(
      (r) => r.json() as any,
    );
    expect(linked.ok).toBe(true);
    await request("/widget/command", { type: "language", language: "ar" }, linked.token);
    await harness.db
      .update(S.conversations)
      .set({ modality: "text" })
      .where(eq(S.conversations.id, targetId));
    const [before] = await harness.db.select().from(S.conversations).where(eq(S.conversations.id, targetId));
    await ingestPostCall(harness.ctx, {
      type: "post_call_transcription",
      data: {
        agent_id: "test-agent",
        conversation_id: original.conversationId,
        status: "done",
        transcript: [{ role: "agent", message: "Previous call completed." }],
        metadata: { main_language: "en", call_duration_secs: 20 },
        conversation_initiation_client_data: { dynamic_variables: { language: "en", channel: "web" } },
      },
    });
    const [after] = await harness.db.select().from(S.conversations).where(eq(S.conversations.id, targetId));
    expect(after).toEqual(before);
    expect(after).toMatchObject({ language: "ar", modality: "text", status: "active" });
    const [historical] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, original.conversationId));
    expect(historical?.status).toBe("ended");
    const [transcript] = await harness.db
      .select()
      .from(S.transcripts)
      .where(eq(S.transcripts.conversationId, original.conversationId));
    expect(transcript?.turns).toMatchObject([{ text: "Previous call completed." }]);
  });

  it("preserves Arabic voice context across tools and session resume when fields are omitted", async () => {
    const session = await request("/widget/session", { language: "ar", modality: "voice" }).then(
      (r) => r.json() as any,
    );
    const context = await harness.tool("get_session_context", session.conversationId);
    expect(context.data).toMatchObject({ language: "ar", modality: "voice" });
    const food = await harness.tool("suggest_fnb", session.conversationId, { cinemaId: "0002" });
    expect(food.ok).toBe(true);
    expect(food.ui.title).toBe("المأكولات والمشروبات");
    await request("/widget/session", { conversationId: session.conversationId }, session.token);
    const resumed = await harness.tool("get_session_context", session.conversationId);
    expect(resumed.data).toMatchObject({ language: "ar", modality: "voice" });
  });

  it("keeps the Arabic interface when a movie search specifies English film language", async () => {
    const session = await request("/widget/session", { language: "ar", modality: "voice" }).then(
      (r) => r.json() as any,
    );
    const movies = await harness.tool("search_films", session.conversationId, { language: "English" });
    expect(movies.ok).toBe(true);
    expect(movies.data.films.length).toBeGreaterThan(0);
    expect(movies.data.films.every((film: { language: string }) => film.language === "English")).toBe(true);
    expect(movies.ui.title).toBe("الأفلام");
    const context = await harness.tool("get_session_context", session.conversationId);
    expect(context.data).toMatchObject({ language: "ar", modality: "voice" });
  });

  it("defaults only new conversations and still honors explicit language and modality changes", async () => {
    const conversationId = `conv_context_defaults_${Date.now()}`;
    const initial = await harness.tool("get_session_context", conversationId);
    expect(initial.data).toMatchObject({ language: "en", modality: "text", channel: "web" });
    const changed = await harness.tool(
      "get_session_context",
      conversationId,
      {},
      { language: "ar", modality: "voice" },
    );
    expect(changed.data).toMatchObject({ language: "ar", modality: "mixed" });
    const retained = await harness.tool("get_session_context", conversationId);
    expect(retained.data).toMatchObject({ language: "ar", modality: "mixed" });
  });

  it("preserves a target card produced by the agent before the widget finishes linking", async () => {
    const session = await harness.session();
    const target = `conv_earlytool_${Date.now()}`;
    await harness.db.insert(S.conversations).values({ id: target });
    await appendEvent(harness.db, null, target, "ui.render", {
      ui: { type: "showtimes", title: "Agent's current showtimes", items: [] },
    });
    const linked = await request("/widget/link", { elevenLabsConversationId: target }, session.token).then(
      (r) => r.json() as any,
    );
    expect(linked.ok).toBe(true);
    const response = await request("/widget/events", undefined, linked.token);
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("Agent's current showtimes");
    } finally {
      await reader.cancel();
    }
  });

  it("keeps stable event identities through repeated links without hiding early target or new events", async () => {
    const session = await harness.session();
    const old = await appendEvent(harness.db, null, session.conversationId, "ui.render", {
      ui: { type: "order", title: "Already displayed booking", items: [] },
    });
    const target = `conv_event_identity_${Date.now()}`;
    await harness.db.insert(S.conversations).values({ id: target });
    const early = await appendEvent(harness.db, null, target, "ui.render", {
      ui: { type: "showtimes", title: "Early target result", items: [] },
    });
    const first = await request("/widget/link", { elevenLabsConversationId: target }, session.token).then(
      (r) => r.json() as any,
    );
    expect(first.ok).toBe(true);
    const second = await request(
      "/widget/link",
      { elevenLabsConversationId: `${target}_next` },
      first.token,
    ).then((r) => r.json() as any);
    expect(second.ok).toBe(true);
    const latest = await appendEvent(harness.db, null, second.conversationId, "ui.render", {
      ui: { type: "payment", title: "New result after reconnect", items: [] },
    });
    const response = await request("/widget/events", undefined, second.token);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const received: { eventId: string; seq: number; ui: { title: string } }[] = [];
    let buffered = "";
    try {
      while (received.length < 3) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "ui.render") received.push(event);
        }
      }
      expect(received.map((event) => event.eventId)).toEqual([early.id, old.id, latest.id]);
      expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(received.map((event) => event.ui.title)).toEqual([
        "Early target result",
        "Already displayed booking",
        "New result after reconnect",
      ]);
    } finally {
      await reader.cancel();
    }
  });

  it("keeps member payment identity and confirmation intact after the conversation reconnects", async () => {
    const guest = await harness.session();
    const login = await harness.login(guest.conversationId, "JAMES");
    expect(login.ok).toBe(true);
    const session = { ...guest, token: login.token };
    const available = await harness.tool("search_sessions", session.conversationId, {
      cinemaName: "Mall of the Emirates",
      dateTo: "2099-01-01",
      limit: 30,
    });
    const show = available.data.sessions.find((item: any) => item.seatsAvailable > 3);
    expect(show).toBeTruthy();
    const held = await request(
      "/widget/command",
      { type: "booking.select", sessionKey: show.sessionKey, tickets: 1 },
      session.token,
    ).then((r) => r.json() as any);
    expect(held.ok).toBe(true);
    const prepared = await harness.tool("prepare_payment", session.conversationId, {
      userSessionId: held.data.order.userSessionId,
      method: "CARD",
    });
    expect(prepared.ok).toBe(true);
    const linked = await request(
      "/widget/link",
      { elevenLabsConversationId: `conv_paylink_${Date.now()}` },
      session.token,
    ).then((r) => r.json() as any);
    expect(linked.ok).toBe(true);
    const paid = await request(
      "/widget/command",
      {
        type: "payment.token",
        userSessionId: held.data.order.userSessionId,
        confirmationId: prepared.data.confirmationId,
        token: "tok_visa_424242_4242_relink",
        customer: { name: "Demo Guest", email: "guest@example.com", phone: "+971500000001" },
      },
      linked.token,
    ).then((r) => r.json() as any);
    expect(paid.ok, paid.error).toBe(true);
    expect(paid.action.status).toBe("succeeded");
    expect(paid.ui.type).toBe("qr");
    const [booking] = await harness.db
      .select()
      .from(S.bookings)
      .where(eq(S.bookings.vistaBookingId, paid.data.bookingId));
    expect(booking?.customerId).toBe("cust_james");
    expect(booking?.customer).toMatchObject({
      FirstName: "James",
      LastName: "Whitfield",
      Email: "james.whitfield@example.com",
    });
    expect(JSON.stringify(booking?.customer)).not.toContain("guest@example.com");
  });

  it("keeps cleared account events outside the replay window when reconnecting", async () => {
    const session = await harness.session();
    await appendEvent(harness.db, null, session.conversationId, "ui.render", {
      ui: { type: "order", title: "Previous account booking", items: [] },
    });
    const signedOut = await request("/widget/logout", {}, session.token).then((r) => r.json() as any);
    await appendEvent(harness.db, null, session.conversationId, "ui.render", {
      ui: { type: "showtimes", title: "Current account choices", items: [] },
    });
    const target = `conv_replay_${Date.now()}`;
    const linked = await request("/widget/link", { elevenLabsConversationId: target }, signedOut.token).then(
      (r) => r.json() as any,
    );
    expect(linked.ok).toBe(true);
    const events = await harness.db
      .select()
      .from(S.conversationEvents)
      .where(eq(S.conversationEvents.conversationId, target));
    expect(JSON.stringify(events)).not.toContain("Previous account booking");
    expect(JSON.stringify(events)).toContain("Current account choices");
  });

  it("does not replay previous-account cards after signing out", async () => {
    const session = await harness.session();
    await appendEvent(harness.db, null, session.conversationId, "ui.render", {
      ui: { type: "order", title: "Private previous booking", items: [] },
    });
    const signedOut = await request("/widget/logout", {}, session.token).then((r) => r.json() as any);
    const response = await request("/widget/events?after=0", undefined, signedOut.token);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("heartbeat");
      expect(text).not.toContain("Private previous booking");
    } finally {
      await reader.cancel();
    }
  });

  it("closes an already-open event stream when its session token is revoked", async () => {
    const session = await harness.session();
    const response = await request("/widget/events", undefined, session.token);
    const reader = response.body!.getReader();
    try {
      await reader.read();
      await request("/widget/logout", {}, session.token);
      await appendEvent(harness.db, harness.ctx.events, session.conversationId, "ui.render", {
        ui: { type: "order", title: "New account booking", items: [] },
      });
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });

  it("does not restore identity when a slow sign-in finishes after sign-out", async () => {
    const session = await harness.session();
    const validate = harness.ctx.vista.validateMember.bind(harness.ctx.vista);
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = vi.spyOn(harness.ctx.vista, "validateMember").mockImplementation(async (...args) => {
      signalStarted();
      await gate;
      return validate(...args);
    });
    try {
      const pending = request(
        "/widget/login",
        { email: "sara.almansoori@example.com", password: process.env.DEMO_SARA_PASSWORD },
        session.token,
      );
      await started;
      const signedOut = await request("/widget/logout", {}, session.token).then((r) => r.json() as any);
      expect(signedOut.ok).toBe(true);
      release();
      const late = await pending;
      expect(late.status).toBe(401);
      const state = await request("/widget/state", undefined, signedOut.token).then((r) => r.json() as any);
      expect(state.conversation.isLoggedIn).toBe(false);
      expect(state.conversation.customerId).toBeNull();
    } finally {
      release();
      delayed.mockRestore();
    }
  });

  it("returns the selected show, asks unknown quantity, and renders a held order through widget commands", async () => {
    const session = await harness.session();
    const available = await harness.tool("search_sessions", session.conversationId, {
      cinemaName: "Mall of the Emirates",
      dateTo: "2099-01-01",
      limit: 30,
    });
    const show = available.data.sessions.find((item: any) => item.seatsAvailable > 3);
    expect(show).toBeTruthy();
    const selected = await request(
      "/widget/command",
      { type: "booking.select", sessionKey: show.sessionKey },
      session.token,
    ).then((r) => r.json() as any);
    expect(selected.ok).toBe(true);
    expect(selected.ui.type).toBe("quantity");
    expect(selected.ui.meta.sessionKey).toBe(show.sessionKey);
    expect(selected.data.needs).toBe("tickets");
    const held = await request(
      "/widget/command",
      {
        type: "booking.select",
        sessionKey: show.sessionKey,
        tickets: 2,
        idempotencyKey: "widget-confirm-tickets",
      },
      session.token,
    ).then((r) => r.json() as any);
    expect(held.ok).toBe(true);
    expect(held.ui.type).toBe("order");
    expect(held.data.order.tickets).toHaveLength(2);
    expect(held.ui.meta.sessionKey).toBe(show.sessionKey);
    const repeat = await request(
      "/widget/command",
      {
        type: "booking.select",
        sessionKey: show.sessionKey,
        tickets: 2,
        idempotencyKey: "widget-confirm-tickets",
      },
      session.token,
    ).then((r) => r.json() as any);
    expect(repeat.data.order.userSessionId).toBe(held.data.order.userSessionId);
    const state = await request(
      "/widget/command",
      { type: "order.state", userSessionId: held.data.order.userSessionId },
      session.token,
    ).then((r) => r.json() as any);
    expect(state.ok).toBe(true);
    expect(state.ui.type).toBe("order");
    await harness.tool("cancel_order", session.conversationId, {
      userSessionId: held.data.order.userSessionId,
    });
  });

  it("persists the language selection only for the authenticated conversation", async () => {
    const session = await harness.session();
    expect((await request("/widget/command", { type: "language", language: "ar" })).status).toBe(401);
    const changed = await request("/widget/command", { type: "language", language: "ar" }, session.token);
    expect(changed.status).toBe(200);
    const state = await request("/widget/state", undefined, session.token).then((r) => r.json() as any);
    expect(state.conversation.language).toBe("ar");
    expect(
      (await request("/widget/command", { type: "language", language: "fr" }, session.token)).status,
    ).toBe(400);
  });

  it("cannot resume another conversation by knowing its ID", async () => {
    const owner = await harness.session();
    expect((await request("/widget/session", { conversationId: owner.conversationId })).status).toBe(401);
    const other = await harness.session();
    expect(
      (await request("/widget/session", { conversationId: owner.conversationId }, other.token)).status,
    ).toBe(401);
    const resumed = await request("/widget/session", { conversationId: owner.conversationId }, owner.token);
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as any).conversationId).toBe(owner.conversationId);
  });

  it("rejects attached identity IDs and legacy credential-only authentication", async () => {
    expect((await request("/widget/session", { customerId: "CUST002" })).status).toBe(400);
    const session = await harness.session();
    const legacy = await request("/widget/login", { identifier: "SHR200877", pin: "2468" }, session.token);
    expect(legacy.status).toBe(400);
    expect((await request("/widget/profile")).status).toBe(401);
    expect((await request("/widget/profile", undefined, session.token)).status).toBe(401);
  });

  it("signs in with email/password and exposes consistent profile/history without secrets", async () => {
    const session = await harness.session();
    const login = await harness.login(session.conversationId, "RAHUL");
    expect(login.ok).toBe(true);
    expect((await request("/widget/state", undefined, session.token)).status).toBe(401);
    const response = await request("/widget/profile", undefined, login.token);
    expect(response.status).toBe(200);
    const profile = (await response.json()) as any;
    expect(profile.customer.firstName).toBe("Rahul");
    expect(profile.profile.movieLanguage).toBe("Tamil");
    expect(Array.isArray(profile.history)).toBe(true);
    expect(profile.history.length).toBeGreaterThan(0);
    expect(JSON.stringify(profile)).not.toMatch(/password|demoPin|tok_visa|widgetSessionKey/);
  });

  it("refuses a legacy PIN-only provider success and keeps the existing guest session usable", async () => {
    const session = await harness.session();
    const legacy = vi.spyOn(harness.ctx.vista, "validateMember").mockResolvedValueOnce({
      Result: 0,
      Member: { CustomerId: "cust_sara", MemberId: "legacy-member" },
      LoyaltySessionToken: "legacy-session-token",
    });
    try {
      const response = await request(
        "/widget/login",
        { email: "sara.almansoori@example.com", password: "unverified-password" },
        session.token,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false });
      const [conversation] = await harness.db
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, session.conversationId));
      expect(conversation).toMatchObject({ isLoggedIn: false, customerId: null, memberId: null });
      expect((await request("/widget/state", undefined, session.token)).status).toBe(200);
      expect((await request("/widget/profile", undefined, session.token)).status).toBe(401);
    } finally {
      legacy.mockRestore();
    }
  });

  it("clears account-specific booking choices on signout and invalidates the old token", async () => {
    const session = await harness.session();
    const login = await harness.login(session.conversationId, "SARA");
    const [row] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    await harness.db
      .update(S.conversations)
      .set({
        mode: "human",
        metadata: {
          ...row!.metadata,
          activeOrder: "private-order",
          fnbOrder: "private-food",
          fnbForBookingId: "private-food-booking",
          pendingBooking: { sessionKey: "private-show" },
          bookingState: { selectedMovie: "private-film" },
          lastBookingId: "private-booking",
        },
      })
      .where(eq(S.conversations.id, session.conversationId));
    await harness.db.insert(S.transfers).values({
      id: `tr_logout_${Date.now()}`,
      conversationId: session.conversationId,
      reason: "customer_request",
      summary: "Previous account handover",
      adapter: "simulated",
      status: "connected",
    });
    const loggedOut = await request("/widget/logout", {}, login.token).then((r) => r.json() as any);
    expect(loggedOut.ok).toBe(true);
    expect((await request("/widget/state", undefined, login.token)).status).toBe(401);
    const state = await request("/widget/state", undefined, loggedOut.token).then((r) => r.json() as any);
    expect(state.conversation.isLoggedIn).toBe(false);
    expect(state.conversation.customerId).toBeNull();
    expect(state.conversation.mode).toBe("bot");
    expect(state.transfer.status).toBe("ended");
    expect(state.conversation.metadata).toEqual({});
    const [cleared] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    expect(cleared!.metadata).not.toHaveProperty("fnbForBookingId");
    expect(JSON.stringify(state)).not.toContain("widgetSessionKey");
  });

  it("rejects linking to another widget's conversation and preserves authenticated source state", async () => {
    const source = await harness.session();
    const login = await harness.login(source.conversationId, "JAMES");
    const other = await harness.session();
    expect(
      (await request("/widget/link", { elevenLabsConversationId: other.conversationId }, login.token)).status,
    ).toBe(409);
    const linked = await request(
      "/widget/link",
      { elevenLabsConversationId: `conv_linked_${Date.now()}` },
      login.token,
    ).then((r) => r.json() as any);
    expect(linked.ok).toBe(true);
    expect((await request("/widget/state", undefined, login.token)).status).toBe(401);
    const state = await request("/widget/state", undefined, linked.token).then((r) => r.json() as any);
    expect(state.conversation.isLoggedIn).toBe(true);
    expect(state.conversation.customerId).toBe(login.customer.id);
  });

  it("does not carry one customer's active booking into a different signed-in account", async () => {
    const session = await harness.session();
    const sara = await harness.login(session.conversationId, "SARA");
    const [row] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    await harness.db
      .update(S.conversations)
      .set({
        metadata: {
          ...row!.metadata,
          activeOrder: "saras-order",
          fnbForBookingId: "saras-food-booking",
          pendingBooking: { sessionKey: "saras-show" },
        },
      })
      .where(eq(S.conversations.id, session.conversationId));
    const james = await request(
      "/widget/login",
      { email: "james.whitfield@example.com", password: process.env.DEMO_JAMES_PASSWORD },
      sara.token,
    ).then((r) => r.json() as any);
    expect(james.ok).toBe(true);
    expect(james.customer.firstName).toBe("James");
    const state = await request("/widget/state", undefined, james.token).then((r) => r.json() as any);
    expect(state.conversation.metadata).toEqual({});
    const [switched] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    expect(switched!.metadata).not.toHaveProperty("fnbForBookingId");
    expect((await request("/widget/state", undefined, sara.token)).status).toBe(401);
  });

  it("rejects another guest's order ID before reading or changing it", async () => {
    const owner = await harness.session();
    const other = await harness.session();
    const denied = await request(
      "/widget/command",
      { type: "seat.select", userSessionId: "another-guests-order", seats: [{ row: "G", number: "1" }] },
      other.token,
    );
    expect(denied.status).toBe(403);
    const deniedRead = await request(
      "/widget/command",
      { type: "order.state", userSessionId: "another-guests-order" },
      owner.token,
    );
    expect(deniedRead.status).toBe(403);
    const agentRead = await harness.tool("get_order", other.conversationId, {
      userSessionId: "another-guests-order",
    });
    expect(agentRead.ok).toBe(false);
    expect(agentRead.error.code).toBe("UNAUTHORIZED");
  });
});

it("redacts nested credentials and card tokens without recording a password prefix", () => {
  const result = redact({
    customer: { email: "person@example.com", password: "secret-password", pin: "1234" },
    cards: [{ token: "private-token", cvv: "123" }],
    safe: "seat G1",
  });
  expect(result).toEqual({
    customer: { email: "pe…", password: "[redacted]", pin: "[redacted]" },
    cards: [{ token: "[redacted]", cvv: "[redacted]" }],
    safe: "seat G1",
  });
});
