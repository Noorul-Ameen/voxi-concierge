import { z } from "zod";
import { ActionRef, UiHint } from "./common.js";

/** Server-sent events pushed to the widget over /events/{conversationId}. */
const identity = { eventId: z.string().optional() };
export const WidgetEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ui.render"), seq: z.number(), ...identity, ui: UiHint }),
  z.object({ type: z.literal("action.queued"), seq: z.number(), ...identity, action: ActionRef }),
  z.object({
    type: z.literal("action.completed"),
    seq: z.number(),
    ...identity,
    action: ActionRef,
    ui: UiHint.optional(),
  }),
  z.object({
    type: z.literal("order.updated"),
    seq: z.number(),
    ...identity,
    userSessionId: z.string(),
    summary: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("transfer.status"),
    seq: z.number(),
    ...identity,
    transferId: z.string(),
    status: z.string(),
    agentName: z.string().optional(),
  }),
  z.object({
    type: z.literal("human.message"),
    seq: z.number(),
    ...identity,
    transferId: z.string(),
    text: z.string(),
    agentName: z.string().optional(),
  }),
  z.object({
    type: z.literal("language.changed"),
    seq: z.number(),
    ...identity,
    language: z.enum(["en", "ar"]),
  }),
  z.object({ type: z.literal("heartbeat"), seq: z.number(), ...identity, at: z.string() }),
]);
export type WidgetEvent = z.infer<typeof WidgetEvent>;

/** Messages the widget posts to the concierge (outside of the agent). */
export const WidgetCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("language"), language: z.enum(["en", "ar"]) }),
  z.object({
    type: z.literal("booking.select"),
    sessionKey: z.string().min(1),
    tickets: z.number().int().min(1).max(10).optional(),
    idempotencyKey: z.string().max(120).optional(),
  }),
  z.object({
    type: z.literal("seat.select"),
    userSessionId: z.string(),
    seats: z.array(z.object({ row: z.string(), number: z.string() })),
  }),
  z.object({
    type: z.literal("payment.token"),
    userSessionId: z.string(),
    confirmationId: z.string(),
    token: z.string(),
    /** guest details entered in the Review & Pay sheet */
    customer: z.object({ name: z.string(), email: z.string(), phone: z.string() }).optional(),
  }),
  // A new hold needs the customer's explicit confirmation; an expired timer never sends it automatically.
  z.object({
    type: z.literal("order.recover"),
    userSessionId: z.string().optional(),
    confirmed: z.boolean().optional(),
    idempotencyKey: z.string().max(120).optional(),
  }),
  // the widget's inactivity/timer watchdog asks the concierge to (re)render the current order
  z.object({ type: z.literal("order.state"), userSessionId: z.string().optional() }),
  z.object({
    type: z.literal("location"),
    lat: z.number(),
    lng: z.number(),
    accuracyM: z.number().optional(),
    label: z.string().optional(),
    source: z.enum(["gps", "manual"]).optional(),
  }),
  z.object({ type: z.literal("location.clear") }),
  z.object({ type: z.literal("human.message"), transferId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("feedback"),
    rating: z.number().int().min(1).max(5),
    comment: z.string().optional(),
  }),
  z.object({ type: z.literal("card.action"), value: z.string() }),
  // widget asks the concierge to (re)render the seat map for the active order
  z.object({ type: z.literal("seat.plan"), sessionKey: z.string(), userSessionId: z.string().optional() }),
]);
export type WidgetCommand = z.infer<typeof WidgetCommand>;
