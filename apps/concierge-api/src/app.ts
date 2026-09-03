/**
 * Concierge API — the HTTP surface of the middleware.
 *  /tools/:name           ElevenLabs server tools (secret header), returns {ok,data,speech,ui,action}
 *  /widget/*              widget session token, commands, SSE events
 *  /webhooks/*            ElevenLabs post-call, Genesys outbound
 *  /reporting/*           dashboard data
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type AppContext,
  Catalog,
  GenesysHandover,
  type ToolCtx,
  type ToolResult,
  appendEvent,
  ensureConversation,
  eventsSince,
  ledger,
  runTool,
  updateConversation,
} from "@voxi/concierge-core";
import {
  CLIENT_TOOLS,
  ConversationContext,
  TOOL_NAMES,
  TOOL_REGISTRY,
  type ToolName,
  WidgetCommand,
} from "@voxi/contracts";
import { schema as S, nowLocalIso, prefixedId } from "@voxi/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { SignJWT, jwtVerify } from "jose";
import { buildOpenApi } from "./openapi.js";
import { reportingRoutes } from "./reporting.js";
import { ingestPostCall, verifyElevenLabsSignature } from "./webhooks.js";

export type ApiOptions = { writeWaitMs?: number; logging?: boolean };

export function createApp(app: AppContext, opts: ApiOptions = {}) {
  const api = new Hono();
  const catalog = new Catalog(app.vista);
  const writeWaitMs = opts.writeWaitMs ?? 4000;
  if (opts.logging) api.use("*", logger());
  api.use(
    "*",
    cors({
      origin: (o) => o ?? "*",
      allowHeaders: ["authorization", "content-type", "x-voxi-key", "x-voxi-signature", "x-voxi-timestamp"],
      exposeHeaders: ["x-correlation-id"],
    }),
  );
  api.get("/healthz", (c) => c.json({ ok: true, service: "concierge-api" }));
  api.get("/readyz", async (c) => {
    await app.db.execute(sql`select 1`);
    return c.json({ ok: true });
  });
  api.get("/openapi.json", (c) => c.json(buildOpenApi(app.cfg.publicUrl)));
  api.get("/tools", (c) =>
    c.json({
      tools: TOOL_NAMES.map((n) => ({
        name: n,
        kind: TOOL_REGISTRY[n].kind,
        description: TOOL_REGISTRY[n].description,
      })),
      clientTools: Object.entries(CLIENT_TOOLS).map(([name, v]) => ({ name, description: v.description })),
    }),
  );

  // ---------- tool auth: static secret header (ElevenLabs "secret" header) and/or HMAC ----------
  const toolAuth = async (c: Context, next: () => Promise<void>) => {
    const key = c.req.header("x-voxi-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const sig = c.req.header("x-voxi-signature");
    if (
      key &&
      key.length === app.cfg.toolHmacSecret.length &&
      timingSafeEqual(Buffer.from(key), Buffer.from(app.cfg.toolHmacSecret))
    )
      return next();
    if (sig) {
      const ts = c.req.header("x-voxi-timestamp") ?? "";
      const raw = await c.req.raw.clone().text();
      const expected = createHmac("sha256", app.cfg.toolHmacSecret).update(`${ts}.${raw}`).digest("hex");
      if (
        Math.abs(Date.now() - Number(ts)) < 5 * 60_000 &&
        expected.length === sig.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
      )
        return next();
    }
    return c.json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid tool credentials" } }, 401);
  };

  // ---------- tools ----------
  api.post("/tools/:name", toolAuth, async (c) => {
    const name = c.req.param("name") as ToolName;
    if (!TOOL_NAMES.includes(name))
      return c.json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown tool ${name}` } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const correlationId = c.req.header("x-correlation-id") ?? prefixedId("corr", 8);
    c.header("x-correlation-id", correlationId);
    // ElevenLabs sends tool params flat; we accept both {conversationId,..., input:{...}} and flat params.
    const ctxParsed = ConversationContext.safeParse({
      ...body,
      conversationId: body.conversationId ?? body.system__conversation_id ?? body.conversation_id,
    });
    if (!ctxParsed.success)
      return c.json({ ok: false, error: { code: "VALIDATION", message: "conversationId is required" } }, 400);
    const { conversationId, language, channel, modality, customerId, memberId, lat, lng } = ctxParsed.data;
    const input =
      (body.input as Record<string, unknown> | undefined) ??
      Object.fromEntries(
        Object.entries(body).filter(
          ([k]) =>
            ![
              "conversationId",
              "system__conversation_id",
              "conversation_id",
              "channel",
              "modality",
              "toolCallId",
            ].includes(k) && !k.startsWith("system__"),
        ),
      );
    const conversation = await ensureConversation(app.db, {
      conversationId,
      language,
      channel,
      modality,
      customerId,
      memberId,
      lat,
      lng,
    });
    const lang = (input.language as "en" | "ar" | undefined) ?? (conversation.language as "en" | "ar");
    const toolCtx: ToolCtx = {
      ...app,
      catalog,
      conversation,
      lang,
      nowLocal: nowLocalIso(app.cfg.timeZone),
      toolCallId: String(body.toolCallId ?? prefixedId("tc", 8)),
      correlationId,
    };
    const started = Date.now();
    await appendEvent(
      app.db,
      null,
      conversationId,
      "tool.called",
      { tool: name, input: redact(input), correlationId },
      "agent",
    );
    let result: ToolResult = await runTool(name, toolCtx, input).catch((e): ToolResult => {
      app.log.error({ err: e, tool: name, conversationId }, "tool crashed");
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Something went wrong on my side. Let me try again.",
          retryable: true,
        },
      };
    });
    // write tools: wait briefly for the worker so the agent usually gets the outcome in one call
    const actionRef = (result.data as { action?: { actionId: string; status: string } } | undefined)?.action;
    if (result.ok && actionRef && TOOL_REGISTRY[name].kind === "write" && writeWaitMs > 0) {
      const row = await ledger.waitFor(app.db, actionRef.actionId, writeWaitMs);
      if (row && row.status !== "queued" && row.status !== "running") {
        const ref = ledger.toRef(row);
        const speech = (row.result?.speech as string | undefined) ?? row.error?.message ?? result.speech;
        const ui =
          (row.status === "succeeded" ? (row.result?.ui as ToolResult["ui"] | undefined) : undefined) ??
          result.ui;
        result = {
          ...result,
          ok: row.status === "succeeded",
          data: { ...result.data, action: ref, result: row.result, error: row.error },
          speech,
          ui,
          error: row.status === "succeeded" ? undefined : (row.error ?? undefined),
        };
      } else if (row)
        result.speech =
          `${result.speech ?? ""} ${lang === "ar" ? "ما زال قيد التنفيذ — سأخبرك بالنتيجة خلال لحظات." : "It's still processing — I'll confirm the result in a moment."}`.trim();
    }
    if (result.ui)
      await appendEvent(
        app.db,
        app.events,
        conversationId,
        "ui.render",
        { ui: result.ui, tool: name },
        "agent",
      );
    if (result.journey)
      await appendEvent(app.db, null, conversationId, "journey", { ...result.journey, tool: name }, "system");
    await appendEvent(
      app.db,
      null,
      conversationId,
      "tool.completed",
      { tool: name, ok: result.ok, code: result.error?.code, ms: Date.now() - started, correlationId },
      "system",
    );
    app.log.info(
      {
        tool: name,
        conversationId,
        ok: result.ok,
        code: result.error?.code,
        ms: Date.now() - started,
        correlationId,
      },
      "tool",
    );
    // Response shape for the LLM: keep it compact — speech first, then data
    return c.json(
      {
        ok: result.ok,
        speech: result.speech,
        error: result.error,
        data: result.data,
        ui: result.ui
          ? { type: result.ui.type, title: result.ui.title, count: result.ui.items?.length ?? 0 }
          : undefined,
      },
      result.ok ? 200 : 200,
    );
  });

  // ---------- widget ----------
  const widgetToken = async (payload: {
    conversationId: string;
    customerId?: string;
    memberId?: string;
    language?: string;
  }) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("6h")
      .sign(new TextEncoder().encode(app.cfg.widgetJwtSecret));
  const verifyWidget = async (c: Context): Promise<{ conversationId: string } | null> => {
    const tok = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
    if (!tok) return null;
    try {
      const { payload } = await jwtVerify(tok, new TextEncoder().encode(app.cfg.widgetJwtSecret));
      return payload as { conversationId: string };
    } catch {
      return null;
    }
  };

  api.post("/widget/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      conversationId?: string;
      language?: "en" | "ar";
      channel?: string;
      modality?: "voice" | "text" | "mixed";
      customerId?: string;
      memberId?: string;
      lat?: number;
      lng?: number;
    };
    const conversationId = body.conversationId ?? prefixedId("conv", 12);
    const conversation = await ensureConversation(app.db, {
      conversationId,
      language: body.language ?? "en",
      channel: body.channel ?? "web",
      modality: body.modality ?? "text",
      customerId: body.customerId,
      memberId: body.memberId,
      lat: body.lat,
      lng: body.lng,
    });
    const token = await widgetToken({
      conversationId,
      customerId: conversation.customerId ?? undefined,
      memberId: conversation.memberId ?? undefined,
      language: conversation.language,
    });
    return c.json({
      conversationId,
      token,
      language: conversation.language,
      mode: conversation.mode,
      isLoggedIn: conversation.isLoggedIn,
      agentId: app.cfg.elevenLabsAgentId,
      dynamicVariables: {
        conversationId,
        language: conversation.language,
        customerId: conversation.customerId ?? "",
        memberId: conversation.memberId ?? "",
        channel: conversation.channel,
      },
    });
  });

  /** Called by the widget when ElevenLabs assigns its own conversation id (so tools & events share one key). */
  api.post("/widget/link", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const { elevenLabsConversationId } = (await c.req.json()) as { elevenLabsConversationId: string };
    if (!elevenLabsConversationId || elevenLabsConversationId === w.conversationId)
      return c.json({ ok: true });
    // Move state to the ElevenLabs id: create the target conversation and re-point events/actions
    const src = (
      await app.db.select().from(S.conversations).where(eq(S.conversations.id, w.conversationId))
    )[0];
    await ensureConversation(app.db, {
      conversationId: elevenLabsConversationId,
      language: (src?.language as "en" | "ar") ?? "en",
      channel: src?.channel ?? "web",
      modality: src?.modality as "voice" | "text" | "mixed",
      customerId: src?.customerId ?? undefined,
      memberId: src?.memberId ?? undefined,
      lat: src?.geo?.lat,
      lng: src?.geo?.lng,
    });
    await app.db
      .update(S.conversations)
      .set({
        metadata: { ...(src?.metadata ?? {}), widgetConversationId: w.conversationId },
        geo: src?.geo ?? null,
        customerId: src?.customerId ?? null,
        memberId: src?.memberId ?? null,
        isLoggedIn: src?.isLoggedIn ?? false,
      })
      .where(eq(S.conversations.id, elevenLabsConversationId));
    const token = await widgetToken({
      conversationId: elevenLabsConversationId,
      customerId: src?.customerId ?? undefined,
      memberId: src?.memberId ?? undefined,
      language: src?.language,
    });
    return c.json({ ok: true, conversationId: elevenLabsConversationId, token });
  });

  api.get("/widget/events", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let last = after;
      const backlog = await eventsSince(app.db, w.conversationId, after);
      for (const e of backlog) {
        const ev = (await import("@voxi/concierge-core")).toWidgetEvent(e.type, e.seq, e.payload);
        if (ev) {
          await stream.writeSSE({ id: String(e.seq), event: ev.type, data: JSON.stringify(ev) });
          last = e.seq;
        }
      }
      let open = true;
      const unsub = app.events.subscribe(w.conversationId, (ev) => {
        if (!open || ev.seq <= last) return;
        last = ev.seq;
        void stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev) });
      });
      stream.onAbort(() => {
        open = false;
        unsub();
      });
      while (open) {
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ type: "heartbeat", seq: last, at: new Date().toISOString() }),
        });
        await stream.sleep(15000);
      }
    });
  });

  api.get("/widget/state", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const conv = (
      await app.db.select().from(S.conversations).where(eq(S.conversations.id, w.conversationId))
    )[0];
    const transfer = (
      await app.db
        .select()
        .from(S.transfers)
        .where(eq(S.transfers.conversationId, w.conversationId))
        .orderBy(desc(S.transfers.createdAt))
        .limit(1)
    )[0];
    return c.json({ conversation: conv, transfer });
  });

  api.post("/widget/command", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const parsed = WidgetCommand.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid command", issues: parsed.error.issues }, 400);
    const cmd = parsed.data;
    const conv = await ensureConversation(app.db, {
      conversationId: w.conversationId,
      language: "en",
      channel: "web",
      modality: "text",
    });
    switch (cmd.type) {
      case "location": {
        await updateConversation(app.db, conv.id, {
          geo: { lat: cmd.lat, lng: cmd.lng, accuracyM: cmd.accuracyM },
        });
        return c.json({ ok: true });
      }
      case "seat.select": {
        const { action } = await ledger.enqueue(app.db, app.events, {
          conversationId: conv.id,
          type: "select_seats",
          resourceKey: `order:${cmd.userSessionId}`,
          idempotencyKey: ledger.idem(
            conv.id,
            `widget:seats:${cmd.userSessionId}:${cmd.seats.map((s) => `${s.row}${s.number}`).join(",")}`,
          ),
          payload: { userSessionId: cmd.userSessionId, seats: cmd.seats, autoAllocate: false },
          requestedBy: "widget",
        });
        const row = await ledger.waitFor(app.db, action.id, writeWaitMs);
        return c.json({
          ok: row?.status === "succeeded",
          action: row ? ledger.toRef(row) : ledger.toRef(action),
        });
      }
      case "payment.token": {
        const { consumeConfirmation } = await import("@voxi/concierge-core");
        try {
          const conf = await consumeConfirmation(app.db, {
            id: cmd.confirmationId,
            conversationId: conv.id,
            actionType: "pay_order",
            resourceKey: `order:${cmd.userSessionId}`,
          });
          const { action } = await ledger.enqueue(app.db, app.events, {
            conversationId: conv.id,
            type: "pay_order",
            resourceKey: `order:${cmd.userSessionId}`,
            idempotencyKey: ledger.idem(conv.id, `pay:${cmd.confirmationId}`),
            payload: { ...conf.summary, paymentToken: cmd.token, confirmationId: conf.id },
            requestedBy: "widget",
          });
          const row = await ledger.waitFor(app.db, action.id, writeWaitMs + 2000);
          return c.json({
            ok: row?.status === "succeeded",
            action: row ? ledger.toRef(row) : ledger.toRef(action),
          });
        } catch (e) {
          // already consumed by the agent path → return that action
          const existing = await ledger.findByKey(app.db, ledger.idem(conv.id, `pay:${cmd.confirmationId}`));
          if (existing)
            return c.json({ ok: existing.status === "succeeded", action: ledger.toRef(existing) });
          return c.json({ ok: false, error: (e as Error).message }, 409);
        }
      }
      case "human.message": {
        const tr = (await app.db.select().from(S.transfers).where(eq(S.transfers.id, cmd.transferId)))[0];
        if (!tr || tr.conversationId !== conv.id || !tr.externalConversationId)
          return c.json({ error: "no active transfer" }, 409);
        await appendEvent(
          app.db,
          null,
          conv.id,
          "message.user",
          { text: cmd.text, transferId: cmd.transferId },
          "user",
        );
        await app.handover.sendCustomerMessage(tr.externalConversationId, cmd.text, {
          transferId: tr.id,
          conversationId: conv.id,
        });
        return c.json({ ok: true });
      }
      case "feedback": {
        const { action } = await ledger.enqueue(app.db, app.events, {
          conversationId: conv.id,
          type: "submit_feedback",
          resourceKey: `conversation:${conv.id}`,
          idempotencyKey: ledger.idem(conv.id, `widget:feedback:${cmd.rating}`),
          payload: {
            rating: cmd.rating,
            comment: cmd.comment ?? "",
            language: conv.language,
            customerId: conv.customerId,
          },
          requestedBy: "widget",
        });
        return c.json({ ok: true, action: ledger.toRef(action) });
      }
      case "card.action": {
        await appendEvent(app.db, null, conv.id, "ui.action", { value: cmd.value }, "user");
        return c.json({ ok: true });
      }
    }
  });

  // ---------- webhooks ----------
  api.post("/webhooks/elevenlabs", async (c) => {
    const raw = await c.req.text();
    if (
      app.cfg.elevenLabsWebhookSecret &&
      !verifyElevenLabsSignature(raw, c.req.header("elevenlabs-signature"), app.cfg.elevenLabsWebhookSecret)
    )
      return c.json({ error: "bad signature" }, 401);
    const body = JSON.parse(raw);
    const out = await ingestPostCall(app, body);
    return c.json(out);
  });

  api.post("/webhooks/genesys", async (c) => {
    const raw = await c.req.text();
    if (
      app.handover instanceof GenesysHandover &&
      !app.handover.verifySignature(raw, c.req.header("x-hub-signature-256"))
    )
      return c.json({ error: "bad signature" }, 401);
    const body = JSON.parse(raw) as {
      type?: string;
      text?: string;
      channel?: {
        from?: { nickname?: string; id?: string };
        to?: { id?: string };
        messageId?: string;
        time?: string;
      };
      direction?: string;
      events?: { eventType: string }[];
    };
    const extId = body.channel?.to?.id ?? body.channel?.from?.id;
    // Outbound messages from the agent desk carry the customer id we set (= conversationId)
    const tr = extId
      ? (
          await app.db
            .select()
            .from(S.transfers)
            .where(eq(S.transfers.conversationId, extId))
            .orderBy(desc(S.transfers.createdAt))
            .limit(1)
        )[0]
      : undefined;
    if (!tr) return c.json({ ok: true, ignored: true });
    if (body.type === "Text" && body.text) {
      const agentName = body.channel?.from?.nickname ?? tr.agentName ?? "Agent";
      if (tr.status !== "connected")
        await app.db
          .update(S.transfers)
          .set({ status: "connected", connectedAt: new Date(), agentName })
          .where(eq(S.transfers.id, tr.id));
      await appendEvent(
        app.db,
        app.events,
        tr.conversationId,
        "human.message",
        { transferId: tr.id, text: body.text, agentName },
        "human_agent",
      );
      if (tr.status !== "connected")
        await appendEvent(
          app.db,
          app.events,
          tr.conversationId,
          "transfer.status",
          { transferId: tr.id, status: "connected", agentName },
          "system",
        );
    }
    if (body.events?.some((e) => e.eventType === "Disconnect")) {
      await app.db
        .update(S.transfers)
        .set({ status: "ended", endedAt: new Date() })
        .where(eq(S.transfers.id, tr.id));
      await appendEvent(
        app.db,
        app.events,
        tr.conversationId,
        "transfer.status",
        { transferId: tr.id, status: "ended" },
        "system",
      );
    }
    return c.json({ ok: true });
  });

  // ---------- reporting ----------
  api.route("/reporting", reportingRoutes(app));

  // ---------- demo helpers (protected by tool secret) ----------
  api.post("/demo/mark-collected", toolAuth, async (c) => {
    const { bookingId } = (await c.req.json()) as { bookingId: string };
    return c.json(await app.vista.markCollected(bookingId));
  });
  api.get("/demo/conversations/:id", toolAuth, async (c) => {
    const id = c.req.param("id");
    const conv = (await app.db.select().from(S.conversations).where(eq(S.conversations.id, id)))[0];
    const events = await app.db
      .select()
      .from(S.conversationEvents)
      .where(eq(S.conversationEvents.conversationId, id))
      .orderBy(S.conversationEvents.seq);
    const actions = await app.db
      .select()
      .from(S.actions)
      .where(eq(S.actions.conversationId, id))
      .orderBy(S.actions.createdAt);
    return c.json({ conversation: conv, events, actions });
  });
  void gte;
  void and;
  return api;
}

function redact(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input))
    out[k] = /email|phone|pin|token|card/i.test(k) && typeof v === "string" ? `${v.slice(0, 2)}…` : v;
  return out;
}
