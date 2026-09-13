import { TOOL_REGISTRY } from "@voxi/contracts";
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
  it("puts count, order identity and consequential-stage rules beside the affected operations", () => {
    const tools = buildWebhookTools(opts);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const proposal = byName("propose_booking").api_schema.request_body_schema;
    expect(proposal.properties.tickets).toMatchObject({ type: "integer" });
    expect(proposal.properties).not.toHaveProperty("totalTickets");
    expect(proposal.properties.childTickets.description).toContain("separate from adult tickets");
    expect(byName("prepare_payment").description).toContain("is not a request to open payment");
    expect(byName("resume_order").description).toContain("UNPAID basket/hold only");
    expect(byName("get_order").description).toContain("copied from activeOrder");
    expect(byName("log_journey").description).toContain("only after successful cancel_booking");
    expect(byName("list_my_bookings").description).toContain("reference-free change");
  });
  it("requires an explicit balance type for agent redemptions while preserving the legacy HTTP shape", () => {
    const tool = buildWebhookTools(opts).find((tool) => tool.name === "redeem_points")!;
    expect(tool.api_schema.request_body_schema.required).toContain("balanceType");
    expect(tool.api_schema.request_body_schema.properties.balanceType).toMatchObject({
      enum: ["SHARE_POINTS", "VOX_CREDIT"],
    });
    expect(tool.api_schema.request_body_schema.properties).toHaveProperty("amountCents");
    expect(tool.api_schema.request_body_schema.properties.confirmationId).toMatchObject({ type: "string" });
    expect(tool.api_schema.request_body_schema.properties.confirmed).toMatchObject({ type: "boolean" });
    expect(tool.api_schema.request_body_schema.required).not.toContain("confirmationId");
    expect(tool.api_schema.request_body_schema.required).not.toContain("confirmed");
    expect(tool.description).toContain("single action");
    expect(tool.description).toContain("paymentReviewOpened:true");
    expect(
      TOOL_REGISTRY.redeem_points.input.safeParse({
        userSessionId: "fixture_order",
        balanceType: "VOX_CREDIT",
        amountCents: 12000,
        confirmationId: "fixture_balance_split",
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(TOOL_REGISTRY.redeem_points.input.safeParse({ userSessionId: "fixture_order" }).success).toBe(
      true,
    );
  });
  it("keeps handover consent and exchange settlement descriptions consistent with their actual flows", () => {
    const tools = buildWebhookTools(opts);
    const transfer = tools.find((tool) => tool.name === "transfer_to_agent")!;
    expect(transfer.description).toContain("explicitly requests a person or accepts an offered transfer");
    expect(transfer.description).toContain("wait for the guest's answer");
    expect(transfer.description).not.toContain("Use on explicit request, frustration");
    const swap = tools.find((tool) => tool.name === "swap_booking")!;
    expect(swap.description).toContain("settling only its verified difference");
    expect(swap.description).not.toContain("refund original, rebook");
  });
  it("exposes only verified proposal acceptance for agent quick booking while preserving backend filters", () => {
    const tool = buildWebhookTools(opts).find((tool) => tool.name === "quick_book")!;
    const schema = tool.api_schema.request_body_schema;
    expect(schema.required).toContain("proposalToken");
    expect(schema.properties).not.toHaveProperty("tickets");
    expect(schema.properties).not.toHaveProperty("sessionKey");
    expect(schema.properties).toHaveProperty("idempotencyKey");
    expect(TOOL_REGISTRY.quick_book.input.safeParse({ tickets: 2 }).success).toBe(true);
    expect(TOOL_REGISTRY.propose_booking.input.safeParse({ tickets: 2, date: "tomorrow" }).success).toBe(
      true,
    );
  });
  it("waits for the live seat-map result instead of assuming the screen opened", () => {
    const map = buildClientTools().find((tool) => tool.name === "render_seat_map")!;
    expect(map.expects_response).toBe(true);
    expect(map.response_timeout_secs).toBeGreaterThanOrEqual(20);
    expect(map.parameters.required).toContain("sessionKey");
  });
  it("waits for a verified QR receipt render and accepts only the booking reference", () => {
    const qr = buildClientTools().find((tool) => tool.name === "render_qr")!;
    expect(qr.expects_response).toBe(true);
    expect(qr.response_timeout_secs).toBeGreaterThanOrEqual(20);
    expect(qr.parameters.required).toEqual(["bookingId"]);
    expect(Object.keys(qr.parameters.properties ?? {})).toEqual(["bookingId"]);
    expect(qr.description).toContain("ok:true and rendered:true");
    expect(qr.description).toContain("without claiming it is displayed");
  });
  it("keeps film language free of the UI language enum and includes booking refinements", () => {
    const tools = buildWebhookTools(opts);
    const props = (name: string) =>
      tools.find((tool) => tool.name === name)!.api_schema.request_body_schema.properties;
    expect(props("get_recommendations").filmLanguage).not.toHaveProperty("enum");
    expect(props("get_recommendations")).not.toHaveProperty("language");
    for (const name of ["search_films", "get_film", "search_sessions", "propose_booking"]) {
      expect(props(name)).not.toHaveProperty("language");
      expect(props(name).filmLanguage).not.toHaveProperty("enum");
    }
    expect(props("quick_book")).not.toHaveProperty("language");
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
      text_normalisation_type: "elevenlabs",
    });
    expect(config.conversation_config.turn).toMatchObject({
      turn_model: "turn_v3",
      speculative_turn: true,
      silence_end_call_timeout: 180,
    });
  });
  it("existing-agent patches cannot overwrite voice, model, privacy or knowledge", () => {
    const patch = buildAgentBehaviorPatch(["fixture-tool"]);
    expect(Object.keys(patch.conversation_config).sort()).toEqual(["agent", "tts"]);
    expect(patch.conversation_config.tts).toEqual({ text_normalisation_type: "elevenlabs" });
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
    expect(patch.conversation_config.tts).toEqual({ text_normalisation_type: "elevenlabs" });
    expect(patch.conversation_config.agent.prompt).not.toHaveProperty("llm");
    expect(buildWebhookTools(opts)).toHaveLength(Object.keys(TOOL_REGISTRY).length);
    expect(buildClientTools()).toHaveLength(12);
  });
  it("disables provider pre-tool speech for writes, context, polling and bookkeeping", () => {
    const tools = buildWebhookTools(opts);
    for (const name of ["get_session_context", "get_action_result", "log_journey", "submit_feedback"]) {
      expect(tools.find((tool) => tool.name === name)!.pre_tool_speech).toBe("off");
    }
    for (const name of ["pay_order", "quick_book", "add_concessions", "apply_offer", "recover_order"])
      expect(tools.find((tool) => tool.name === name)!.pre_tool_speech).toBe("off");
    expect(tools.every((tool) => tool.pre_tool_speech === "off")).toBe(true);
  });
});
