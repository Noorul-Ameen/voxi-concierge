/**
 * Genesys Cloud Open Messaging adapter.
 * Inbound (customer → Genesys): POST /api/v2/conversations/messages/{integrationId}/inbound/open/message
 * Outbound (agent → customer): Genesys calls our webhook (POST /webhooks/genesys) signed with X-Hub-Signature-256.
 * Docs: https://developer.genesys.cloud/commdigital/digital/openmessaging/
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../context.js";
import type { HandoverPort, HandoverRequest, HandoverResult } from "./port.js";

export type GenesysCfg = {
  region: string;
  clientId: string;
  clientSecret: string;
  integrationId: string;
  webhookSecret: string;
};

export class GenesysHandover implements HandoverPort {
  readonly name = "genesys" as const;
  private token: { value: string; exp: number } | null = null;
  constructor(
    private cfg: GenesysCfg,
    private log: Logger,
  ) {}

  private async accessToken() {
    if (this.token && this.token.exp - 60_000 > Date.now()) return this.token.value;
    const res = await fetch(`https://login.${this.cfg.region}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Genesys OAuth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async inbound(body: Record<string, unknown>) {
    const token = await this.accessToken();
    const res = await fetch(
      `https://api.${this.cfg.region}/api/v2/conversations/messages/${this.cfg.integrationId}/inbound/open/message`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      this.log.error({ status: res.status, text }, "genesys inbound failed");
      throw new Error(`Genesys inbound failed: ${res.status}`);
    }
    return (await res.json()) as { id: string; channel?: { id?: string } };
  }

  async start(req: HandoverRequest): Promise<HandoverResult> {
    // The first inbound message creates the Genesys conversation; the summary rides in the text + custom attributes
    // (custom attributes surface in the agent's interaction panel / OneView script).
    const attrs: Record<string, string> = {
      voxiTransferId: req.transferId,
      voxiConversationId: req.conversationId,
      reason: req.reason,
      language: req.language,
      summary: req.summary.slice(0, 2000),
      ...(req.customer.memberId ? { memberId: req.customer.memberId } : {}),
      ...(req.customer.email ? { email: req.customer.email } : {}),
      ...(req.context.bookingIds ? { bookingIds: String(req.context.bookingIds) } : {}),
      ...(req.context.complaintId ? { complaintId: String(req.context.complaintId) } : {}),
    };
    const first = await this.inbound({
      channel: {
        platform: "Open",
        type: "Private",
        messageId: `${req.transferId}-0`,
        to: { id: this.cfg.integrationId },
        from: {
          nickname: req.customer.name ?? "VOX guest",
          id: req.customer.customerId ?? req.conversationId,
          idType: "Opaque",
          firstName: req.customer.name?.split(" ")[0],
          lastName: req.customer.name?.split(" ").slice(1).join(" ") || undefined,
          email: req.customer.email,
        },
        time: new Date().toISOString(),
        metadata: { customAttributes: attrs },
      },
      type: "Text",
      text: `[Voxi handover — ${req.reason}]\n${req.summary}`,
      direction: "Inbound",
    });
    return { externalConversationId: first.id, status: "queued" };
  }

  async sendCustomerMessage(
    externalConversationId: string,
    text: string,
    meta: { transferId: string; conversationId: string },
  ) {
    await this.inbound({
      channel: {
        platform: "Open",
        type: "Private",
        messageId: `${meta.transferId}-${Date.now()}`,
        to: { id: this.cfg.integrationId },
        from: { id: meta.conversationId, idType: "Opaque" },
        time: new Date().toISOString(),
      },
      type: "Text",
      text,
      direction: "Inbound",
    });
    void externalConversationId;
  }

  async end(externalConversationId: string) {
    void externalConversationId; // Genesys ends the conversation from the agent side (wrap-up)
  }

  /** Verify X-Hub-Signature-256 on outbound webhooks. */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    if (!this.cfg.webhookSecret) return true;
    if (!header) return false;
    const expected = `sha256=${createHmac("sha256", this.cfg.webhookSecret).update(rawBody).digest("base64")}`;
    return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  }
}
