import { z } from "zod";
import { ActionRef, UiHint } from "./common.js";

/** Server-sent events pushed to the widget over /events/{conversationId}. */
export const WidgetEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ui.render"), seq: z.number(), ui: UiHint }),
  z.object({ type: z.literal("action.queued"), seq: z.number(), action: ActionRef }),
  z.object({ type: z.literal("action.completed"), seq: z.number(), action: ActionRef, ui: UiHint.optional() }),
  z.object({ type: z.literal("order.updated"), seq: z.number(), userSessionId: z.string(), summary: z.record(z.unknown()) }),
  z.object({ type: z.literal("transfer.status"), seq: z.number(), transferId: z.string(), status: z.string(), agentName: z.string().optional() }),
  z.object({ type: z.literal("human.message"), seq: z.number(), transferId: z.string(), text: z.string(), agentName: z.string().optional() }),
  z.object({ type: z.literal("language.changed"), seq: z.number(), language: z.enum(["en", "ar"]) }),
  z.object({ type: z.literal("heartbeat"), seq: z.number(), at: z.string() }),
]);
export type WidgetEvent = z.infer<typeof WidgetEvent>;

/** Messages the widget posts to the concierge (outside of the agent). */
export const WidgetCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("seat.select"), userSessionId: z.string(), seats: z.array(z.object({ row: z.string(), number: z.string() })) }),
  z.object({ type: z.literal("payment.token"), userSessionId: z.string(), confirmationId: z.string(), token: z.string() }),
  z.object({ type: z.literal("location"), lat: z.number(), lng: z.number(), accuracyM: z.number().optional() }),
  z.object({ type: z.literal("human.message"), transferId: z.string(), text: z.string() }),
  z.object({ type: z.literal("feedback"), rating: z.number().int().min(1).max(5), comment: z.string().optional() }),
  z.object({ type: z.literal("card.action"), value: z.string() }),
]);
export type WidgetCommand = z.infer<typeof WidgetCommand>;
