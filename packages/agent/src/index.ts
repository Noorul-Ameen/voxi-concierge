/**
 * Voxi agent-as-code: derives the ElevenLabs Agents configuration (server/webhook tools, client tools,
 * prompt, languages, analytics) from the shared contracts so the agent never drifts from the API.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_TOOLS, TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import type { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- Zod → ElevenLabs JSON-schema property ----------
type Literal = {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
  dynamic_variable?: string;
  constant_value?: string | number | boolean;
};
type ObjectProp = {
  type: "object";
  description?: string;
  properties: Record<string, Prop>;
  required?: string[];
};
type ArrayProp = { type: "array"; description?: string; items: Prop };
type Prop = Literal | ObjectProp | ArrayProp;

function unwrap(s: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; description?: string } {
  let cur = s;
  let optional = false;
  let description = s.description;
  for (;;) {
    const d = (
      cur as {
        _def: { typeName: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; description?: string };
      }
    )._def;
    description ??= cur.description;
    if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable") {
      optional = true;
      cur = d.innerType!;
    } else if (d.typeName === "ZodDefault") {
      optional = true;
      cur = d.innerType!;
    } else if (d.typeName === "ZodEffects") cur = d.schema!;
    else if (d.typeName === "ZodBranded" || d.typeName === "ZodCatch") cur = d.innerType!;
    else break;
  }
  return { inner: cur, optional, description };
}

export function zodToProp(s: z.ZodTypeAny, fallbackDescription = ""): { prop: Prop; optional: boolean } {
  const { inner, optional, description } = unwrap(s);
  const d = (inner as { _def: any })._def;
  const desc = description ?? fallbackDescription;
  switch (d.typeName) {
    case "ZodString":
      return { prop: { type: "string", description: desc }, optional };
    case "ZodNumber":
      return {
        prop: {
          type: d.checks?.some((c: { kind: string }) => c.kind === "int") ? "integer" : "number",
          description: desc,
        },
        optional,
      };
    case "ZodBoolean":
      return { prop: { type: "boolean", description: desc }, optional };
    case "ZodEnum":
      return {
        prop: { type: "string", description: desc || `One of: ${d.values.join(", ")}`, enum: d.values },
        optional,
      };
    case "ZodLiteral":
      return {
        prop: {
          type: typeof d.value === "boolean" ? "boolean" : typeof d.value === "number" ? "number" : "string",
          description: desc || `Must be ${JSON.stringify(d.value)}`,
          enum: typeof d.value === "string" ? [d.value] : undefined,
        },
        optional,
      };
    case "ZodArray": {
      const item = zodToProp(d.type, "item");
      return { prop: { type: "array", description: desc, items: item.prop }, optional };
    }
    case "ZodObject": {
      const shape = d.shape() as Record<string, z.ZodTypeAny>;
      const properties: Record<string, Prop> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const r = zodToProp(v, k);
        properties[k] = r.prop;
        if (!r.optional) required.push(k);
      }
      return { prop: { type: "object", description: desc, properties, required }, optional };
    }
    case "ZodRecord":
      return { prop: { type: "object", description: desc, properties: {} }, optional };
    default:
      return { prop: { type: "string", description: desc }, optional: true };
  }
}

export type AgentBuildOptions = {
  conciergeUrl: string; // public https URL of concierge-api
  toolSecretHeader: { value: string } | { secret_id: string }; // x-voxi-key
  voiceIdEn?: string;
  voiceIdAr?: string;
  llm?: string;
  agentName?: string;
  knowledgeBase?: { id: string; name: string; type: "text" | "file" | "url" }[];
  toolIds?: string[];
  inlineTools?: boolean;
};

const CONTEXT_PROPS: Record<string, Literal> = {
  conversationId: { type: "string", dynamic_variable: "system__conversation_id" },
  customerId: { type: "string", dynamic_variable: "customerId" },
  memberId: { type: "string", dynamic_variable: "memberId" },
  channel: { type: "string", dynamic_variable: "channel" },
};

/** Webhook (server) tool definitions — one per contract tool. */
export function buildWebhookTools(opts: AgentBuildOptions) {
  const headers: Record<string, unknown> = {
    "content-type": "application/json",
    "x-voxi-key":
      "value" in opts.toolSecretHeader
        ? opts.toolSecretHeader.value
        : { secret_id: opts.toolSecretHeader.secret_id },
  };
  return (Object.keys(TOOL_REGISTRY) as ToolName[]).map((name) => {
    const def = TOOL_REGISTRY[name];
    const { prop } = zodToProp(def.input as unknown as z.ZodTypeAny);
    const obj = prop as ObjectProp;
    const properties: Record<string, Prop> = {
      ...CONTEXT_PROPS,
      language: {
        type: "string",
        description: "Language of the guest's last message: 'en' or 'ar'.",
        enum: ["en", "ar"],
      },
      ...obj.properties,
    };
    const isWrite = def.kind === "write";
    return {
      type: "webhook" as const,
      name,
      description:
        def.description +
        (isWrite
          ? " This performs an action; the response `speech` tells you the outcome. If data.action.status is queued/running, call get_action_result."
          : ""),
      response_timeout_secs: isWrite ? 20 : 15,
      execution_mode: "immediate" as const,
      pre_tool_speech: isWrite ? ("force" as const) : ("auto" as const),
      interruption_mode: isWrite ? ("disable_during_tool" as const) : ("allow" as const),
      tool_error_handling_mode: "passthrough" as const,
      api_schema: {
        url: `${opts.conciergeUrl.replace(/\/$/, "")}/tools/${name}`,
        method: "POST" as const,
        content_type: "application/json" as const,
        request_headers: headers,
        request_body_schema: {
          type: "object" as const,
          properties,
          required: ["conversationId", ...(obj.required ?? [])],
        },
      },
    };
  });
}

