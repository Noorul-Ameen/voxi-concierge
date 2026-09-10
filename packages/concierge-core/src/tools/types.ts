import type { Language, TOOL_REGISTRY, ToolName, UiHint } from "@voxi/contracts";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import type { Catalog } from "../services/catalog.js";
import type { ConversationState } from "../services/conversation.js";

export type ToolCtx = AppContext & {
  catalog: Catalog;
  conversation: ConversationState;
  lang: Language;
  nowLocal: string; // cinema-local ISO
  toolCallId: string;
  correlationId: string;
  /** Internal inline mutation currently preparing its own completed basket. Never supplied by a tool. */
  checkoutMutationActionId?: string;
  /** Widget-only ownership proof for the exact refund review. Never accepted as agent tool input. */
  refundChoiceProof?: string;
};

export type ToolResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; retryable?: boolean };
  speech?: string;
  ui?: UiHint;
  /** journey markers for reporting */
  journey?: { name: string; status: "started" | "completed" | "abandoned" | "failed" };
};

export type ToolHandler<N extends ToolName> = (
  ctx: ToolCtx,
  input: z.infer<(typeof TOOL_REGISTRY)[N]["input"]>,
) => Promise<ToolResult>;
export type ToolHandlers = { [N in ToolName]: ToolHandler<N> };

export const ok = (
  data: Record<string, unknown>,
  speech?: string,
  ui?: UiHint,
  journey?: ToolResult["journey"],
): ToolResult => ({ ok: true, data, speech, ui, journey });
export const err = (
  code: string,
  message: string,
  retryable = false,
  data?: Record<string, unknown>,
): ToolResult => ({ ok: false, error: { code, message, retryable }, data });
