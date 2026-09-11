/**
 * Concierge API — the HTTP surface of the middleware.
 *  /tools/:name           ElevenLabs server tools (secret header), returns {ok,data,speech,ui,action}
 *  /widget/*              widget session token, commands, SSE events
 *  /webhooks/*            ElevenLabs post-call, Genesys outbound
 *  /reporting/*           dashboard data
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
  relinkConversationWork,
  resolveLinkedConversation,
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
import { VistaClientError } from "@voxi/vista-client";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { SignJWT, jwtVerify } from "jose";
import { buildOpenApi } from "./openapi.js";
import { reportingRoutes } from "./reporting.js";
import { ingestPostCall, verifyElevenLabsSignature } from "./webhooks.js";

export type ApiOptions = { writeWaitMs?: number; logging?: boolean };

/** First message per language: personal for a signed-in member (no balances — those belong at payment), generic otherwise. */
export function greetings(firstName?: string | null) {
  const name = (firstName ?? "").trim();
  return {
    greetingEn: name
      ? `Hi ${name}, what are you in the mood to watch?`
      : "Hi, welcome to VOX Cinemas. What are you in the mood to watch?",
    greetingAr: name
      ? `أهلاً ${name}، ما نوع الأفلام التي تود مشاهدتها اليوم؟`
      : "أهلاً بك في فوكس سينما. ما نوع الأفلام التي تود مشاهدتها اليوم؟",
    firstName: name,
  };
}