/** Client tools executed by the widget. */
export function buildClientTools() {
  return Object.entries(CLIENT_TOOLS).map(([name, v]) => {
    const { prop } = zodToProp(v.params as unknown as z.ZodTypeAny);
    const expectsResponse = ["request_location", "confirm_dialog"].includes(name);
    return {
      type: "client" as const,
      name,
      description: v.description,
      expects_response: expectsResponse,
      response_timeout_secs: expectsResponse ? 60 : 20,
      parameters: prop as ObjectProp,
    };
  });
}

export function systemPrompt(): string {
  return readFileSync(path.resolve(here, "../prompts/system.md"), "utf8");
}

export const FIRST_MESSAGE = {
  en: "Hi, I'm Voxi from VOX Cinemas. I can help with showtimes, bookings, cancellations and refunds, offers and food — in English or Arabic. What can I do for you?",
  ar: "مرحباً، أنا فوكسي من فوكس سينما. أساعدك في مواعيد العروض والحجوزات والإلغاء والاسترداد والعروض والمأكولات — بالعربية أو الإنجليزية. كيف أساعدك؟",
};

/** Words the TTS/ASR should treat as brand terms (pronunciation dictionary / keywords). */
export const KEYWORDS = [
  "VOX",
  "Voxi",
  "SHARE",
  "Share Points",
  "VOX credit",
  "VOX Rewards",
  "MAX",
  "IMAX",
  "GOLD",
  "THEATRE",
  "KIDS",
  "4DX",
  "Premier",
  "Moonlight",
  "Mall of the Emirates",
  "MOE",
  "Deira",
  "Mirdif",
  "Shindagha",
  "Ajman",
  "Fujairah",
  "Yas Mall",
  "Al Maryah",
  "Galleria",
  "Burjuman",
  "Mercato",
  "Wafi",
  "Nakheel",
  "Kempinski",
  "Majid Al Futtaim",
  "Prepare Now",
  "Apple Pay",
  "Google Pay",
];

