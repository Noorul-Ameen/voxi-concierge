/**
 * Concierge-side tables: conversations, events, the Action Ledger (idempotent, serialised actions),
 * confirmations, complaints, feedback, transfers, knowledge base registry, reporting rollups.
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const conversations = pgTable(
  "conversations",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // ElevenLabs conversation_id (or widget-generated pre-id)
    agentId: varchar("agent_id", { length: 64 }),
    channel: varchar("channel", { length: 16 }).notNull().default("web"), // web | app | whatsapp | phone
    modality: varchar("modality", { length: 8 }).notNull().default("text"), // voice | text | mixed
    language: varchar("language", { length: 4 }).notNull().default("en"),
    customerId: varchar("customer_id", { length: 32 }),
    memberId: varchar("member_id", { length: 24 }),
    isLoggedIn: boolean("is_logged_in").notNull().default(false),
    market: varchar("market", { length: 4 }).notNull().default("AE"),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | transferred | ended
    mode: varchar("mode", { length: 8 }).notNull().default("bot"), // bot | human
    geo: jsonb("geo").$type<{ lat: number; lng: number; accuracyM?: number }>(),
    outcome: varchar("outcome", { length: 24 }), // resolved | transferred | dropped | unknown
    topics: jsonb("topics").$type<string[]>().default([]),
    journeys: jsonb("journeys").$type<{ name: string; status: "completed" | "abandoned" | "failed"; at: string }[]>().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (t) => [index("conversations_started_idx").on(t.startedAt), index("conversations_customer_idx").on(t.customerId)],
);

/** Append-only event log. Fed to the widget (SSE) and to reporting. */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    seq: integer("seq").notNull(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    type: varchar("type", { length: 48 }).notNull(), // tool.called | tool.completed | action.queued | action.completed | ui.render | transfer.* | message.user | message.agent
    actor: varchar("actor", { length: 16 }).notNull().default("system"), // user | agent | system | human_agent
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("conversation_events_seq_idx").on(t.conversationId, t.seq)],
);

export type ActionStatus = "queued" | "running" | "succeeded" | "failed" | "conflict" | "cancelled";
export type ActionStep = { name: string; status: "done" | "failed" | "compensated"; at: string; detail?: unknown };

/**
 * ACTION LEDGER — the heart of the concurrency model.
 * - idempotency_key unique: same tool call twice → same row.
 * - only one `running` action per conversation (partial unique index in migration).
 * - resource_key is the advisory-lock target during execution.
 */
export const actions = pgTable(
  "actions",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    type: varchar("type", { length: 48 }).notNull(), // cancel_booking | refund_booking | swap_booking | start_order | add_tickets | select_seats | add_concessions | apply_offer | pay_order | transfer_to_agent | submit_feedback | create_complaint | redeem_points
    resourceKey: varchar("resource_key", { length: 96 }).notNull(), // booking:WL59LFJ | order:usid | session:0002-627470 | conversation:id
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 16 }).$type<ActionStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<{ code: string; message: string; retryable: boolean; detail?: unknown }>(),
    steps: jsonb("steps").$type<ActionStep[]>().notNull().default([]),
    requestedBy: varchar("requested_by", { length: 16 }).notNull().default("agent"), // agent | widget | system
    toolCallId: varchar("tool_call_id", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 64 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("actions_idempotency_idx").on(t.idempotencyKey),
    index("actions_conversation_status_idx").on(t.conversationId, t.status),
    index("actions_queue_idx").on(t.status, t.createdAt),
    index("actions_resource_idx").on(t.resourceKey),
  ],
);

/** Confirmation gate: destructive actions must reference a prepared summary the customer heard. */
export const pendingConfirmations = pgTable(
  "pending_confirmations",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    actionType: varchar("action_type", { length: 48 }).notNull(),
    resourceKey: varchar("resource_key", { length: 96 }).notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    spokenSummary: text("spoken_summary").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pending_conf_conv_idx").on(t.conversationId, t.actionType)],
);