export function createApp(app: AppContext, opts: ApiOptions = {}) {
  const api = new Hono();
  const catalog = new Catalog(app.vista);
  const writeWaitMs = opts.writeWaitMs ?? 4000;
  const ownsOrder = async (conversation: typeof S.conversations.$inferSelect, userSessionId: string) => {
    const metadata = conversation.metadata ?? {};
    if (metadata.activeOrder === userSessionId || metadata.fnbOrder === userSessionId) return true;
    // Completion clears the active basket. Its own payment result remains readable/retryable
    // in this authentication generation, including a guest whose order has no customer ID.
    const [completed] = await app.db
      .select({ input: S.actions.input })
      .from(S.actions)
      .where(
        and(
          eq(S.actions.conversationId, conversation.id),
          eq(S.actions.resourceKey, `order:${userSessionId}`),
          eq(S.actions.type, "pay_order"),
          eq(S.actions.status, "succeeded"),
        ),
      )
      .limit(1);
    if (
      completed &&
      Number(completed.input._widgetAuthGeneration ?? 0) === Number(metadata.widgetAuthGeneration ?? 0)
    )
      return true;
    if (!conversation.isLoggedIn || !conversation.customerId) return false;
    const order = await app.vista.getOrder(userSessionId).catch(() => null);
    return order?.Order?.Customer?.ID === conversation.customerId;
  };
  const actionReply = (row: typeof S.actions.$inferSelect) => ({
    ok: ["succeeded", "queued", "running"].includes(row.status),
    action: ledger.toRef(row),
    speech: typeof row.result?.speech === "string" ? row.result.speech : undefined,
    ui: row.status === "succeeded" ? row.result?.ui : undefined,
    data: row.status === "succeeded" ? row.result : undefined,
    error: row.error?.message,
  });
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
    // Only en/ar count as the *conversation* language; a tool may carry its own `language` param
    // (e.g. search_films language:"Tamil"), which must not break context parsing.
    const isLang = (v: unknown): v is "en" | "ar" => v === "en" || v === "ar";
    const num = (v: unknown) =>
      typeof v === "number"
        ? v
        : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))
          ? Number(v)
          : undefined;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
    const ctxParsed = ConversationContext.safeParse({
      conversationId: body.conversationId ?? body.system__conversation_id ?? body.conversation_id,
      language: isLang(body.language) ? body.language : undefined,
      channel: str(body.channel),
      modality: str(body.modality),
      customerId: str(body.customerId),
      memberId: str(body.memberId),
      lat: num(body.lat),
      lng: num(body.lng),
    });
    if (!ctxParsed.success)
      return c.json(
        {
          ok: false,
          error: {
            code: "VALIDATION",
            message: ctxParsed.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
          },
        },
        400,
      );
    const { conversationId, language, channel, modality, lat, lng } = ctxParsed.data;
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
      // Schema defaults apply only when creating a conversation. Omitted tool
      // context must not replace the widget's saved language or voice modality.
      language: isLang(body.language) ? language : undefined,
      channel: str(body.channel) ? channel : undefined,
      modality: str(body.modality) ? modality : undefined,
      lat,
      lng,
    });
    // Identity belongs to the authenticated widget session, never model-supplied IDs.
    if ("customerId" in input) input.customerId = conversation.customerId ?? undefined;
    if ("memberId" in input) input.memberId = conversation.memberId ?? undefined;
    input.password = undefined;
    input.pin = undefined;
    if (
      typeof input.userSessionId === "string" &&
      input.userSessionId &&
      !(await ownsOrder(conversation, input.userSessionId))
    )
      return c.json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "That order isn't available in this session." },
      });
    const lang = isLang(input.language) ? input.language : (conversation.language as "en" | "ar");
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
    if (
      name === "login_customer" &&
      result.error?.code === "LOGIN_REQUIRED" &&
      result.data?.action === "open_sign_in"
    )
      await appendEvent(
        app.db,
        app.events,
        conversationId,
        "ui.render",
        { ui: { type: "login", items: [] }, tool: name },
        "agent",
        Number(conversation.metadata?.widgetAuthGeneration ?? 0),
      );
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
        Number(conversation.metadata?.widgetAuthGeneration ?? 0),
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
  const widgetToken = async (
    payload: {
      conversationId: string;
      customerId?: string;
      memberId?: string;
      language?: string;
    },
    authenticatedKey?: string,
  ) => {
    const [row] = await app.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, payload.conversationId));
    if (!row) throw new Error("Session not found");
    let sessionKey = authenticatedKey ?? (row.metadata?.widgetSessionKey as string | undefined);
    if (!sessionKey) {
      const generated = randomUUID();
      const [updated] = await app.db
        .update(S.conversations)
        .set({
          metadata: sql`coalesce(${S.conversations.metadata}, '{}'::jsonb) || jsonb_build_object('widgetSessionKey', coalesce(${S.conversations.metadata}->>'widgetSessionKey', ${generated}))`,
        })
        .where(eq(S.conversations.id, row.id))
        .returning();
      sessionKey = updated!.metadata!.widgetSessionKey as string;
    }
    return new SignJWT({ ...payload, sessionKey })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("6h")
      .sign(new TextEncoder().encode(app.cfg.widgetJwtSecret));
  };
  const verifyWidget = async (c: Context): Promise<{ conversationId: string; sessionKey: string } | null> => {
    const tok = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
    if (!tok) return null;
    try {
      const { payload } = await jwtVerify(tok, new TextEncoder().encode(app.cfg.widgetJwtSecret));
      if (typeof payload.conversationId !== "string" || typeof payload.sessionKey !== "string") return null;
      const [row] = await app.db
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, payload.conversationId));
      if (!row || row.metadata?.widgetSessionKey !== payload.sessionKey) return null;
      return { conversationId: payload.conversationId, sessionKey: payload.sessionKey };
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
    if (body.customerId || body.memberId)
      return c.json({ ok: false, error: "Sign in to attach an account." }, 400);
    let authenticatedKey: string | undefined;
    if (body.conversationId) {
      const existing = await verifyWidget(c);
      if (!existing || existing.conversationId !== body.conversationId)
        return c.json({ ok: false, error: "This conversation cannot be resumed. Start a new one." }, 401);
      authenticatedKey = existing.sessionKey;
    }
    const conversationId = body.conversationId ?? prefixedId("conv", 12);
    const conversation = await ensureConversation(app.db, {
      conversationId,
      language: body.language,
      channel: body.channel,
      modality: body.modality,
      lat: body.lat,
      lng: body.lng,
    });
    const token = await widgetToken(
      {
        conversationId,
        customerId: conversation.customerId ?? undefined,
        memberId: conversation.memberId ?? undefined,
        language: conversation.language,
      },
      authenticatedKey,
    );
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
        ...greetings(
          conversation.customerId
            ? ((await app.vista.customer(conversation.customerId).catch(() => null))?.firstName as
                | string
                | undefined)
            : undefined,
        ),
      },
    });
  });

  /** Credentials are handled only by this authenticated form endpoint, never by the conversational agent. */
  api.post("/widget/login", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !body.password || body.password.length > 256)
      return c.json({ ok: false, error: "Enter your email and password." }, 400);
    try {
      const r = await app.vista.validateMember({ Email: email, Password: String(body.password) });
      // Legacy mock versions accept an email without checking Password. During a
      // rolling deployment, never treat that response as password authentication.
      if (
        r.Authentication?.Method !== "password" ||
        r.Authentication.Verified !== true ||
        r.Authentication.Version !== 1
      )
        return c.json({ ok: false, error: "Sign-in is unavailable right now. Please try again." }, 503);
      const m = r.Member;
      const cust = await app.vista.customer(m.CustomerId);
      const conv = await app.db.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(S.conversations)
          .where(eq(S.conversations.id, w.conversationId))
          .for("update");
        if (!previous || previous.metadata?.widgetSessionKey !== w.sessionKey) return null;
        const metadata: Record<string, unknown> = {
          ...(previous.metadata ?? {}),
          widgetSessionKey: randomUUID(),
        };
        const accountChanged = !!previous.customerId && previous.customerId !== m.CustomerId;
        if (accountChanged) {
          clearBookingMetadata(metadata);
          metadata.widgetAuthGeneration = Number(previous.metadata?.widgetAuthGeneration ?? 0) + 1;
          const [last] = await tx
            .select({ seq: sql<number>`coalesce(max(${S.conversationEvents.seq}), 0)` })
            .from(S.conversationEvents)
            .where(eq(S.conversationEvents.conversationId, w.conversationId));
          metadata.widgetEventAfterSeq = Number(last?.seq ?? 0);
          await tx
            .update(S.transfers)
            .set({ status: "ended", endedAt: new Date() })
            .where(
              and(
                eq(S.transfers.conversationId, w.conversationId),
                inArray(S.transfers.status, ["requested", "queued", "connected"]),
              ),
            );
        }
        const [updated] = await tx
          .update(S.conversations)
          .set({
            customerId: m.CustomerId,
            memberId: m.MemberId,
            isLoggedIn: true,
            metadata,
            ...(accountChanged ? { mode: "bot", status: "active", outcome: null } : {}),
          })
          .where(eq(S.conversations.id, w.conversationId))
          .returning();
        return updated!;
      });
      if (!conv)
        return c.json({ ok: false, error: "Your session changed. Please try signing in again." }, 401);
      const token = await widgetToken(
        {
          conversationId: w.conversationId,
          customerId: m.CustomerId,
          memberId: m.MemberId ?? undefined,
          language: conv?.language,
        },
        conv.metadata!.widgetSessionKey as string,
      );
      return c.json({
        ok: true,
        token,
        customer: {
          id: cust.id,
          firstName: cust.firstName,
          lastName: cust.lastName,
          email: cust.email,
          memberId: cust.memberId,
          tier: cust.tier,
          sharePoints: cust.sharePoints,
          voxCreditCents: cust.voxRewardsCents,
          profile: cust.profile,
          savedCards: publicSavedCards(cust.savedCards),
        },
        dynamicVariables: {
          conversationId: w.conversationId,
          language: conv?.language ?? "en",
          customerId: m.CustomerId,
          memberId: m.MemberId ?? "",
          channel: conv?.channel ?? "web",
          ...greetings(cust.firstName),
        },
      });
    } catch (e) {
      const code = e instanceof VistaClientError && e.kind === "result" ? e.extendedResultCode : 0;
      return c.json(
        {
          ok: false,
          error:
            code === 401 || code === 404
              ? "That email and password don't match. Try again."
              : "Sign-in is unavailable right now. Please try again.",
        },
        401,
      );
    }
  });
  api.get("/widget/profile", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const [conv] = await app.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, w.conversationId));
    if (!conv?.isLoggedIn || !conv.customerId) return c.json({ error: "Sign in to view your profile." }, 401);
    const [cust, history] = await Promise.all([
      app.vista.customer(conv.customerId),
      app.vista.customerHistory(conv.customerId),
    ]);
    return c.json({
      customer: {
        id: cust.id,
        firstName: cust.firstName,
        lastName: cust.lastName,
        email: cust.email,
        memberId: cust.memberId,
        tier: cust.tier,
        sharePoints: cust.sharePoints,
        voxCreditCents: cust.voxRewardsCents,
        savedCards: publicSavedCards(cust.savedCards),
      },
      profile: cust.profile,
      history: history.history,
    });
  });
  api.post("/widget/logout", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const conv = await app.db.transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, w.conversationId))
        .for("update");
      if (!previous || previous.metadata?.widgetSessionKey !== w.sessionKey) return null;
      const metadata: Record<string, unknown> = {
        ...(previous.metadata ?? {}),
        widgetSessionKey: randomUUID(),
      };
      clearBookingMetadata(metadata);
      metadata.widgetAuthGeneration = Number(previous.metadata?.widgetAuthGeneration ?? 0) + 1;
      const [last] = await tx
        .select({ seq: sql<number>`coalesce(max(${S.conversationEvents.seq}), 0)` })
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, w.conversationId));
      metadata.widgetEventAfterSeq = Number(last?.seq ?? 0);
      await tx
        .update(S.transfers)
        .set({ status: "ended", endedAt: new Date() })
        .where(
          and(
            eq(S.transfers.conversationId, w.conversationId),
            inArray(S.transfers.status, ["requested", "queued", "connected"]),
          ),
        );
      const [updated] = await tx
        .update(S.conversations)
        .set({
          customerId: null,
          memberId: null,
          isLoggedIn: false,
          metadata,
          mode: "bot",
          status: "active",
          outcome: null,
        })
        .where(eq(S.conversations.id, w.conversationId))
        .returning();
      return updated!;
    });
    if (!conv) return c.json({ ok: false, error: "Your session changed. Please try again." }, 401);
    const token = await widgetToken(
      { conversationId: w.conversationId, language: conv.language },
      conv.metadata!.widgetSessionKey as string,
    );
    return c.json({
      ok: true,
      token,
      dynamicVariables: {
        conversationId: w.conversationId,
        language: conv?.language ?? "en",
        customerId: "",
        memberId: "",
        channel: conv?.channel ?? "web",
        ...greetings(),
      },
    });
  });

  /** Called by the widget when ElevenLabs assigns its own conversation id (so tools & events share one key). */
  api.post("/widget/link", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const { elevenLabsConversationId } = (await c.req.json().catch(() => ({}))) as {
      elevenLabsConversationId?: string;
    };
    if (
      typeof elevenLabsConversationId !== "string" ||
      !/^[A-Za-z0-9_-]{6,64}$/.test(elevenLabsConversationId)
    )
      return c.json({ ok: false, error: "Invalid conversation reference." }, 400);
    if (elevenLabsConversationId === w.conversationId) return c.json({ ok: true });
    const src = await app.db
      .transaction(async (tx) => {
        const [source] = await tx
          .select()
          .from(S.conversations)
          .where(eq(S.conversations.id, w.conversationId))
          .for("update");
        if (!source || source.metadata?.widgetSessionKey !== w.sessionKey) return null;
        await tx
          .insert(S.conversations)
          .values({
            id: elevenLabsConversationId,
            language: source.language,
            channel: source.channel,
            modality: source.modality,
          })
          .onConflictDoNothing();
        const [target] = await tx
          .select()
          .from(S.conversations)
          .where(eq(S.conversations.id, elevenLabsConversationId))
          .for("update");
        const targetKey = target?.metadata?.widgetSessionKey;
        if (
          !target ||
          (targetKey && targetKey !== source.metadata?.widgetSessionKey) ||
          (target.customerId && target.customerId !== source.customerId)
        )
          return null;
        await relinkConversationWork(tx, source.id, elevenLabsConversationId);
        await tx
          .update(S.conversations)
          .set({
            metadata: {
              ...(target.metadata ?? {}),
              ...(source.metadata ?? {}),
              widgetConversationId: w.conversationId,
              widgetEventAfterSeq: Number(target.metadata?.widgetEventAfterSeq ?? 0),
              linkedConversationId: undefined,
            },
            geo: source.geo,
            customerId: source.customerId,
            memberId: source.memberId,
            isLoggedIn: source.isLoggedIn,
            mode: source.mode === "human" ? source.mode : target.mode,
            status:
              source.mode === "human"
                ? source.status
                : target.mode === "human"
                  ? target.status
                  : source.status,
            outcome: source.outcome ?? target.outcome,
            topics: [...new Set([...(target.topics ?? []), ...(source.topics ?? [])])],
            journeys: [...(target.journeys ?? []), ...(source.journeys ?? [])],
          })
          .where(eq(S.conversations.id, elevenLabsConversationId));
        // The prior token must not retain access to a stale authenticated copy after linking.
        await tx
          .update(S.conversations)
          .set({
            metadata: {
              ...(source.metadata ?? {}),
              widgetSessionKey: randomUUID(),
              linkedConversationId: elevenLabsConversationId,
            },
          })
          .where(eq(S.conversations.id, source.id));
        return source;
      })
      .catch((error) => {
        app.log.warn(
          { error: error instanceof Error ? error.message : "Link failed", conversationId: w.conversationId },
          "conversation relink refused",
        );
        return null;
      });
    if (!src) return c.json({ ok: false, error: "That conversation belongs to another session." }, 409);
    const token = await widgetToken(
      {
        conversationId: elevenLabsConversationId,
        customerId: src.customerId ?? undefined,
        memberId: src.memberId ?? undefined,
        language: src.language,
      },
      w.sessionKey,
    );
    return c.json({ ok: true, conversationId: elevenLabsConversationId, token });
  });

  api.get("/widget/events", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const [owner] = await app.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, w.conversationId));
    if (owner?.metadata?.widgetSessionKey !== w.sessionKey) return c.json({ error: "unauthorized" }, 401);
    const requestedAfter = Number(c.req.query("after") ?? 0);
    const after = Math.max(
      Number.isFinite(requestedAfter) ? requestedAfter : 0,
      Number(owner.metadata.widgetEventAfterSeq ?? 0),
    );
    return streamSSE(c, async (stream) => {
      let last = after;
      let open = true;
      let unsub = () => {};
      const close = async () => {
        open = false;
        unsub();
        await stream.close();
      };
      const deliver = async (ev: { seq: number; type: string }) => {
        if (!open || ev.seq <= last) return;
        if (!(await verifyWidget(c))) {
          await close();
          return;
        }
        last = ev.seq;
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev) });
      };
      stream.onAbort(() => {
        open = false;
        unsub();
      });
      const backlog = await eventsSince(app.db, w.conversationId, after);
      for (const e of backlog) {
        const ev = (await import("@voxi/concierge-core")).toWidgetEvent(e.type, e.seq, e.payload, e.id);
        if (ev) await deliver(ev);
      }
      let delivery = Promise.resolve();
      if (!open) return;
      unsub = app.events.subscribe(w.conversationId, (ev) => {
        delivery = delivery.then(() => deliver(ev)).catch(close);
      });
      while (open) {
        if (!(await verifyWidget(c))) {
          await close();
          break;
        }
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
    return c.json({
      conversation: conv
        ? {
            id: conv.id,
            language: conv.language,
            mode: conv.mode,
            isLoggedIn: conv.isLoggedIn,
            customerId: conv.customerId,
            memberId: conv.memberId,
            metadata: safeBookingMetadata(conv.metadata),
          }
        : null,
      transfer: transfer
        ? { id: transfer.id, status: transfer.status, agentName: transfer.agentName }
        : undefined,
    });
  });

  api.post("/widget/command", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const parsed = WidgetCommand.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid command", issues: parsed.error.issues }, 400);
    const cmd = parsed.data;
    const [conv] = await app.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, w.conversationId));
    if (!conv || conv.metadata?.widgetSessionKey !== w.sessionKey)
      return c.json({ ok: false, error: "Session not found." }, 401);
    if ("userSessionId" in cmd && cmd.userSessionId && !(await ownsOrder(conv, cmd.userSessionId)))
      return c.json({ ok: false, error: "That order isn't available in this session." }, 403);
    const widgetTool = async (name: ToolName, input: Record<string, unknown>, refundChoiceProof?: string) => {
      const toolCtx: ToolCtx = {
        ...app,
        catalog,
        conversation: conv,
        lang: conv.language as "en" | "ar",
        nowLocal: nowLocalIso(app.cfg.timeZone),
        toolCallId: prefixedId("tc", 8),
        correlationId: prefixedId("corr", 8),
        refundChoiceProof,
      };
      const result = await runTool(name, toolCtx, input);
      if (result.ui)
        await appendEvent(
          app.db,
          app.events,
          conv.id,
          "ui.render",
          { ui: result.ui, tool: name },
          "user",
          Number(conv.metadata?.widgetAuthGeneration ?? 0),
        );
      if (result.journey)
        await appendEvent(app.db, null, conv.id, "journey", { ...result.journey, tool: name }, "user");
      return {
        ok: result.ok,
        speech: result.speech,
        data: result.data,
        ui: result.ui,
        error: result.ok ? undefined : result.error?.message,
      };
    };
    switch (cmd.type) {
      case "booking.receipt": {
        // The generic search tool can offer a guest identity challenge. A direct receipt
        // must have an already verified owner before emitting any booking or QR event.
        const result = await runTool(
          "find_booking",
          {
            ...app,
            catalog,
            conversation: conv,
            lang: conv.language as "en" | "ar",
            nowLocal: nowLocalIso(app.cfg.timeZone),
            toolCallId: prefixedId("tc", 8),
            correlationId: prefixedId("corr", 8),
          },
          { bookingId: cmd.bookingId, upcomingOnly: false },
        );
        const bookings = result.data?.bookings as
          | { bookingId: string; verified: boolean; status: string; qrPayload?: string }[]
          | undefined;
        const booking = bookings?.find((item) => item.bookingId === cmd.bookingId.toUpperCase());
        let verified = booking?.verified === true;
        if (booking && !verified) {
          const [payment] = await app.db
            .select({ input: S.actions.input })
            .from(S.actions)
            .where(
              and(
                eq(S.actions.conversationId, conv.id),
                eq(S.actions.type, "pay_order"),
                eq(S.actions.status, "succeeded"),
                sql`${S.actions.result}->>'bookingId' = ${booking.bookingId}`,
              ),
            )
            .limit(1);
          verified =
            !!payment &&
            Number(payment.input._widgetAuthGeneration ?? 0) ===
              Number(conv.metadata?.widgetAuthGeneration ?? 0);
        }
        if (!result.ok || !booking || !verified)
          return c.json({ ok: false, error: "That booking isn't verified for this session." }, 403);
        booking.verified = true;
        if (!["confirmed", "collected"].includes(booking.status) || !booking.qrPayload?.trim())
          return c.json({ ok: false, error: "A valid booking QR is not available for this booking." }, 409);
        const ui = {
          type: "qr",
          items: [booking],
          meta: { qrPayload: booking.qrPayload, receiptLookup: true },
        };
        await appendEvent(
          app.db,
          app.events,
          conv.id,
          "ui.render",
          { ui, tool: "booking.receipt" },
          "user",
          Number(conv.metadata?.widgetAuthGeneration ?? 0),
        );
        return c.json({ ok: true, data: { booking }, ui });
      }
      case "proposal.preview":
        return c.json(await widgetTool("propose_booking", cmd.input));
      case "proposal.accept":
        return c.json(
          await widgetTool("quick_book", {
            proposalToken: cmd.proposalToken,
            idempotencyKey: cmd.idempotencyKey,
          }),
        );
      case "refund.choose":
        return c.json(
          await widgetTool(
            "prepare_cancellation",
            {
              bookingId: cmd.bookingId,
              refundMethod: cmd.refundMethod,
              ticketIds: cmd.ticketIds,
            },
            cmd.refundChoiceProof,
          ),
        );
      case "language": {
        await updateConversation(app.db, conv.id, { language: cmd.language });
        await appendEvent(
          app.db,
          app.events,
          conv.id,
          "language.changed",
          { language: cmd.language },
          "user",
        );
        return c.json({ ok: true, data: { language: cmd.language } });
      }
      case "location": {
        await updateConversation(app.db, conv.id, {
          geo: { lat: cmd.lat, lng: cmd.lng, accuracyM: cmd.accuracyM, label: cmd.label, source: cmd.source },
        });
        return c.json({ ok: true });
      }
      case "location.clear": {
        await updateConversation(app.db, conv.id, { geo: null });
        return c.json({ ok: true });
      }
      case "booking.select": {
        return c.json(
          await widgetTool("quick_book", {
            sessionKey: cmd.sessionKey,
            tickets: cmd.tickets,
            idempotencyKey: cmd.idempotencyKey,
          }),
        );
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
        return c.json(actionReply(row ?? action));
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
            payload: {
              ...conf.summary,
              ...(!conv.isLoggedIn && !conf.summary.customerId && cmd.customer?.email
                ? { customer: cmd.customer }
                : {}),
              paymentToken: cmd.token,
              confirmationId: conf.id,
            },
            requestedBy: "widget",
          });
          const row = await ledger.waitFor(app.db, action.id, writeWaitMs + 2000);
          return c.json(actionReply(row ?? action));
        } catch (e) {
          // already consumed → either the agent path ran it, or an earlier attempt failed (declined card,
          // wrong bank card for an offer). A failed attempt may be retried with a different card.
          const existing = await ledger.findByKey(app.db, ledger.idem(conv.id, `pay:${cmd.confirmationId}`));
          if (
            existing &&
            existing.resourceKey === `order:${cmd.userSessionId}` &&
            existing.status === "failed" &&
            cmd.token &&
            existing.input.paymentToken !== cmd.token
          ) {
            const { action } = await ledger.enqueue(app.db, app.events, {
              conversationId: conv.id,
              type: "pay_order",
              resourceKey: `order:${cmd.userSessionId}`,
              idempotencyKey: ledger.idem(conv.id, `pay:${cmd.confirmationId}:${cmd.token}`),
              payload: { ...existing.input, paymentToken: cmd.token },
              requestedBy: "widget",
            });
            const row = await ledger.waitFor(app.db, action.id, writeWaitMs + 2000);
            return c.json(actionReply(row ?? action));
          }
          if (existing && existing.resourceKey === `order:${cmd.userSessionId}`)
            return c.json(actionReply(existing));
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
      case "order.recover":
      case "order.state": {
        return c.json(
          await widgetTool(cmd.type === "order.recover" ? "recover_order" : "resume_order", {
            userSessionId: cmd.userSessionId,
            ...(cmd.type === "order.recover"
              ? { confirmed: cmd.confirmed, idempotencyKey: cmd.idempotencyKey }
              : {}),
          }),
        );
      }
      case "seat.plan": {
        // run the read tool in-process so the widget can draw the map without a round-trip through the agent
        const toolCtx: ToolCtx = {
          ...app,
          catalog,
          conversation: conv,
          lang: conv.language as "en" | "ar",
          nowLocal: nowLocalIso(app.cfg.timeZone),
          toolCallId: prefixedId("tc", 8),
          correlationId: prefixedId("corr", 8),
        };
        const r = await runTool("get_seat_plan", toolCtx, {
          sessionKey: cmd.sessionKey,
          userSessionId: cmd.userSessionId,
        });
        return c.json({ ok: r.ok, ui: r.ok ? r.ui : undefined, error: r.ok ? undefined : r.error?.message });
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
    const liveConversation = extId ? await resolveLinkedConversation(app.db, extId) : null;
    // Outbound messages from the agent desk carry the customer id we set (= conversationId)
    const tr = extId
      ? (
          await app.db
            .select()
            .from(S.transfers)
            .where(
              or(
                eq(S.transfers.externalConversationId, extId),
                eq(S.transfers.conversationId, liveConversation?.id ?? extId),
              ),
            )
            .orderBy(desc(S.transfers.createdAt))
            .limit(1)
        )[0]
      : undefined;
    if (!tr || ["ended", "failed"].includes(tr.status)) return c.json({ ok: true, ignored: true });
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

  /** Signed URL for private agents (requires ELEVENLABS_API_KEY); falls back to the public agent id. */
  api.get("/widget/signed-url", async (c) => {
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const base = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
    // EU/IN data-residency workspaces use a different host; the widget must open its socket there too.
    const wsOrigin = base.replace(/^http/, "ws");
    if (!app.cfg.elevenLabsApiKey || !app.cfg.elevenLabsAgentId)
      return c.json({ agentId: app.cfg.elevenLabsAgentId, wsOrigin });
    const res = await fetch(
      `${base}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(app.cfg.elevenLabsAgentId)}`,
      { headers: { "xi-api-key": app.cfg.elevenLabsApiKey } },
    );
    if (!res.ok)
      return c.json({ agentId: app.cfg.elevenLabsAgentId, wsOrigin, error: `signed url ${res.status}` });
    const j = (await res.json()) as { signed_url: string };
    return c.json({ agentId: app.cfg.elevenLabsAgentId, signedUrl: j.signed_url, wsOrigin });
  });

  /**
   * Dev bridge: lets the widget invoke a tool directly (no ElevenLabs) for UI development and demo rehearsal.
   * Enabled only with DEV_TOOL_BRIDGE=true; authenticated with the widget token.
   */
  api.post("/widget/dev-tool", async (c) => {
    if (process.env.DEV_TOOL_BRIDGE !== "true") return c.json({ error: "disabled" }, 404);
    const w = await verifyWidget(c);
    if (!w) return c.json({ error: "unauthorized" }, 401);
    const { name, input } = (await c.req.json()) as { name: ToolName; input: Record<string, unknown> };
    if (input.userSessionId === "__ACTIVE__") {
      const conv = (
        await app.db.select().from(S.conversations).where(eq(S.conversations.id, w.conversationId))
      )[0];
      input.userSessionId = (conv?.metadata as { activeOrder?: string })?.activeOrder ?? "";
    }
    const res = await api.request(`/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voxi-key": app.cfg.toolHmacSecret },
      body: JSON.stringify({ ...input, conversationId: w.conversationId }),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  });

  /** Public: now-showing films for the demo backdrop. */
  api.get("/demo/films", async (c) => {
    const films = (await catalog.films())
      .filter((f) => (c.req.query("status") === "all" || f.status === "now_showing") && f.posterUrl)
      .map((f) => ({
        hoCode: f.hoCode,
        title: f.title,
        titleAlt: f.titleAlt,
        language: f.language,
        status: f.status,
        posterUrl: f.posterUrl,
        rating: f.rating,
        runTime: f.runTime,
      }));
    return c.json({ films });
  });
  api.get("/demo/cinemas", async (c) => {
    return c.json({
      cinemas: (await catalog.cinemas()).map(({ id, name, nameAlt, city, experiences }) => ({
        cinemaId: id,
        name,
        nameAlt,
        city,
        experiences,
      })),
    });
  });

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
  // Also answer under /api/* so an embed configured with "<api host>/api" (the demo site's proxy shape) works too.
  const root = new Hono();
  root.route("/api", api);
  root.route("/", api);
  return root;
}

export function redact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redact);
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      /password|passwd|pin|token|secret|authorization|cvv|card.?number|^pan$/i.test(key)
        ? "[redacted]"
        : /email|phone|card.?bin|first6/i.test(key) && typeof value === "string"
          ? `${value.slice(0, 2)}…`
          : redact(value),
    ]),
  );
}

function clearBookingMetadata(metadata: Record<string, unknown>) {
  for (const key of [
    "activeOrder",
    "activeOrderId",
    "fnbOrder",
    "fnbForBookingId",
    "activeSessionKey",
    "lastBookingId",
    "bookingDraft",
    "pendingBooking",
    "bookingState",
    "holdRequest",
    "usualFnb",
    "lastCinemaId",
    "verifiedBookings",
    "paymentInvestigation",
  ])
    delete metadata[key];
}

function safeBookingMetadata(metadata: Record<string, unknown> | null) {
  const allowed = [
    "activeOrder",
    "activeSessionKey",
    "lastBookingId",
    "bookingDraft",
    "pendingBooking",
    "bookingState",
    "fnbOrder",
  ];
  return Object.fromEntries(
    allowed.filter((key) => metadata?.[key] !== undefined).map((key) => [key, redact(metadata![key])]),
  );
}

function publicSavedCards(cards: unknown) {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter((card) => card && typeof card === "object")
    .map((card) => ({
      brand: card.brand,
      masked: card.masked ?? (card.last4 ? `•••• ${card.last4}` : undefined),
      last4: card.last4,
      expiry: card.expiry,
      default: !!card.default,
    }));
}