/** Full create/update body for POST /v1/convai/agents/create */
export function buildAgentConfig(opts: AgentBuildOptions) {
  const webhookTools = buildWebhookTools(opts);
  const clientTools = buildClientTools();
  const systemTools = [
    { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } },
    {
      type: "system",
      name: "language_detection",
      description: "Switch between English and Arabic when the guest changes language.",
      params: { system_tool_type: "language_detection" },
    },
    { type: "system", name: "skip_turn", description: "", params: { system_tool_type: "skip_turn" } },
  ];
  const promptCfg: Record<string, unknown> = {
    prompt: systemPrompt(),
    llm: opts.llm ?? "gemini-2.5-flash",
    temperature: 0.3,
    max_tokens: -1,
    tool_ids: opts.toolIds ?? [],
    built_in_tools: {
      end_call: systemTools[0],
      language_detection: systemTools[1],
      skip_turn: systemTools[2],
    },
    knowledge_base: (opts.knowledgeBase ?? []).map((k) => ({
      type: k.type,
      id: k.id,
      name: k.name,
      usage_mode: "auto",
    })),
    rag: {
      enabled: true,
      embedding_model: "multilingual_e5_large_instruct",
      max_vector_distance: 0.6,
      max_documents_length: 50000,
      max_retrieved_rag_chunks_count: 20,
    },
    custom_llm: null,
  };
  if (opts.inlineTools) promptCfg.tools = [...webhookTools, ...clientTools, ...systemTools];
  return {
    name: opts.agentName ?? "Voxi — VOX Cinemas Concierge (Phase 1 & 2 demo)",
    tags: ["voxi", "vox-cinemas", "demo"],
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE.en,
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: { customerId: "", memberId: "", channel: "web", language: "en" },
        },
        prompt: promptCfg,
      },
      language_presets: {
        ar: {
          overrides: { agent: { first_message: FIRST_MESSAGE.ar, language: "ar" } },
          first_message_translation: { source_hash: "voxi-ar", text: FIRST_MESSAGE.ar },
        },
      },
      tts: {
        voice_id: opts.voiceIdEn ?? "cgSgspJ2msm6clMCkdW9",
        model_id: "eleven_flash_v2_5",
        stability: 0.5,
        similarity_boost: 0.8,
        speed: 1.0,
        optimize_streaming_latency: 3,
        pronunciation_dictionary_locators: [],
      },
      asr: {
        quality: "high",
        provider: "elevenlabs",
        user_input_audio_format: "pcm_16000",
        keywords: KEYWORDS,
      },
      turn: { turn_timeout: 8, silence_end_call_timeout: 90, mode: "turn" },
      conversation: {
        max_duration_seconds: 1800,
        client_events: [
          "audio",
          "interruption",
          "user_transcript",
          "agent_response",
          "agent_response_correction",
          "client_tool_call",
          "agent_tool_response",
          "conversation_initiation_metadata",
          "ping",
        ],
      },
    },
    platform_settings: {
      widget: {
        variant: "full",
        avatar: { type: "orb", color_1: "#E4002B", color_2: "#1A1A1A" },
        feedback_mode: "end",
        text_input_enabled: true,
        transcript_enabled: true,
        language_selector: true,
        supports_text_only: true,
        mic_muting_enabled: true,
        placement: "bottom-right",
      },
      data_collection: {
        outcome: {
          type: "string",
          description:
            "One of: resolved, transferred, dropped, unknown — was the guest's need fully handled by Voxi?",
        },
        topics: {
          type: "string",
          description:
            "Comma-separated topics discussed: movie_info, cinema_info, age_restrictions, general_info, offers, booking_info, cancellation, refund, swap, in_mall, fnb, guided_booking, payment, booking_status, feedback, complaint, personalisation, transfer",
        },
        sentiment: { type: "string", description: "Overall guest sentiment: positive, neutral, negative" },
        language_used: { type: "string", description: "Primary language spoken: en or ar" },
      },
      evaluation: {
        criteria: [
          {
            id: "confirmation_before_action",
            name: "Confirmed before acting",
            type: "prompt",
            conversation_goal_prompt:
              "Did the agent read back a summary and get an explicit yes before cancelling, swapping or paying?",
          },
          {
            id: "no_hallucinated_facts",
            name: "Facts from tools only",
            type: "prompt",
            conversation_goal_prompt:
              "Did the agent avoid inventing showtimes, prices, policies or refund amounts not returned by tools or the knowledge base?",
          },
          {
            id: "language_match",
            name: "Answered in guest's language",
            type: "prompt",
            conversation_goal_prompt:
              "Did the agent respond in the same language the guest used (English or Arabic)?",
          },
        ],
      },
      privacy: {
        record_voice: true,
        retention_days: 30,
        delete_transcript_and_pii: false,
        delete_audio: false,
        zero_retention_mode: false,
      },
      auth: { enable_auth: false, allowlist: [] },
    },
  };
}
