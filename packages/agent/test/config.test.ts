import { describe, expect, it } from "vitest";
import {
  buildAgentBehaviorPatch,
  buildAgentConfig,
  buildClientTools,
  buildWebhookTools,
} from "../src/index.js";

const opts = { conciergeUrl: "https://fixture.invalid", toolSecretHeader: { secret_id: "fixture-secret" } };
describe("agent configuration contracts", () => {
  it("waits for the live seat-map result instead of assuming the screen opened", () => {
    const map = buildClientTools().find((tool) => tool.name === "render_seat_map")!;
    expect(map.expects_response).toBe(true);
    expect(map.response_timeout_secs).toBeGreaterThanOrEqual(20);
    expect(map.parameters.required).toContain("sessionKey");
  });
  it("keeps film language free of the UI language enum and includes booking refinements", () => {
    const tools = buildWebhookTools(opts);
    const props = (name: string) =>
      tools.find((tool) => tool.name === name)!.api_schema.request_body_schema.properties;
    expect(props("get_recommendations").language).not.toHaveProperty("enum");
    expect(props("get_recommendations")).toHaveProperty("withChildren");
    expect(props("get_recommendations")).toHaveProperty("timeFrom");
    expect(props("list_offers")).toHaveProperty("bank");
    expect(props("list_offers")).toHaveProperty("cardBin");
    expect(props("login_customer")).not.toHaveProperty("password");
    expect(
      tools.find((tool) => tool.name === "order_fnb")!.api_schema.request_body_schema.required,
    ).not.toContain("items");
  });
  it("matches the verified model and voice defaults for newly generated configurations", () => {
    const config = buildAgentConfig(opts);
    expect(config.conversation_config.agent.prompt).toMatchObject({
      llm: "gemini-3.6-flash",
      temperature: 0,
      reasoning_effort: "minimal",
    });
    expect(config.conversation_config.tts).toMatchObject({
      model_id: "eleven_v3_conversational",
      expressive_mode: true,
    });
    expect(config.conversation_config.turn).toMatchObject({
      turn_model: "turn_v3",
      speculative_turn: true,
      silence_end_call_timeout: 180,
    });
  });
  it("existing-agent patches cannot overwrite voice, model, privacy or knowledge", () => {
    const patch = buildAgentBehaviorPatch(["fixture-tool"]);
    expect(Object.keys(patch.conversation_config)).toEqual(["agent"]);
    expect(Object.keys(patch.conversation_config.agent.prompt).sort()).toEqual(["prompt", "tool_ids"]);
    expect(patch).not.toHaveProperty("platform_settings");
  });
  it("disables provider pre-tool speech for context, polling and bookkeeping", () => {
    const tools = buildWebhookTools(opts);
    for (const name of ["get_session_context", "get_action_result", "log_journey", "submit_feedback"]) {
      expect(tools.find((tool) => tool.name === name)!.pre_tool_speech).toBe("off");
    }
    expect(tools.find((tool) => tool.name === "pay_order")!.pre_tool_speech).toBe("force");
  });
});
