import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError, ErrorCodes } from "@voxi/contracts";
import type { ToolCtx } from "../tools/types.js";
import { resolveLinkedConversation } from "./relink.js";

export type BookingProposalProof = {
  conversationId: string;
  customerId: string | null;
  generation: number;
  expiresAt: number;
  sessionKey: string;
  adults: number;
  children: number;
  preference: string;
  seats: { row: string; number: string }[];
  tickets: { TicketTypeCode: string; Qty: number }[];
  totalCents: number;
};
export function signProposal(
  ctx: ToolCtx,
  value: Omit<BookingProposalProof, "conversationId" | "customerId" | "generation" | "expiresAt">,
) {
  const proof: BookingProposalProof = {
    ...value,
    conversationId: ctx.conversation.id,
    customerId: ctx.conversation.customerId ?? null,
    generation: Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0),
    expiresAt: Date.now() + 3 * 60_000,
  };
  const body = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return `${body}.${createHmac("sha256", ctx.cfg.widgetJwtSecret).update(body).digest("base64url")}`;
}
export async function verifyProposal(ctx: ToolCtx, token: string): Promise<BookingProposalProof> {
  const reject = () =>
    new DomainError(
      ErrorCodes.CONFIRMATION_EXPIRED,
      "That proposal changed or expired. Please review a fresh proposal before holding seats.",
    );
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw reject();
  const expected = createHmac("sha256", ctx.cfg.widgetJwtSecret).update(body).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw reject();
  let value: BookingProposalProof;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString()) as BookingProposalProof;
  } catch {
    throw reject();
  }
  if (
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.generation !== Number(ctx.conversation.metadata?.widgetAuthGeneration ?? 0) ||
    (value.customerId && value.customerId !== ctx.conversation.customerId)
  )
    throw reject();
  if (
    value.conversationId !== ctx.conversation.id &&
    (await resolveLinkedConversation(ctx.db, value.conversationId))?.id !== ctx.conversation.id
  )
    throw reject();
  return value;
}
