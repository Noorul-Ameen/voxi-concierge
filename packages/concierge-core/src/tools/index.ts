import { TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import { bookingTools } from "./bookings.js";
import { cinemaTools } from "./cinemas.js";
import { customerTools } from "./customer.js";
import { movieTools } from "./movies.js";
import { offerTools, orderingTools } from "./ordering.js";
import { quickTools } from "./quick.js";
import type { ToolCtx, ToolHandlers, ToolResult } from "./types.js";

export const toolHandlers: ToolHandlers = {
  ...movieTools,
  ...cinemaTools,
  ...bookingTools,
  ...orderingTools,
  ...offerTools,
  ...customerTools,
  ...quickTools,
};

/** Validate input against the contract, run the handler, normalise errors. */
export async function runTool(name: ToolName, ctx: ToolCtx, rawInput: unknown): Promise<ToolResult> {
  const def = TOOL_REGISTRY[name];
  if (!def) return { ok: false, error: { code: "NOT_FOUND", message: `Unknown tool ${name}` } };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      },
    };
  const handler = toolHandlers[name] as (ctx: ToolCtx, input: unknown) => Promise<ToolResult>;
  return handler(ctx, parsed.data);
}

export * from "./types.js";
export { bookingCard, toSnapshot, verifyOwnership } from "./bookings.js";
export { orderSummary, reviewAndPay, savedCardOfferHint } from "./ordering.js";
export { seatRange } from "./quick.js";
export { filmCard, sessionCard } from "./movies.js";
export { cinemaCard } from "./cinemas.js";
