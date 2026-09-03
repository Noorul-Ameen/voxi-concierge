/**
 * Synthetic conversation history for the reporting dashboard (feature 10).
 *
 * Generates ~70 days of realistic, deterministic demo traffic — conversations with journeys, topics,
 * outcomes, durations, actions, feedback, transfers, complaints and short transcripts — so the
 * dashboard tells a story before real traffic accumulates. Every row is tagged
 * `metadata.synthetic = true` (conversation ids start with `demo_`) so the dashboard can show or hide
 * it, and re-running replaces only synthetic rows. Real conversations are never touched.
 *
 *   pnpm db:seed:history               # (re)generate
 *   SEED_HISTORY_DAYS=60 pnpm db:seed:history
 */
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import * as s from "../schema/index.js";
import { prng } from "./util.js";

type Lang = "en" | "ar";
type Journey = { name: string; status: "completed" | "abandoned" | "failed"; at: string };

const rnd = prng("voxi-history-v1");
const DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 70);
const TZ_OFFSET_MS = 4 * 3600 * 1000; // Asia/Dubai

// Intent mix (weights) → journeys, topics, typical actions
const INTENTS: {
  key: string;
  w: number;
  journeys: string[];
  topics: string[];
  actions?: string[];
  dur: [number, number];
  dropP: number;
  transferP: number;
}[] = [
  {
    key: "movie_info",
    w: 30,
    journeys: ["movie_info"],
    topics: ["showtimes", "movies"],
    dur: [60, 240],
    dropP: 0.06,
    transferP: 0.01,
  },
  {
    key: "guided_booking",
    w: 18,
    journeys: ["movie_info", "guided_booking", "payment"],
    topics: ["booking", "seats", "payment"],
    actions: ["start_order", "add_tickets", "select_seats", "pay_order"],
    dur: [240, 600],
    dropP: 0.22,
    transferP: 0.03,
  },
  {
    key: "cancellation",
    w: 12,
    journeys: ["booking_lookup", "cancellation"],
    topics: ["cancellation", "refund"],
    actions: ["cancel_booking"],
    dur: [120, 360],
    dropP: 0.08,
    transferP: 0.12,
  },
  {
    key: "swap",
    w: 5,
    journeys: ["booking_lookup", "swap"],
    topics: ["swap", "showtimes"],
    actions: ["swap_booking"],
    dur: [180, 420],
    dropP: 0.1,
    transferP: 0.08,
  },
  {
    key: "offers",
    w: 8,
    journeys: ["offers_info"],
    topics: ["offers", "bank offers"],
    dur: [45, 180],
    dropP: 0.05,
    transferP: 0.01,
  },
  {
    key: "cinema_info",
    w: 7,
    journeys: ["cinema_info"],
    topics: ["cinema", "parking", "directions"],
    dur: [40, 150],
    dropP: 0.04,
    transferP: 0.01,
  },
  {
    key: "fnb",
    w: 6,
    journeys: ["fnb_info", "fnb_preorder"],
    topics: ["food & drinks"],
    actions: ["add_concessions"],
    dur: [90, 300],
    dropP: 0.1,
    transferP: 0.02,
  },
  {
    key: "age",
    w: 4,
    journeys: ["age_restrictions"],
    topics: ["age rating"],
    dur: [30, 120],
    dropP: 0.03,
    transferP: 0.01,
  },
  {
    key: "complaint",
    w: 4,
    journeys: ["complaint"],
    topics: ["complaint"],
    actions: ["create_complaint"],
    dur: [180, 480],
    dropP: 0.05,
    transferP: 0.35,
  },
  {
    key: "booking_status",
    w: 4,
    journeys: ["booking_lookup"],
    topics: ["booking status"],
    dur: [50, 160],
    dropP: 0.05,
    transferP: 0.03,
  },
  { key: "general", w: 2, journeys: [], topics: ["general"], dur: [30, 120], dropP: 0.1, transferP: 0.05 },
];
const TOTAL_W = INTENTS.reduce((a, b) => a + b.w, 0);
const pickIntent = () => {
  let r = rnd.next() * TOTAL_W;
  for (const i of INTENTS) {
    r -= i.w;
    if (r <= 0) return i;
  }
  return INTENTS[0]!;
};

