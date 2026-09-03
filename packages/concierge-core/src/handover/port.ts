/** Human handover port. Adapters: simulated (demo without Genesys), genesys (Open Messaging). */
export type HandoverRequest = {
  transferId: string;
  conversationId: string;
  reason: string;
  summary: string;
  language: "en" | "ar";
  customer: { name?: string; email?: string; phone?: string; memberId?: string; customerId?: string };
  context: Record<string, unknown>; // bookings, order, complaint ids...
  transcript: { role: "user" | "agent"; text: string }[];
};
export type HandoverResult = {
  externalConversationId: string;
  externalReference?: string;
  status: "queued" | "connected";
  agentName?: string;
  estimatedWaitSeconds?: number;
};

export interface HandoverPort {
  readonly name: "simulated" | "genesys";
  start(req: HandoverRequest): Promise<HandoverResult>;
  /** customer → human agent */
  sendCustomerMessage(
    externalConversationId: string,
    text: string,
    meta: { transferId: string; conversationId: string },
  ): Promise<void>;
  end(externalConversationId: string, reason: string): Promise<void>;
}
