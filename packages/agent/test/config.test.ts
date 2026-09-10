import { describe, expect, it } from "vitest";
import {
  SKIP_TURN,
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
    expect(props("get_recommendations").filmLanguage).not.toHaveProperty("enum");
    expect(props("get_recommendations")).not.toHaveProperty("language");
    expect(props("search_films").language).not.toHaveProperty("enum");
    expect(props("quick_book").language).not.toHaveProperty("enum");
    expect(props("get_session_context").language).toMatchObject({ enum: ["en", "ar"] });
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
    expect(Object.keys(patch.conversation_config.agent.prompt).sort()).toEqual([
      "built_in_tools",
      "prompt",
      "tool_ids",
    ]);
    expect(patch).not.toHaveProperty("platform_settings");
  });
  it("enables only native skip-turn control in create and behaviour patches without extending timers", () => {
    const config = buildAgentConfig(opts);
    const patch = buildAgentBehaviorPatch(["fixture-tool"]);
    const expected = { skip_turn: SKIP_TURN };
    expect(config.conversation_config.agent.prompt.built_in_tools).toEqual(expected);
    expect(patch.conversation_config.agent.prompt.built_in_tools).toEqual(expected);
    expect(SKIP_TURN).toMatchObject({
      type: "system",
      name: "skip_turn",
      params: { system_tool_type: "skip_turn" },
    });
    expect(config.conversation_config.turn).toMatchObject({ turn_timeout: 8, silence_end_call_timeout: 180 });
    expect(patch.conversation_config).not.toHaveProperty("turn");
    expect(patch.conversation_config).not.toHaveProperty("tts");
    expect(patch.conversation_config.agent.prompt).not.toHaveProperty("llm");
    expect(buildWebhookTools(opts)).toHaveLength(44);
    expect(buildClientTools()).toHaveLength(12);
  });
  it("disables provider pre-tool speech for writes, context, polling and bookkeeping", () => {
    const tools = buildWebhookTools(opts);
    for (const name of ["get_session_context", "get_action_result", "log_journey", "submit_feedback"]) {
      expect(tools.find((tool) => tool.name === name)!.pre_tool_speech).toBe("off");
    }
    for (const name of ["pay_order", "quick_book", "add_concessions", "apply_offer", "recover_order"])
      expect(tools.find((tool) => tool.name === name)!.pre_tool_speech).toBe("off");
    expect(tools.find((tool) => tool.name === "get_recommendations")!.pre_tool_speech).toBe("auto");
  });
});
