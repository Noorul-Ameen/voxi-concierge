import type { AppContext } from "@voxi/concierge-core";
import { schema as S } from "@voxi/db";
/** Reporting API for the dashboard (feature 10). */
import { desc, gte, sql } from "drizzle-orm";
import { Hono } from "hono";

export function reportingRoutes(app: AppContext) {
  const r = new Hono();
  r.get("/summary", async (c) => {
    const days = Number(c.req.query("days") ?? 30);
    const since = new Date(Date.now() - days * 86400000);
    const convs = await app.db.select().from(S.conversations).where(gte(S.conversations.startedAt, since));
    const fb = await app.db.select().from(S.feedback).where(gte(S.feedback.createdAt, since));
    const actions = await app.db
      .select({ type: S.actions.type, status: S.actions.status, n: sql<number>`count(*)` })
      .from(S.actions)
      .where(gte(S.actions.createdAt, since))
      .groupBy(S.actions.type, S.actions.status);
    const total = convs.length;
    const count = <T>(rows: T[], f: (x: T) => string) => {
      const m: Record<string, number> = {};
      for (const x of rows) m[f(x)] = (m[f(x)] ?? 0) + 1;
      return m;
    };
    const by = (f: (x: (typeof convs)[number]) => string) => count(convs, f);
    const journeys: Record<string, { completed: number; abandoned: number; failed: number }> = {};
    for (const cv of convs)
      for (const j of cv.journeys ?? []) {
        journeys[j.name] ??= { completed: 0, abandoned: 0, failed: 0 };
        journeys[j.name]![j.status]++;
      }
    const topics: Record<string, number> = {};
    for (const cv of convs) for (const tp of cv.topics ?? []) topics[tp] = (topics[tp] ?? 0) + 1;
    const transfers = await app.db.select().from(S.transfers).where(gte(S.transfers.createdAt, since));
    const transferReasons = count(transfers, (t) => t.reason);
    const durations = convs.filter((x) => x.durationSeconds).map((x) => x.durationSeconds!);
    return c.json({
      window: { days, since: since.toISOString() },
      conversations: {
        total,
        byOutcome: by((x) => x.outcome ?? "unknown"),
        byLanguage: by((x) => x.language),
        byModality: by((x) => x.modality),
        byChannel: by((x) => x.channel),
        avgDurationSeconds: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0,
      },
      containment: {
        resolved: convs.filter((x) => x.outcome === "resolved").length,
        transferred: convs.filter((x) => x.outcome === "transferred" || x.mode === "human").length,
        dropped: convs.filter((x) => x.outcome === "dropped").length,
        rate: total ? Math.round((convs.filter((x) => x.outcome === "resolved").length / total) * 100) : 0,
      },
      journeys,
      topics: Object.entries(topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
      transfers: {
        total: transfers.length,
        reasons: transferReasons,
        byAdapter: count(transfers, (t) => t.adapter),
      },
      actions: actions.map((a) => ({ type: a.type, status: a.status, count: Number(a.n) })),
      feedback: {
        count: fb.length,
        avgRating: fb.length
          ? Math.round((fb.reduce((a, b) => a + b.rating, 0) / fb.length) * 100) / 100
          : null,
        distribution: count(fb, (x) => String(x.rating)),
      },
      voice: {
        byLanguage: (() => {
          const m: Record<string, { total: number; resolved: number }> = {};
          for (const x of convs.filter((x) => x.modality !== "text")) {
            m[x.language] ??= { total: 0, resolved: 0 };
            m[x.language]!.total++;
            if (x.outcome === "resolved") m[x.language]!.resolved++;
          }
          return m;
        })(),
      },
    });
  });
  r.get("/conversations", async (c) => {
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
    const rows = await app.db
      .select()
      .from(S.conversations)
      .orderBy(desc(S.conversations.startedAt))
      .limit(limit);
    return c.json({ conversations: rows });
  });
  r.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const [conv] = await app.db.select().from(S.conversations).where(sql`${S.conversations.id} = ${id}`);
    const [tr] = await app.db
      .select()
      .from(S.transcripts)
      .where(sql`${S.transcripts.conversationId} = ${id}`);
    const events = await app.db
      .select()
      .from(S.conversationEvents)
      .where(sql`${S.conversationEvents.conversationId} = ${id}`)
      .orderBy(S.conversationEvents.seq);
    const actions = await app.db
      .select()
      .from(S.actions)
      .where(sql`${S.actions.conversationId} = ${id}`)
      .orderBy(S.actions.createdAt);
    return c.json({ conversation: conv, transcript: tr, events, actions });
  });
  r.get("/complaints", async (c) =>
    c.json({
      complaints: await app.db.select().from(S.complaints).orderBy(desc(S.complaints.createdAt)).limit(100),
    }),
  );
  r.get("/feedback", async (c) =>
    c.json({
      feedback: await app.db.select().from(S.feedback).orderBy(desc(S.feedback.createdAt)).limit(100),
    }),
  );
  r.get("/transfers", async (c) =>
    c.json({
      transfers: await app.db.select().from(S.transfers).orderBy(desc(S.transfers.createdAt)).limit(100),
    }),
  );
  r.get("/actions", async (c) =>
    c.json({ actions: await app.db.select().from(S.actions).orderBy(desc(S.actions.createdAt)).limit(200) }),
  );
  return r;
}