const CINEMAS = [
  "Mall of the Emirates",
  "City Centre Deira",
  "City Centre Mirdif",
  "Yas Mall",
  "City Centre Sharjah",
  "Nakheel Mall",
  "Al Maryah Island",
];
const FILMS = [
  "Bethlehem Kudumba Unit",
  "DC Superman",
  "Hi!",
  "Immortal",
  "F1",
  "Jurassic World Rebirth",
  "The Fantastic Four",
  "Smurfs",
];
const COMPLAINT_CATS = ["fnb", "facility", "staff", "booking", "refund", "app"] as const;
const TRANSFER_REASONS = ["customer_request", "sentiment", "fallback", "complaint", "policy"] as const;
const AGENTS = ["Fatima", "Ahmed", "Priya", "Mariam", "Joseph"];

const T = {
  en: {
    movie_info: [
      "What's showing tonight at {c}?",
      "Any Tamil movies this weekend?",
      "When is {f} playing at {c}?",
    ],
    guided_booking: [
      "Book two tickets for {f} tonight",
      "I want IMAX seats for {f} at {c}",
      "Two GOLD tickets for {f} tomorrow evening",
    ],
    cancellation: [
      "I need to cancel my booking",
      "Cancel booking {b} and refund to VOX credit",
      "Can I get a refund for tonight's show?",
    ],
    swap: ["Move my booking to the 9 pm show", "Swap {b} to tomorrow", "Change my tickets to a later time"],
    offers: ["Which bank offers are on today?", "Is there a Monday deal?", "Any offers for Share members?"],
    cinema_info: [
      "Where is the cinema inside {c}?",
      "Is parking free at {c}?",
      "Which cinema is nearest to me?",
    ],
    fnb: ["Can I pre-order popcorn?", "What's on the GOLD menu?", "Do you have vegan options?"],
    age: [
      "Can my 10-year-old watch a PG13 film?",
      "What does 15+ mean?",
      "Is KIDS suitable for a 4-year-old?",
    ],
    complaint: [
      "The seats were broken at {c} last night",
      "My popcorn was cold and nobody helped",
      "The app charged me twice",
    ],
    booking_status: [
      "Did my booking go through?",
      "Can you find my booking {b}?",
      "Where is my confirmation email?",
    ],
    general: ["What time do you open?", "How do I contact customer care?", "Do you have wheelchair access?"],
  },
  ar: {
    movie_info: ["ما الذي يُعرض الليلة في {c}؟", "هل هناك أفلام عربية هذا الأسبوع؟", "متى يُعرض {f} في {c}؟"],
    guided_booking: [
      "احجز تذكرتين لفيلم {f} الليلة",
      "أريد مقاعد آيماكس لفيلم {f}",
      "تذكرتان غولد لفيلم {f} غداً",
    ],
    cancellation: [
      "أريد إلغاء حجزي",
      "ألغِ الحجز {b} واسترد المبلغ إلى رصيد فوكس",
      "هل يمكن استرداد تذاكر الليلة؟",
    ],
    swap: ["غيّر حجزي إلى عرض الساعة 9", "بدّل {b} إلى الغد", "أريد وقتاً أبكر"],
    offers: ["ما هي عروض البنوك اليوم؟", "هل يوجد عرض يوم الاثنين؟", "عروض لأعضاء شير؟"],
    cinema_info: ["أين السينما داخل {c}؟", "هل المواقف مجانية في {c}؟", "ما أقرب سينما لي؟"],
    fnb: ["هل يمكنني طلب الفشار مسبقاً؟", "ما هي قائمة غولد؟", "هل لديكم خيارات نباتية؟"],
    age: ["هل يمكن لطفلي ذي العشر سنوات مشاهدة فيلم PG13؟", "ماذا يعني 15+؟"],
    complaint: ["المقاعد كانت معطلة في {c}", "الفشار كان بارداً ولم يساعدني أحد", "التطبيق خصم مني مرتين"],
    booking_status: ["هل تم حجزي؟", "ابحث عن حجزي {b}", "أين رسالة التأكيد؟"],
    general: ["متى تفتحون؟", "كيف أتواصل مع خدمة العملاء؟"],
  },
} as const;

