process.env.TZ = "UTC";
import { type ServerType, serve } from "@hono/node-server";
import {
  Catalog,
  SimulatedHandover,
  appendEvent,
  createContext,
  executeAction,
  ledger,
} from "@voxi/concierge-core";
import { createDb } from "@voxi/db";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";
import { createApp as createVistaMock } from "../../vista-mock/src/app.js";
import { loadConfig as loadMockConfig } from "../../vista-mock/src/config.js";
import { createApp } from "../src/app.js";

export async function startHarness() {
  const dbUrl = process.env.DATABASE_URL ?? "postgres://voxi:voxi@localhost:5432/voxi";
  const mockDb = createDb(dbUrl, { max: 5 });
  const mockCfg = loadMockConfig({ ...process.env, NODE_ENV: "test" });
  const mock = createVistaMock(mockDb.db, mockCfg);
  const port = 4300 + Math.floor(Math.random() * 500);
  const server: ServerType = serve({ fetch: mock.fetch, port });
  const env = {
    ...process.env,
    VISTA_BASE_URL: `http://localhost:${port}/vistatickets/vista/v2`,
    VISTA_OAUTH_URL: `http://localhost:${port}/v1/oauth/generate`,
    TOOL_HMAC_SECRET: "test-secret",
    HANDOVER_ADAPTER: "simulated",
    CONFIRMATION_TTL_SECONDS: "60",
  };
  const { db, close } = createDb(dbUrl, { max: 8 });
  const ctx = createContext(db, { env, handover: new SimulatedHandover() });
  ctx.log.level = "warn";
  const api = createApp(ctx, { writeWaitMs: 6000, logging: false });
  const catalog = new Catalog(ctx.vista);
  // in-process worker
  let running = true;
  const worker = (async () => {
    while (running) {
      const a = await ledger.claimNext(db, "test-worker").catch(() => null);
      if (!a) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      await executeAction(ctx, catalog, a);
    }
  })();
  const housekeeping = (async () => {
    while (running) {
      const h = ctx.handover as SimulatedHandover;
      for (const reply of h.pending()) {
        const tr = (await db.select().from(S.transfers).where(eq(S.transfers.id, reply.transferId)))[0];
        if (tr && tr.status !== "connected") {
          await db
            .update(S.transfers)
            .set({ status: "connected", agentName: reply.agentName })
            .where(eq(S.transfers.id, tr.id));
          await appendEvent(db, ctx.events, reply.conversationId, "transfer.status", {
            transferId: tr.id,
            status: "connected",
            agentName: reply.agentName,
          });
        }
        await appendEvent(
          db,
          ctx.events,
          reply.conversationId,
          "human.message",
          { transferId: reply.transferId, text: reply.text, agentName: reply.agentName },
          "human_agent",
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const tool = async (
    name: string,
    conversationId: string,
    input: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const res = await api.request(`/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voxi-key": "test-secret" },
      body: JSON.stringify({ conversationId, ...extra, ...input }),
    });
    return (await res.json()) as any;
  };
  const widget = async (path: string, token: string, body?: unknown) => {
    const res = await api.request(`/widget/${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as any;
  };
  const sessions = new Map<
    string,
    { conversationId: string; token: string; dynamicVariables?: Record<string, string>; [key: string]: any }
  >();
  const session = async (conversationId?: string) => {
    if (conversationId && sessions.has(conversationId)) return sessions.get(conversationId)!;
    const fresh = await api
      .request("/widget/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      .then((r) => r.json() as any);
    const linked =
      conversationId && fresh.conversationId !== conversationId
        ? await widget("link", fresh.token, { elevenLabsConversationId: conversationId })
        : fresh;
    if (!linked.token) throw new Error(`Test session could not be created: ${JSON.stringify(linked)}`);
    const current = {
      ...fresh,
      ...linked,
      dynamicVariables: { ...fresh.dynamicVariables, conversationId: linked.conversationId },
    };
    sessions.set(linked.conversationId, current);
    return current;
  };
  const login = async (conversationId: string, persona: "SARA" | "RAHUL" | "JAMES") => {
    const emails = {
      SARA: "sara.almansoori@example.com",
      RAHUL: "rahul.menon@example.com",
      JAMES: "james.whitfield@example.com",
    };
    const current = await session(conversationId);
    const password = process.env[`DEMO_${persona}_PASSWORD`];
    if (!password) throw new Error(`Missing test credential DEMO_${persona}_PASSWORD`);
    const result = await widget("login", current.token, { email: emails[persona], password });
    if (result.ok) sessions.set(conversationId, { ...current, ...result, conversationId });
    return result;
  };
  const stop = async () => {
    running = false;
    await Promise.race([Promise.all([worker, housekeeping]), new Promise((r) => setTimeout(r, 1000))]);
    server.close();
    await close();
    await mockDb.close();
  };
  /** Simulate Vista's order clean-up: push the hold expiry into the past so the next read expires the order. */
  const expireOrder = async (userSessionId: string) => {
    await mockDb.db
      .update(S.orders)
      .set({ expiryAt: new Date(Date.now() - 1000) })
      .where(eq(S.orders.userSessionId, userSessionId));
  };
  return { api, ctx, db, tool, widget, session, login, stop, catalog, expireOrder };
}
