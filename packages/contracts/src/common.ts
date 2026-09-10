import { z } from "zod";

export const Language = z.enum(["en", "ar"]);
export type Language = z.infer<typeof Language>;

export const Experience = z.enum([
  "Standard",
  "MAX",
  "GOLD",
  "KIDS",
  "4DX",
  "THEATRE",
  "IMAX",
  "Premier",
  "Premium",
  "Couch",
  "Outdoor",
  "Private",
  "Other",
]);
export type Experience = z.infer<typeof Experience>;

/** Normalise the website's experience labels to the canonical set. */
export function normaliseExperience(label: string): Experience {
  const l = label.trim().toLowerCase();
  if (l.startsWith("standard")) return "Standard";
  if (l === "max" || l.includes("max")) return l.includes("imax") ? "IMAX" : "MAX";
  if (l.includes("gold")) return "GOLD";
  if (l.includes("kid")) return "KIDS";
  if (l.includes("4dx")) return "4DX";
  if (l.includes("theatre") || l.includes("theater")) return "THEATRE";
  if (l.includes("premier")) return "Premier";
  if (l.includes("premium")) return "Premium";
  if (l.includes("couch") || l.includes("sofa")) return "Couch";
  if (l.includes("outdoor") || l.includes("moonlight")) return "Outdoor";
  if (l.includes("private")) return "Private";
  if (l.includes("onyx")) return "Standard";
  return "Other";
}

export const RefundMethod = z.enum(["VOX_CREDIT", "SHARE_POINTS", "ORIGINAL_PAYMENT"]);
export type RefundMethod = z.infer<typeof RefundMethod>;

export const PaymentMethod = z.enum([
  "CARD",
  "SAVED_CARD",
  "VOX_CREDIT",
  "SHARE_POINTS",
  "APPLE_PAY",
  "SAMSUNG_PAY",
  "GOOGLE_PAY",
]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const Money = z.object({
  amountCents: z.number().int(),
  currency: z.string().default("AED"),
  display: z.string(),
});
export type Money = z.infer<typeof Money>;

export function money(amountCents: number, currency = "AED"): Money {
  return { amountCents, currency, display: `${currency} ${(amountCents / 100).toFixed(2)}` };
}

/** Standard envelope every tool returns. `speech` is what the agent may say; `ui` drives client tools. */
export const ToolResponse = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean(),
    data: data.optional(),
    error: z
      .object({ code: z.string(), message: z.string(), retryable: z.boolean().default(false) })
      .optional(),
    speech: z.string().optional(),
    ui: UiHint.optional(),
  });

export const UiCardType = z.enum([
  "movie",
  "showtimes",
  "cinema",
  "offer",
  "menu",
  "booking",
  "order",
  "seatmap",
  "payment",
  "qr",
  "complaint",
  "feedback",
  "transfer",
  "recommendation",
  "loyalty",
  "quantity",
]);

export const UiHint = z.object({
  type: UiCardType,
  title: z.string().optional(),
  items: z.array(z.record(z.unknown())).default([]),
  actions: z
    .array(
      z.object({
        label: z.string(),
        labelAlt: z.string().optional(),
        value: z.string(),
        style: z.enum(["primary", "secondary", "danger"]).default("secondary"),
      }),
    )
    .default([]),
  meta: z.record(z.unknown()).optional(),
});
export type UiHint = z.input<typeof UiHint>;

export const ActionStatus = z.enum(["queued", "running", "succeeded", "failed", "conflict", "cancelled"]);
export const ActionRef = z.object({
  actionId: z.string(),
  type: z.string(),
  status: ActionStatus,
  result: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
});
export type ActionRef = z.infer<typeof ActionRef>;

export const ConversationContext = z.object({
  conversationId: z.string().min(1),
  language: Language.default("en"),
  channel: z.string().default("web"),
  modality: z.enum(["voice", "text", "mixed"]).default("text"),
  customerId: z.string().optional(),
  memberId: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
export type ConversationContext = z.infer<typeof ConversationContext>;
