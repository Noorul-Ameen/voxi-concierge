/** ElevenLabs post-call webhook ingestion → transcripts, conversation outcome, topics. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppContext } from "@voxi/concierge-core";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";

/** ElevenLabs-Signature: t=<unix>,v0=<hmac sha256 of "<t>.<body>"> */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 30 * 60) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === v0.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v0));
}

type PostCall = {
  type: string; // post_call_transcription
  event_timestamp?: number;
  data: {
    agent_id: string;
    conversation_id: string;
    status: string;
    transcript: {
      role: "user" | "agent";
      message: string | null;
      time_in_call_secs?: number;
      tool_calls?: unknown[];
      tool_results?: unknown[];
    }[];
    metadata?: {
      start_time_unix_secs?: number;
      call_duration_secs?: number;
      main_language?: string;
      [k: string]: unknown;
    };
    analysis?: {
      call_successful?: string;
      transcript_summary?: string;
      evaluation_criteria_results?: Record<string, unknown>;
      data_collection_results?: Record<string, { value?: unknown }>;
    };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, string> };
  };
};

export async function ingestPostCall(app: AppContext, body: PostCall) {
  if (body.type !== "post_call_transcription") return { ignored: true, type: body.type };
  const d = body.data;
  const dyn = d.conversation_initiation_client_data?.dynamic_variables ?? {};
  const conversationId = d.conversation_id;
  // Post-call reports belong to this exact completed provider conversation.
  // Following a reconnect link here would let a delayed report reset the live
  // conversation's language or modality using stale initiation variables.
  await app.db
    .insert(S.conversations)
    .values({
      id: conversationId,
      language: dyn.language === "ar" ? "ar" : "en",
      channel: dyn.channel ?? "web",
      modality: "voice",
      customerId: dyn.customerId || null,
      memberId: dyn.memberId || null,
      isLoggedIn: !!dyn.customerId,
    })
    .onConflictDoNothing();
  const [conv] = await app.db.select().from(S.conversations).where(eq(S.conversations.id, conversationId));
  if (!conv) throw new Error("Post-call conversation was not created");
  const turns = d.transcript
    .filter((t) => t.message)
    .map((t) => ({ role: t.role, text: t.message!, at: t.time_in_call_secs, toolCalls: t.tool_calls }));
  const topics =
    (d.analysis?.data_collection_results?.topics?.value as string | undefined)
      ?.split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const outcomeRaw = String(d.analysis?.data_collection_results?.outcome?.value ?? "");
  const outcome =
    conv.mode === "human" || conv.status === "transferred"
      ? "transferred"
      : /resolved|success/i.test(outcomeRaw) || d.analysis?.call_successful === "success"
        ? "resolved"
        : /drop|abandon|incomplete/i.test(outcomeRaw) || d.analysis?.call_successful === "failure"
          ? "dropped"
          : "unknown";
  await app.db
    .insert(S.transcripts)
    .values({
      conversationId,
      turns,
      analysis: (d.analysis ?? {}) as Record<string, unknown>,
      summary: d.analysis?.transcript_summary ?? "",
      callSuccessful: d.analysis?.call_successful ?? null,
      raw: d as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: S.transcripts.conversationId,
      set: {
        turns,
        analysis: (d.analysis ?? {}) as Record<string, unknown>,
        summary: d.analysis?.transcript_summary ?? "",
        callSuccessful: d.analysis?.call_successful ?? null,
        raw: d as unknown as Record<string, unknown>,
        receivedAt: new Date(),
      },
    });
  const lang = (d.metadata?.main_language as string | undefined)?.slice(0, 2);
  await app.db
    .update(S.conversations)
    .set({
      status: "ended",
      endedAt: new Date(
        ((d.metadata?.start_time_unix_secs ?? Date.now() / 1000) + (d.metadata?.call_duration_secs ?? 0)) *
          1000,
      ),
      durationSeconds: d.metadata?.call_duration_secs ?? null,
      outcome,
      agentId: d.agent_id,
      ...(lang === "ar" || lang === "en" ? { language: lang } : {}),
      topics: [...new Set([...(conv.topics ?? []), ...topics])],
    })
    .where(eq(S.conversations.id, conversationId));
  app.log.info({ conversationId, outcome, turns: turns.length }, "post-call ingested");
  return { ok: true, conversationId, outcome };
}