const fill = (t: string) =>
  t
    .replace("{c}", rnd.pick(CINEMAS))
    .replace("{f}", rnd.pick(FILMS))
    .replace("{b}", `${rnd.pick(["VX", "RM", "JW", "OK"])}${rnd.int(100, 999)}${rnd.pick(["K", "Q", "Z"])}`);

/** Traffic shape: evenings and weekends busier; a gentle upward trend. */
function conversationsForDay(dayIndexFromToday: number, date: Date) {
  const dow = date.getUTCDay(); // 0 Sun … 6 Sat (UTC ~ Dubai for day granularity)
  const weekend = dow === 5 || dow === 6 ? 1.45 : dow === 4 ? 1.15 : 1;
  const trend = 1 + (DAYS - dayIndexFromToday) / DAYS / 2; // ~+50 % over the window
  return Math.round(rnd.int(18, 26) * weekend * trend);
}
function hourWeight(h: number) {
  if (h >= 18 && h <= 22) return 3;
  if (h >= 12 && h < 18) return 2;
  if (h >= 9 && h < 12) return 1.2;
  if (h === 23 || h < 2) return 0.8;
  return 0.2;
}
function pickHour() {
  const ws = Array.from({ length: 24 }, (_, h) => hourWeight(h));
  const tot = ws.reduce((a, b) => a + b, 0);
  let r = rnd.next() * tot;
  for (let h = 0; h < 24; h++) {
    r -= ws[h]!;
    if (r <= 0) return h;
  }
  return 20;
}

