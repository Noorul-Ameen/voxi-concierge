import type { AppContext } from "@voxi/concierge-core";
import { schema as S } from "@voxi/db";
/**
 * Reporting API for the dashboard (feature 10).
 *
 * `/summary` accepts the dashboard filters (days, language, modality, channel, outcome, demo) and returns
 * KPIs, daily series, hour × weekday heat, journeys, topics, funnel, action latency, transfers, feedback.
 * All aggregation is done in one pass over the filtered conversations (a demo-sized table); at scale the
 * same shape is served from `metrics_daily`.
 */
import { desc, gte, sql } from "drizzle-orm";
import { Hono } from "hono";

const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const localDay = (d: Date) => new Date(d.getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
const localHour = (d: Date) => new Date(d.getTime() + DUBAI_OFFSET_MS).getUTCHours();
const localDow = (d: Date) => new Date(d.getTime() + DUBAI_OFFSET_MS).getUTCDay();

type Filters = {
  days: number;
  since: Date;
  language?: string;
  modality?: string;
  channel?: string;
  outcome?: string;
  demo: "include" | "exclude" | "only";
};

function parseFilters(q: (k: string) => string | undefined): Filters {
  const days = Math.max(1, Math.min(365, Number(q("days") ?? 30)));
  const pick = (k: string) => {
    const v = q(k);
    return v && v !== "all" ? v : undefined;
  };
  const demoRaw = q("demo");
  const demo: Filters["demo"] = demoRaw === "exclude" || demoRaw === "only" ? demoRaw : "include";
  return {
    days,
    since: new Date(Date.now() - days * 86400000),
    language: pick("language"),
    modality: pick("modality"),
    channel: pick("channel"),
    outcome: pick("outcome"),
    demo,
  };
}

const isDemo = (id: string) => id.startsWith("demo_");

export function reportingRoutes(app: AppContext) {
  const r = new Hono();

  async function filteredConversations(f: Filters) {
    const rows = await app.db.select().from(S.conversations).where(gte(S.conversations.startedAt, f.since));
    return rows.filter((x) => {
      if (f.demo === "exclude" && isDemo(x.id)) return false;
      if (f.demo === "only" && !isDemo(x.id)) return false;
      if (f.language && x.language !== f.language) return false;
      if (f.modality && x.modality !== f.modality) return false;
      if (f.channel && x.channel !== f.channel) return false;
      if (f.outcome) {
        const o = x.outcome ?? (x.status === "active" ? "active" : "unknown");
        if (o !== f.outcome) return false;
      }
      return true;
    });
  }

  r.get("/summary", async (c) => {
    const f = parseFilters((k) => c.req.query(k));
    const convs = await filteredConversations(f);
    const ids = new Set(convs.map((x) => x.id));
    const inScope = <T extends { conversationId: string | null }>(rows: T[]) =>
      rows.filter((x) => x.conversationId && ids.has(x.conversationId));

    const [fbAll, actAll, trAll, cmpAll] = await Promise.all([
      app.db.select().from(S.feedback).where(gte(S.feedback.createdAt, f.since)),
      app.db.select().from(S.actions).where(gte(S.actions.createdAt, f.since)),
      app.db.select().from(S.transfers).where(gte(S.transfers.createdAt, f.since)),
      app.db.select().from(S.complaints).where(gte(S.complaints.createdAt, f.since)),
    ]);
    const fb = inScope(fbAll);
    const actions = inScope(actAll);
    const transfers = inScope(trAll);
    const complaints = inScope(cmpAll);

    const total = convs.length;
    const count = <T>(rows: T[], g: (x: T) => string) => {
      const m: Record<string, number> = {};
      for (const x of rows) m[g(x)] = (m[g(x)] ?? 0) + 1;
      return m;
    };
    const outcomeOf = (x: (typeof convs)[number]) =>
      x.outcome ?? (x.status === "active" ? "active" : "unknown");

    // ---- daily series (Dubai days), zero-filled across the window
    const daily: Record<
      string,
      {
        day: string;
        total: number;
        resolved: number;
        transferred: number;
        dropped: number;
        other: number;
        voice: number;
        text: number;
        ar: number;
        en: number;
        durationSum: number;
        durationN: number;
      }
    > = {};
    for (let i = f.days - 1; i >= 0; i--) {
      const day = localDay(new Date(Date.now() - i * 86400000));
      daily[day] = {
        day,
        total: 0,
        resolved: 0,
        transferred: 0,
        dropped: 0,
        other: 0,
        voice: 0,
        text: 0,
        ar: 0,
        en: 0,
        durationSum: 0,
        durationN: 0,
      };
    }
    // ---- hour × weekday heat (7 × 24)
    const heat: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const journeys: Record<string, { completed: number; abandoned: number; failed: number }> = {};
    const topics: Record<string, number> = {};
    for (const cv of convs) {
      const d = daily[localDay(cv.startedAt)];
      if (d) {
        d.total++;
        const o = outcomeOf(cv);
        if (o === "resolved" || o === "transferred" || o === "dropped") d[o]++;
        else d.other++;
        if (cv.modality === "text") d.text++;
        else d.voice++;
        if (cv.language === "ar") d.ar++;
        else d.en++;
        if (cv.durationSeconds) {
          d.durationSum += cv.durationSeconds;
          d.durationN++;
        }
      }
      heat[localDow(cv.startedAt)]![localHour(cv.startedAt)]!++;
      for (const j of cv.journeys ?? []) {
        journeys[j.name] ??= { completed: 0, abandoned: 0, failed: 0 };
        journeys[j.name]![j.status]++;
      }
      for (const tp of cv.topics ?? []) topics[tp] = (topics[tp] ?? 0) + 1;
    }

    // ---- booking funnel from the action ledger (distinct conversations reaching each step)
    const stepConvs = (type: string) =>
      new Set(actions.filter((a) => a.type === type && a.status === "succeeded").map((a) => a.conversationId))
        .size;
    // a conversation "started a booking" if it logged the journey or ran any order step (so later steps never exceed it)
    const orderSteps = new Set([
      "start_order",
      "add_tickets",
      "select_seats",
      "add_concessions",
      "apply_offer",
      "pay_order",
    ]);
    const started = new Set<string>(
      actions.filter((a) => orderSteps.has(a.type) && a.status === "succeeded").map((a) => a.conversationId),
    );
    for (const x of convs) if ((x.journeys ?? []).some((j) => j.name === "guided_booking")) started.add(x.id);
    const bookingStarted = started.size;
    const funnel = [
      { step: "Booking started", n: bookingStarted },
      { step: "Tickets added", n: stepConvs("add_tickets") },
      { step: "Seats chosen", n: stepConvs("select_seats") },
      { step: "Paid", n: stepConvs("pay_order") },
    ];

    // ---- action latency & reliability per type
    const byType: Record<string, { count: number; succeeded: number; failed: number; latencies: number[] }> =
      {};
    for (const a of actions) {
      byType[a.type] ??= { count: 0, succeeded: 0, failed: 0, latencies: [] };
      const t = byType[a.type]!;
      t.count++;
      if (a.status === "succeeded") t.succeeded++;
      if (a.status === "failed") t.failed++;
      if (a.startedAt && a.finishedAt) t.latencies.push(a.finishedAt.getTime() - a.startedAt.getTime());
    }
    const pct = (arr: number[], p: number) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    };
    const actionStats = Object.entries(byType)
      .map(([type, t]) => ({
        type,
        count: t.count,
        succeeded: t.succeeded,
        failed: t.failed,
        successRate: t.count ? Math.round((t.succeeded / t.count) * 100) : 0,
        p50Ms: pct(t.latencies, 0.5),
        p95Ms: pct(t.latencies, 0.95),
      }))
      .sort((a, b) => b.count - a.count);

    const durations = convs.filter((x) => x.durationSeconds).map((x) => x.durationSeconds!);
    const resolved = convs.filter((x) => x.outcome === "resolved").length;
    const transferredN = convs.filter((x) => x.outcome === "transferred" || x.mode === "human").length;
    const droppedN = convs.filter((x) => x.outcome === "dropped").length;

    // ---- previous window for deltas (same filters, shifted back)
    const prevSince = new Date(f.since.getTime() - f.days * 86400000);
    const prevRows = (
      await app.db.select().from(S.conversations).where(gte(S.conversations.startedAt, prevSince))
    ).filter(
      (x) =>
        x.startedAt < f.since &&
        (f.demo !== "exclude" || !isDemo(x.id)) &&
        (f.demo !== "only" || isDemo(x.id)) &&
        (!f.language || x.language === f.language) &&
        (!f.modality || x.modality === f.modality) &&
        (!f.channel || x.channel === f.channel) &&
        (!f.outcome || outcomeOf(x) === f.outcome),
    );
    const prevTotal = prevRows.length;
    const prevResolved = prevRows.filter((x) => x.outcome === "resolved").length;

    const voiceByLanguage: Record<string, { total: number; resolved: number; dropped: number }> = {};
    for (const x of convs.filter((x) => x.modality !== "text")) {
      voiceByLanguage[x.language] ??= { total: 0, resolved: 0, dropped: 0 };
      const m = voiceByLanguage[x.language]!;
      m.total++;
      if (x.outcome === "resolved") m.resolved++;
      if (x.outcome === "dropped") m.dropped++;
    }

    return c.json({
      window: {
        days: f.days,
        since: f.since.toISOString(),
        filters: {
          language: f.language ?? "all",
          modality: f.modality ?? "all",
          channel: f.channel ?? "all",
          outcome: f.outcome ?? "all",
          demo: f.demo,
        },
      },
      conversations: {
        total,
        previousTotal: prevTotal,
        byOutcome: count(convs, outcomeOf),
        byLanguage: count(convs, (x) => x.language),
        byModality: count(convs, (x) => x.modality),
        byChannel: count(convs, (x) => x.channel),
        loggedIn: convs.filter((x) => x.isLoggedIn).length,
        avgDurationSeconds: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0,
        synthetic: convs.filter((x) => isDemo(x.id)).length,
      },
      containment: {
        resolved,
        transferred: transferredN,
        dropped: droppedN,
        rate: total ? Math.round((resolved / total) * 100) : 0,
        previousRate: prevTotal ? Math.round((prevResolved / prevTotal) * 100) : null,
      },
      daily: Object.values(daily).map((d) => ({
        ...d,
        avgDuration: d.durationN ? Math.round(d.durationSum / d.durationN) : 0,
      })),
      heat,
      journeys,
      topics: Object.entries(topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
      funnel,
      actions: actionStats,
      transfers: {
        total: transfers.length,
        reasons: count(transfers, (t) => t.reason),
        byAdapter: count(transfers, (t) => t.adapter),
        avgWaitSeconds: (() => {
          const w = transfers
            .filter((t) => t.connectedAt)
            .map((t) => (t.connectedAt!.getTime() - t.createdAt.getTime()) / 1000);
          return w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : null;
        })(),
      },
      complaints: {
        total: complaints.length,
        byCategory: count(complaints, (x) => x.category),
        byStatus: count(complaints, (x) => x.status),
      },
      feedback: {
        count: fb.length,
        avgRating: fb.length
          ? Math.round((fb.reduce((a, b) => a + b.rating, 0) / fb.length) * 100) / 100
          : null,
        distribution: count(fb, (x) => String(x.rating)),
        csat: fb.length ? Math.round((fb.filter((x) => x.rating >= 4).length / fb.length) * 100) : null,
      },
      voice: { byLanguage: voiceByLanguage },
    });
  });

  r.get("/conversations", async (c) => {
    const f = parseFilters((k) => c.req.query(k));
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    const q = (c.req.query("q") ?? "").toLowerCase();
    const rows = (await filteredConversations(f))
      .filter(
        (x) =>
          !q ||
          x.id.toLowerCase().includes(q) ||
          (x.topics ?? []).some((t) => t.toLowerCase().includes(q)) ||
          (x.journeys ?? []).some((j) => j.name.includes(q)) ||
          (x.customerId ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
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
    const feedback = await app.db.select().from(S.feedback).where(sql`${S.feedback.conversationId} = ${id}`);
    const transfers = await app.db
      .select()
      .from(S.transfers)
      .where(sql`${S.transfers.conversationId} = ${id}`);
    const complaints = await app.db
      .select()
      .from(S.complaints)
      .where(sql`${S.complaints.conversationId} = ${id}`);
    return c.json({ conversation: conv, transcript: tr, events, actions, feedback, transfers, complaints });
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
