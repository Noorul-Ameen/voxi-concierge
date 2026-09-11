import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError, ErrorCodes } from "@voxi/contracts";
import type { ToolCtx } from "../tools/types.js";
import { resolveLinkedConversation } from "./relink.js";

type RefundChoice = { bookingId: string; bookingVersion: number; ticketIds?: string[] };
type Proof = RefundChoice & {
  purpose: "refund-choice";
  conversationId: string;
  customerId: string | null;
  generation: number;
  expiresAt: number;
};
const ticketsKey = (ids?: string[]) => (ids === undefined ? null : [...ids].sort().join("\u0000"));
const signature = (ctx: ToolCtx, body: string) =>
  createHmac("sha256", ctx.cfg.widgetJwtSecret).update(`refund-choice:${body}`).digest();

/** Carries prior verified ownership to the next review click without exposing guest contact details. */
export function signRefundChoice(ctx: ToolCtx, choice: RefundChoice): string {
  const value: Proof = {
    ...choice,
    purpose: "refund-choice",
    conversationId: ctx.conversation.id,
    customerId: ctx.conversation.customerId ?? null,
    generation: Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0),
    expiresAt: Date.now() + 3 * 60_000,
  };
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${signature(ctx, body).toString("base64url")}`;
}

export async function verifyRefundChoice(ctx: ToolCtx, token: string, choice: RefundChoice): Promise<void> {
  const reject = () =>
    new DomainError(
      ErrorCodes.CONFIRMATION_EXPIRED,
      "That refund choice changed or expired. Please verify the booking and review the refund options again.",
    );
  const [body, signed, extra] = token.split(".");
  if (!body || !signed || extra) throw reject();
  const expected = signature(ctx, body);
  const supplied = Buffer.from(signed, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw reject();
  let value: Proof;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString()) as Proof;
  } catch {
    throw reject();
  }
  if (
    value.purpose !== "refund-choice" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.generation !== Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0) ||
    (value.customerId && value.customerId !== ctx.conversation.customerId) ||
    value.bookingId !== choice.bookingId ||
    value.bookingVersion !== choice.bookingVersion ||
    ticketsKey(value.ticketIds) !== ticketsKey(choice.ticketIds)
  )
    throw reject();
  if (
    value.conversationId !== ctx.conversation.id &&
    (await resolveLinkedConversation(ctx.db, value.conversationId))?.id !== ctx.conversation.id
  )
    throw reject();
}