async function main() {
  const { db, close } = createDb();
  console.log("history: removing previous synthetic rows");
  await db.execute(sql`delete from feedback where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from transfers where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from complaints where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from actions where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from transcripts where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from conversation_events where conversation_id like 'demo_%'`);
  await db.execute(sql`delete from conversations where id like 'demo_%'`);

  const convRows: (typeof s.conversations.$inferInsert)[] = [];
  const actionRows: (typeof s.actions.$inferInsert)[] = [];
  const fbRows: (typeof s.feedback.$inferInsert)[] = [];
  const trRows: (typeof s.transfers.$inferInsert)[] = [];
  const cmpRows: (typeof s.complaints.$inferInsert)[] = [];
  const txRows: (typeof s.transcripts.$inferInsert)[] = [];
  let seq = 0;
  let cmpSeq = 900;

  const now = Date.now();
  for (let d = DAYS; d >= 0; d--) {
    const dayStartLocal = Math.floor((now + TZ_OFFSET_MS) / 86400000) * 86400000 - d * 86400000; // local midnight in "shifted" ms
    const dayDate = new Date(dayStartLocal);
    const n =
      d === 0
        ? Math.round(conversationsForDay(0, dayDate) * ((now + TZ_OFFSET_MS - dayStartLocal) / 86400000))
        : conversationsForDay(d, dayDate);
    for (let i = 0; i < n; i++) {
      const intent = pickIntent();
      const lang: Lang = rnd.chance(0.3) ? "ar" : "en";
      const modality = rnd.chance(0.42) ? "voice" : "text";
      const channel = rnd.pick(["web", "web", "web", "app", "app", "whatsapp", "phone"]);
      const hour = pickHour();
      const startedMs = dayStartLocal + hour * 3600000 + rnd.int(0, 3599) * 1000 - TZ_OFFSET_MS;
      if (startedMs > now - 120000) continue;
      const startedAt = new Date(startedMs);
      const duration = rnd.int(intent.dur[0], intent.dur[1]) + (modality === "voice" ? 30 : 0);
      const endedAt = new Date(startedMs + duration * 1000);
      const dropped = rnd.chance(intent.dropP + (modality === "voice" && lang === "ar" ? 0.03 : 0));
      const transferred = !dropped && rnd.chance(intent.transferP);
      const outcome = dropped ? "dropped" : transferred ? "transferred" : "resolved";
      const id = `demo_${String(++seq).padStart(5, "0")}${rnd.pick(["a", "b", "c", "d"])}`;
      const loggedIn = rnd.chance(0.45);
      const journeys: Journey[] = intent.journeys.map((name, idx, arr) => {
        const last = idx === arr.length - 1;
        const status: Journey["status"] =
          dropped && last
            ? "abandoned"
            : transferred && last
              ? rnd.chance(0.5)
                ? "failed"
                : "abandoned"
              : "completed";
        return {
          name,
          status,
          at: new Date(startedMs + ((idx + 1) / (arr.length + 1)) * duration * 1000).toISOString(),
        };
      });
      const topics = [...intent.topics];
      if (transferred) topics.push("transfer");
      convRows.push({
        id,
        agentId: "agent_1001m1m6rghcfsr8nrpj5x08g16e",
        channel,
        modality,
        language: lang,
        customerId: loggedIn ? `C${rnd.int(1000, 9999)}` : null,
        isLoggedIn: loggedIn,
        status: "ended",
        mode: transferred ? "human" : "bot",
        outcome,
        topics,
        journeys,
        startedAt,
        endedAt,
        durationSeconds: duration,
        metadata: { synthetic: true, intent: intent.key },
      });

      // actions
      if (intent.actions && !dropped) {
        const steps = intent.actions;
        const stop = transferred ? rnd.int(0, steps.length - 1) : steps.length;
        steps.slice(0, stop).forEach((type, k) => {
          const failed = rnd.chance(type === "pay_order" ? 0.06 : 0.02);
          const st = new Date(startedMs + (k + 1) * 45000);
          const latency =
            type === "pay_order"
              ? rnd.int(900, 2600)
              : type === "swap_booking"
                ? rnd.int(1200, 3200)
                : rnd.int(180, 900);
          actionRows.push({
            id: `dact_${seq}_${k}`,
            conversationId: id,
            idempotencyKey: `demo:${id}:${type}:${k}`,
            type,
            resourceKey: `conversation:${id}`,
            input: { demo: true },
            status: failed ? "failed" : "succeeded",
            attempts: failed ? 2 : 1,
            result: failed ? null : { speech: "Done." },
            error: failed
              ? {
                  code: type === "pay_order" ? "PAYMENT_DECLINED" : "VISTA_UNAVAILABLE",
                  message: type === "pay_order" ? "Card declined" : "Vista timed out",
                  retryable: type !== "pay_order",
                }
              : null,
            steps: [],
            requestedBy: "agent",
            createdAt: st,
            startedAt: st,
            finishedAt: new Date(st.getTime() + latency),
          });
        });
      } else if (intent.actions && dropped && rnd.chance(0.5)) {
        const st = new Date(startedMs + 45000);
        actionRows.push({
          id: `dact_${seq}_0`,
          conversationId: id,
          idempotencyKey: `demo:${id}:${intent.actions[0]}:0`,
          type: intent.actions[0]!,
          resourceKey: `conversation:${id}`,
          input: { demo: true },
          status: "succeeded",
          attempts: 1,
          result: { speech: "Done." },
          steps: [],
          requestedBy: "agent",
          createdAt: st,
          startedAt: st,
          finishedAt: new Date(st.getTime() + rnd.int(200, 700)),
        });
      }

      // feedback (resolved conversations rate higher)
      if (!dropped && rnd.chance(0.55)) {
        const base = transferred ? [2, 3, 3, 4] : intent.key === "complaint" ? [2, 3, 4] : [3, 4, 4, 5, 5, 5];
        const rating = rnd.pick(base);
        fbRows.push({
          id: `dfb_${seq}`,
          conversationId: id,
          customerId: convRows[convRows.length - 1]!.customerId ?? null,
          rating,
          comment:
            rating >= 4
              ? rnd.pick(["Quick and easy", "Loved the seat map", "", "سريع وسهل", ""])
              : rnd.pick(["Took a while", "Had to repeat myself", "", "بطيء قليلاً"]),
          resolved: !transferred,
          language: lang,
          createdAt: endedAt,
        });
      }

      if (transferred) {
        const reason =
          intent.key === "complaint"
            ? "complaint"
            : intent.key === "cancellation" && rnd.chance(0.6)
              ? "policy"
              : rnd.pick(TRANSFER_REASONS);
        trRows.push({
          id: `dtr_${seq}`,
          conversationId: id,
          reason,
          summary: `${intent.key.replace("_", " ")} — guest needs a human (${reason}).`,
          adapter: "simulated",
          status: "ended",
          agentName: rnd.pick(AGENTS),
          createdAt: new Date(startedMs + duration * 600),
          connectedAt: new Date(startedMs + duration * 600 + 25000),
          endedAt,
        });
      }

      if (intent.key === "complaint") {
        cmpRows.push({
          id: `CMP-2026-${String(++cmpSeq).padStart(6, "0")}`,
          conversationId: id,
          customerId: convRows[convRows.length - 1]!.customerId ?? null,
          category: rnd.pick(COMPLAINT_CATS),
          severity: rnd.pick(["low", "medium", "medium", "high"]),
          cinemaId: null,
          description: fill(rnd.pick(T[lang].complaint)),
          status: transferred ? "escalated" : rnd.chance(0.7) ? "resolved" : "open",
          sentiment: "negative",
          createdAt: endedAt,
        });
      }

      // transcript (2–4 turns)
      const q = fill(rnd.pick(T[lang][intent.key as keyof typeof T.en]));
      const turns = [
        { role: "user" as const, text: q, at: 0 },
        {
          role: "agent" as const,
          text: lang === "ar" ? "بالتأكيد، لحظة من فضلك…" : "Sure — one moment…",
          at: 2,
        },
      ];
      if (dropped)
        turns.push({
          role: "agent" as const,
          text: lang === "ar" ? "هل ما زلت معي؟" : "Are you still there?",
          at: duration - 20,
        });
      else if (transferred)
        turns.push({
          role: "agent" as const,
          text:
            lang === "ar"
              ? "أوصلك الآن بموظف خدمة العملاء."
              : "I'm connecting you to a customer care agent now.",
          at: Math.round(duration * 0.6),
        });
      else
        turns.push({
          role: "agent" as const,
          text: lang === "ar" ? "تم! هل هناك شيء آخر؟" : "All done! Anything else?",
          at: duration - 10,
        });
      txRows.push({
        conversationId: id,
        turns,
        analysis: {
          data_collection_results: {
            outcome: { value: outcome },
            sentiment: { value: intent.key === "complaint" ? "negative" : "positive" },
          },
        },
        summary: `${lang === "ar" ? "محادثة" : "Conversation"}: ${intent.key.replace("_", " ")} → ${outcome}.`,
        callSuccessful: outcome === "resolved" ? "success" : outcome === "dropped" ? "failure" : "unknown",
        receivedAt: endedAt,
      });
    }
  }

  const chunk = async <R>(rows: R[], ins: (r: R[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 500) await ins(rows.slice(i, i + 500));
  };
  await chunk(convRows, (r) => db.insert(s.conversations).values(r));
  await chunk(actionRows, (r) => db.insert(s.actions).values(r));
  await chunk(fbRows, (r) => db.insert(s.feedback).values(r));
  await chunk(trRows, (r) => db.insert(s.transfers).values(r));
  await chunk(cmpRows, (r) => db.insert(s.complaints).values(r));
  await chunk(txRows, (r) => db.insert(s.transcripts).values(r));
  console.log(
    `history: ${convRows.length} conversations, ${actionRows.length} actions, ${fbRows.length} feedback, ${trRows.length} transfers, ${cmpRows.length} complaints over ${DAYS} days`,
  );
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
