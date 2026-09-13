/**
 * VOX Cinemas Virtual Assistant configuration (server/webhook tools, client tools,
 * prompt, languages, analytics) from the shared contracts so the agent never drifts from the API.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_TOOLS, TOOL_REGISTRY, type ToolName } from "@voxi/contracts";
import type { z } from "zod";
import { procedureFallbackPrompt } from "./procedures.js";

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

// Provider pre-tool speech is off for state reads and bookkeeping, so latency heuristics cannot narrate them.
const SILENT_TOOLS = new Set<string>([
  "get_session_context",
  "get_action_result",
  "log_journey",
  "submit_feedback",
]);

const FILM_FILTER_TOOLS = new Set<string>([
  "get_recommendations",
  "search_films",
  "get_film",
  "search_sessions",
  "propose_booking",
]);

// These instructions sit beside the operation that can be misused, rather than
// relying on a distant conversation example to override the generic API label.
const AGENT_TOOL_USAGE: Partial<Record<ToolName, string>> = {
  get_age_rules:
    "First fetch the film's actual rating code; never pass its title as rating. Include a known childAge. Explain data.allowed:false as refusal, null as unconfirmed admission, and true using its exact conditions. For a family enquiry explain the rating and ask age once only if missing.",
  get_recommendations:
    "Omit every optional cinema, time/window, experience, seat or film-language filter that the guest did not specify. 'Usual' requests server-side profile inference, not a guessed input. Only a prior verified context/result can supply a preference; a greeting, example or conversation language cannot.",
  list_offers:
    "For 'my saved card', omit bank and cardBin: the authenticated backend resolves the card. bank means an actual named bank, never saved_card or another sentinel. Quote only the returned eligible saving; it remains potential until applied.",
  investigate_payment:
    "For an initial missing-booking/debit report, omit unknown optional IDs and inspect authenticated context. userSessionId is an actual returned order ID, never the current conversation/test ID. A failed get_order does not validate its input for this tool. A known paid booking with a QR rendering error needs receipt assistance, not a new payment investigation.",
  propose_booking:
    "Carry known composition on every proposal/edit: tickets is ADULT count, childTickets is CHILD count. One parent with one child means tickets:1, childTickets:1, not tickets:2 or totalTickets. Use only declared parameters. A failed proposal supplies no price, seats or acceptance token: explain the unresolved preview; never quote a replacement price or ask to hold an unreturned proposal.",
  prepare_payment:
    "This can open payment options. A booking request, saved-card mention, offer enquiry or current total is not a request to open payment. Call for an explicit review request or a requested balance-switch preview. A balance_split_confirmation is only a choice: after acceptance execute its exact redemptionInput including confirmationId/confirmed. That confirmed action reserves the chosen balance and opens the card review together. Its completed paymentReviewOpened:true and payment UI prove success; do not prepare again. Preserve VOX versus SHARE.",
  redeem_points:
    "After the guest accepts balance_split_confirmation, copy its complete redemptionInput including confirmationId and confirmed:true. Wait for this single action to reserve the balance and return the actual card-remainder review. paymentReviewOpened:true with payment UI means open; false means reserved but review failed, not paid. No confirmation means reserve-only, not an opened review. If the guest refuses the card remainder, do not execute the split.",
  get_order:
    "Requires a real unpaid order userSessionId copied from activeOrder or an earlier order result. A conversation ID, test-run ID, booking reference or placeholder is invalid. If no order ID is available, use get_session_context; for a member's existing paid booking use list_my_bookings instead.",
  resume_order:
    "This inspects an UNPAID basket/hold only. An empty result does not mean the customer has no confirmed bookings. For 'change/cancel my current booking', use list_my_bookings even when there is no active basket; ask which booking only when several match.",
  list_my_bookings:
    "Actually call this for a signed-in guest's existing/current booking, including a reference-free change or cancellation request; announcing a lookup is insufficient. An absent activeOrder is not evidence of no bookings. Match the known film/date/experience first; ask only if several still match, without reading every card aloud.",
  log_journey:
    "Do not log booking or payment; their backend records completion. Cancellation is completed only after successful cancel_booking, never after an eligibility refusal, explanation or handover. A thanks/goodbye supplies no reporting action. Preserve a failed or unresolved outcome instead of calling it completed.",
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
    // Film tools expose only filmLanguage. Their legacy language alias stays server-side;
    // reply/interface language already belongs to the authenticated conversation.
    const exposedProperties =
      name === "quick_book"
        ? Object.fromEntries(
            Object.entries(obj.properties).filter(([field]) =>
              ["proposalToken", "idempotencyKey"].includes(field),
            ),
          )
        : FILM_FILTER_TOOLS.has(name)
          ? Object.fromEntries(Object.entries(obj.properties).filter(([field]) => field !== "language"))
          : obj.properties;
    const properties: Record<string, Prop> = {
      ...CONTEXT_PROPS,
      ...exposedProperties,
    };
    if (FILM_FILTER_TOOLS.has(name))
      for (const field of [
        "cinemaId",
        "cinemaName",
        "time",
        "timeFrom",
        "timeTo",
        "experience",
        "seatPreference",
        "filmLanguage",
      ])
        if (properties[field])
          properties[field] = {
            ...properties[field],
            description: `${properties[field].description ?? ""} Optional: omit unless explicitly requested/selected or supplied by a current verified result. 'Usual' alone means backend inference, not an invented filter.`,
          } as Prop;
    if (name === "get_order" || name === "investigate_payment")
      properties.userSessionId = {
        ...properties.userSessionId,
        description:
          name === "investigate_payment"
            ? "Optional actual order ID from a successful activeOrder/order result. OMIT when unknown, including the initial debit enquiry. Never use conversationId, test-run ID, or a failed lookup's guessed input."
            : "Actual unpaid order ID copied from activeOrder.userSessionId or a successful order result. Never a conversation/test ID or booking reference; read context first if absent.",
      } as Prop;
    if (name === "list_offers")
      properties.bank = {
        ...properties.bank,
        description:
          "Optional actual bank name explicitly named by the guest or a verified card result. Omit for 'my saved card'; saved_card is not a bank name.",
      } as Prop;
    if (name === "propose_booking") {
      properties.tickets = {
        ...properties.tickets,
        description:
          "Adult tickets only. Preserve a known count on every edit: one parent and one child is tickets:1 plus childTickets:1. Omit only if genuinely unknown.",
      } as Prop;
      properties.childTickets = {
        ...properties.childTickets,
        description:
          "Child tickets, separate from adult tickets. Preserve the guest's known children on every proposal/edit; one parent with one child means 1 here and tickets:1.",
      } as Prop;
    }
    if (!FILM_FILTER_TOOLS.has(name) && !Object.hasOwn(obj.properties, "language")) {
      // Other tools keep their existing film-language contract or shared UI language.
      properties.language = {
        type: "string",
        description: "Language of the guest's last message: 'en' or 'ar'.",
        enum: ["en", "ar"],
      };
    }
    const isWrite = def.kind === "write";
    return {
      type: "webhook" as const,
      name,
      description:
        (name === "quick_book"
          ? "Hold only the exact verified proposal the guest authorized. A proposalToken returned by propose_booking is required; copy it unchanged. Never call this tool with just ticket count, a session ID or remembered choices. Use propose_booking for discovery or edits; resume_order for the active unpaid basket. Missing or fabricated tokens are rejected before any basket or consent change."
          : def.description) +
        (AGENT_TOOL_USAGE[name] ? ` ${AGENT_TOOL_USAGE[name]}` : "") +
        (SILENT_TOOLS.has(name)
          ? " Call silently; never announce fetching context, polling, logging or recording. Acknowledge a completed customer action only once when relevant."
          : "") +
        (isWrite
          ? " This performs an action; the response `speech` tells you the outcome. If data.action.status is queued/running, call get_action_result."
          : ""),
      response_timeout_secs: isWrite ? 20 : 15,
      execution_mode: "immediate" as const,
      // Announce the verified result, not an action or hold that may fail.
      pre_tool_speech: "off" as const,
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
          required: [
            "conversationId",
            ...(name === "quick_book" ? ["proposalToken"] : (obj.required ?? [])),
            ...(name === "redeem_points" ? ["balanceType"] : []),
          ],
        },
      },
    };
  });
}

/** Client tools executed by the widget. */
export function buildClientTools() {
  return Object.entries(CLIENT_TOOLS).map(([name, v]) => {
    const { prop } = zodToProp(v.params as unknown as z.ZodTypeAny);
    const expectsResponse = ["request_location", "confirm_dialog", "render_seat_map", "render_qr"].includes(
      name,
    );
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

export function systemPrompt(options: { proceduresEnabled?: boolean } = {}): string {
  const core = readFileSync(path.resolve(here, "../prompts/system.md"), "utf8");
  return options.proceduresEnabled
    ? `${core}\n\nUse the applicable published VOX procedure for task-specific guidance. Keep the same voice and conversation context; do not announce a procedure or recite its steps.\n`
    : `${core}\n\n${procedureFallbackPrompt()}`;
}

/** Native turn control only; it does not call the backend or change an order/hold. */
export const SKIP_TURN = {
  type: "system",
  name: "skip_turn",
  description:
    "Wait silently when the guest asks for a moment. After one brief acknowledgement, use this for subsequent silence or ellipsis until the guest resumes; do not ask if they are still there. This does not extend inactivity or seat-hold deadlines.",
  params: { system_tool_type: "skip_turn" },
} as const;

/** Existing-agent sync changes behaviour only, preserving all live model, voice, privacy and KB settings. */
export function buildAgentBehaviorPatch(toolIds: string[], options: { proceduresEnabled?: boolean } = {}) {
  return {
    conversation_config: {
      tts: { text_normalisation_type: "elevenlabs" as const },
      agent: {
        prompt: {
          prompt: systemPrompt(options),
          tool_ids: toolIds,
          built_in_tools: { skip_turn: SKIP_TURN },
        },
      },
    },
  };
}

export const FIRST_MESSAGE = {
  en: "Hi there, welcome to VOX Cinemas. How can I help you today?",
  ar: "أهلاً بك في فوكس سينما. كيف أساعدك اليوم؟",
};

/** Words the TTS/ASR should treat as brand terms (pronunciation dictionary / keywords). */
export const KEYWORDS = [
  "VOX",
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
  const promptCfg: Record<string, unknown> = {
    prompt: systemPrompt(),
    llm: opts.llm ?? "gemini-3.6-flash",
    reasoning_effort: "minimal",
    temperature: 0,
    enable_parallel_tool_calls: false,
    max_tokens: -1,
    tool_ids: opts.toolIds ?? [],
    built_in_tools: { skip_turn: SKIP_TURN },
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
  if (opts.inlineTools) promptCfg.tools = [...webhookTools, ...clientTools];
  return {
    name: opts.agentName ?? "VOX Cinemas Virtual Assistant (Phase 1 & 2 demo)",
    tags: ["vox-cinemas", "demo"],
    conversation_config: {
      agent: {
        // The widget computes the greeting per guest ("Hi Sara, welcome back…" for members) and passes it as a
        // dynamic variable; the placeholder is the generic line for sessions started without one.
        first_message: "{{greetingEn}}",
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: {
            customerId: "",
            memberId: "",
            channel: "web",
            language: "en",
            firstName: "",
            greetingEn: FIRST_MESSAGE.en,
            greetingAr: FIRST_MESSAGE.ar,
          },
        },
        prompt: promptCfg,
      },
      language_presets: {
        ar: {
          overrides: {
            agent: { first_message: "{{greetingAr}}" },
            tts: { voice_id: opts.voiceIdAr ?? opts.voiceIdEn ?? "cgSgspJ2msm6clMCkdW9" },
          },
          first_message_translation: { source_hash: "vox-assistant-ar", text: "{{greetingAr}}" },
        },
      },
      tts: {
        text_normalisation_type: "elevenlabs",
        voice_id: opts.voiceIdEn ?? "cgSgspJ2msm6clMCkdW9",
        model_id: "eleven_v3_conversational",
        expressive_mode: true,
        stability: 0.5,
        similarity_boost: 0.8,
        speed: 1.0,
        optimize_streaming_latency: 3,
        pronunciation_dictionary_locators: [],
      },
      asr: {
        quality: "high",
        provider: "scribe_realtime",
        user_input_audio_format: "pcm_16000",
        keywords: KEYWORDS,
      },
      // 3 minutes of silence before the call ends: a guest reading the seat map or the menu is not gone
      turn: {
        turn_timeout: 8,
        silence_end_call_timeout: 180,
        mode: "turn",
        turn_model: "turn_v3",
        turn_eagerness: "normal",
        speculative_turn: true,
      },
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
            "One of: resolved, transferred, dropped, unknown — was the guest's need fully handled by the assistant?",
        },
        topics: {
          type: "string",
          description:
            "Comma-separated topics discussed: movie_info, cinema_info, age_restrictions, general_info, offers, booking_info, cancellation, refund, swap, in_mall, fnb, guided_booking, payment, booking_status, feedback, complaint, personalisation, transfer",
        },
        sentiment: { type: "string", description: "Overall guest sentiment: positive, neutral, negative" },
        language_used: {
          type: "string",
          description:
            "Primary language actually used in the guest's substantive spoken or typed sentences: en, ar, mixed or unknown. Judge the dialogue, not a profile preference, name, interface language, dynamic variable, tool result, machine-generated [widget] event or the assistant's greeting. Use mixed when substantive English and Arabic are both used without a clear primary language, and unknown when there is no usable guest sentence. A film-language request or an isolated brand name/okay is not a conversation-language change.",
        },
      },
      evaluation: {
        criteria: [
          {
            id: "confirmation_before_action",
            name: "Confirmed before acting",
            type: "prompt",
            conversation_goal_prompt:
              "Evaluate only consequential actions actually requested or executed. Before a server payment, cancellation or exchange, the guest must receive the current relevant amount/terms and explicitly approve that specific action; before a fresh hold they must accept the current proposal or fresh-hold request. The review may be visible, so a repeated spoken recap or the literal word yes is not required. A verified widget proposal.accept, order.recover or payment.token result from the corresponding explicit user control is valid UI approval; do not require a second verbal approval or penalize the agent for acknowledging its confirmed success. Opening a payment review is not charging. Passive selections, general state snapshots, a yes to snacks, pending/failed events or an unverified claim of a click do not establish payment consent or success. Changed terms require fresh consent; a refused or unconfirmed consequential action must not execute. If no such action occurs, do not invent a missing-confirmation failure.",
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
              "Did the agent answer the guest's latest substantive sentence in its actual language, English or Arabic? Ignore profile/interface preferences, tool output, machine-generated [widget] events and isolated brand names or okay when identifying the guest's language. An initial greeting before a usable guest sentence is not evidence of a language mismatch.",
          },
        ],
      },
      privacy: {
        record_voice: true,
        retention_days: -1,
        delete_transcript_and_pii: false,
        delete_audio: false,
        zero_retention_mode: false,
      },
      auth: { enable_auth: false, allowlist: [] },
    },
  };
}
