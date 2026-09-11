/** OpenAPI for /tools/* generated from the shared Zod contracts (used by Postman and by the agent tool generator). */
import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ConversationContext, TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import { z } from "zod";

extendZodWithOpenApi(z);

export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  const auth = registry.registerComponent("securitySchemes", "toolKey", {
    type: "apiKey",
    in: "header",
    name: "x-voxi-key",
  });
  const response = z.object({
    ok: z.boolean(),
    speech: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).optional(),
    data: z.record(z.unknown()).optional(),
    ui: z.object({ type: z.string(), title: z.string().optional(), count: z.number() }).optional(),
  });
  for (const [name, def] of Object.entries(TOOL_REGISTRY) as [ToolName, (typeof TOOL_REGISTRY)[ToolName]][]) {
    const inner =
      (def.input as unknown as { _def: { typeName: string; schema?: z.AnyZodObject } })._def.typeName ===
      "ZodEffects"
        ? (def.input as unknown as { _def: { schema: z.AnyZodObject } })._def.schema
        : (def.input as unknown as z.AnyZodObject);
    const toolInput =
      name === "quick_book"
        ? inner.extend({
            proposalToken: z
              .string()
              .trim()
              .min(1)
              .describe("Token returned by propose_booking for the accepted selection."),
          })
        : inner;
    const body = ConversationContext.merge(toolInput).openapi(`${name}_input`);
    registry.registerPath({
      method: "post",
      path: `/tools/${name}`,
      summary: def.description,
      tags: [def.kind === "write" ? "actions" : "reads"],
      security: [{ [auth.name]: [] }],
      request: { body: { content: { "application/json": { schema: body } } } },
      responses: {
        200: { description: "Tool result", content: { "application/json": { schema: response } } },
      },
    });
  }
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Voxi Concierge API",
      version: "0.1.0",
      description:
        "Agent tools for the VOX 2.0 Digital Concierge. Write tools return an action reference; results arrive via get_action_result or SSE.",
    },
    servers: [{ url: serverUrl }],
  }) as unknown as Record<string, unknown>;
}