export const complaints = pgTable(
  "complaints",
  {
    id: varchar("id", { length: 32 }).primaryKey(), // "CMP-2026-000123"
    conversationId: varchar("conversation_id", { length: 64 }),
    customerId: varchar("customer_id", { length: 32 }),
    customerName: text("customer_name").default(""),
    customerEmail: text("customer_email").default(""),
    customerPhone: text("customer_phone").default(""),
    category: varchar("category", { length: 32 }).notNull(), // booking | refund | fnb | staff | facility | app | other
    severity: varchar("severity", { length: 8 }).notNull().default("medium"),
    cinemaId: varchar("cinema_id", { length: 8 }),
    bookingId: varchar("booking_id", { length: 16 }),
    visitDate: text("visit_date"),
    description: text("description").notNull(),
    resolutionOffered: text("resolution_offered").default(""),
    status: varchar("status", { length: 16 }).notNull().default("open"), // open | resolved | escalated
    sentiment: varchar("sentiment", { length: 12 }).default("negative"),
    oneViewCaseId: varchar("oneview_case_id", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("complaints_status_idx").on(t.status)],
);

export const feedback = pgTable("feedback", {
  id: varchar("id", { length: 32 }).primaryKey(),
  conversationId: varchar("conversation_id", { length: 64 }).notNull(),
  customerId: varchar("customer_id", { length: 32 }),
  rating: integer("rating").notNull(), // 1..5
  comment: text("comment").default(""),
  resolved: boolean("resolved"),
  language: varchar("language", { length: 4 }).default("en"),
  oneViewReference: varchar("oneview_reference", { length: 32 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transfers = pgTable(
  "transfers",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 24 }).notNull(), // customer_request | sentiment | fallback | complaint | policy
    summary: text("summary").notNull(),
    summaryAlt: text("summary_alt").default(""),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    adapter: varchar("adapter", { length: 16 }).notNull(), // genesys | simulated
    externalConversationId: varchar("external_conversation_id", { length: 64 }),
    externalReference: text("external_reference"),
    status: varchar("status", { length: 16 }).notNull().default("requested"), // requested | queued | connected | ended | failed
    agentName: text("agent_name"),
    oneViewNoteId: varchar("oneview_note_id", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("transfers_conversation_idx").on(t.conversationId)],
);

export const kbDocuments = pgTable("kb_documents", {
  id: varchar("id", { length: 64 }).primaryKey(), // slug
  title: text("title").notNull(),
  language: varchar("language", { length: 4 }).notNull().default("en"),
  category: varchar("category", { length: 32 }).notNull(), // faq | policy | age_restrictions | experiences | in_mall | offers | how_to
  sourceUrl: text("source_url").default(""),
  contentMarkdown: text("content_markdown").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  elevenlabsDocumentId: varchar("elevenlabs_document_id", { length: 64 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transcripts = pgTable("transcripts", {
  conversationId: varchar("conversation_id", { length: 64 }).primaryKey(),
  turns: jsonb("turns").$type<{ role: "user" | "agent"; text: string; at?: number; toolCalls?: unknown[] }[]>().notNull(),
  analysis: jsonb("analysis").$type<Record<string, unknown>>().default({}),
  summary: text("summary").default(""),
  callSuccessful: varchar("call_successful", { length: 12 }),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metricsDaily = pgTable(
  "metrics_daily",
  {
    day: varchar("day", { length: 10 }).notNull(), // YYYY-MM-DD (Asia/Dubai)
    language: varchar("language", { length: 4 }).notNull(),
    modality: varchar("modality", { length: 8 }).notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    conversations: integer("conversations").notNull().default(0),
    resolved: integer("resolved").notNull().default(0),
    transferred: integer("transferred").notNull().default(0),
    dropped: integer("dropped").notNull().default(0),
    journeysCompleted: jsonb("journeys_completed").$type<Record<string, number>>().notNull().default({}),
    journeysAbandoned: jsonb("journeys_abandoned").$type<Record<string, number>>().notNull().default({}),
    topics: jsonb("topics").$type<Record<string, number>>().notNull().default({}),
    transferReasons: jsonb("transfer_reasons").$type<Record<string, number>>().notNull().default({}),
    avgDurationSeconds: integer("avg_duration_seconds").notNull().default(0),
    avgRating: integer("avg_rating_x100").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("metrics_daily_key").on(t.day, t.language, t.modality, t.channel)],
);
