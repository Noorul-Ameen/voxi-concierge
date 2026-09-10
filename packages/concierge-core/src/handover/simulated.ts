import { type Db, prefixedId } from "@voxi/db";
import { enqueue } from "../actions/ledger.js";
import type { HandoverPort, HandoverRequest, HandoverResult } from "./port.js";

/**
 * Simulated agent desk for demos without Genesys: "connects" after a short delay and replies to
 * customer messages. Replies are delivered by the worker's polling loop via `pending()`.
 */
export class SimulatedHandover implements HandoverPort {
  readonly name = "simulated" as const;
  constructor(private readonly db?: Db) {}
  private queue: {
    externalConversationId: string;
    transferId: string;
    conversationId: string;
    text: string;
    agentName: string;
    at: number;
  }[] = [];
  private agents = ["Aisha", "Omar", "Priya"];
  private async schedule(reply: (typeof this.queue)[number]) {
    if (!this.db) {
      this.queue.push(reply);
      return;
    }
    await enqueue(this.db, null, {
      conversationId: reply.conversationId,
      type: "simulated_reply",
      resourceKey: `transfer:${reply.transferId}`,
      idempotencyKey: prefixedId("sim_reply", 16),
      payload: reply,
      requestedBy: "system",
    });
  }
  async start(req: HandoverRequest): Promise<HandoverResult> {
    const agentName = this.agents[Math.floor(Math.random() * this.agents.length)]!;
    const ext = `sim_${req.transferId}`;
    const greeting =
      req.language === "ar"
        ? `مرحباً ${req.customer.name?.split(" ")[0] ?? ""}، معك ${agentName} من خدمة عملاء فوكس. اطلعت على ملخص محادثتك مع المساعد الافتراضي — كيف أساعدك؟`
        : `Hi ${req.customer.name?.split(" ")[0] ?? "there"}, this is ${agentName} from VOX Customer Care. I've read the summary from the virtual assistant — how can I help?`;
    await this.schedule({
      externalConversationId: ext,
      transferId: req.transferId,
      conversationId: req.conversationId,
      text: greeting,
      agentName,
      at: Date.now() + 2500,
    });
    return { externalConversationId: ext, status: "queued", agentName, estimatedWaitSeconds: 3 };
  }
  async sendCustomerMessage(ext: string, text: string, meta: { transferId: string; conversationId: string }) {
    const agentName = this.agents[0]!;
    const reply = /refund|استرداد/i.test(text)
      ? "I can see the refund request. I'm processing it now — you'll receive an email confirmation within a few minutes."
      : /thank|شكر/i.test(text)
        ? "You're welcome! Is there anything else I can help with?"
        : "Thanks — let me check that for you. One moment please.";
    await this.schedule({
      externalConversationId: ext,
      transferId: meta.transferId,
      conversationId: meta.conversationId,
      text: reply,
      agentName,
      at: Date.now() + 1800,
    });
  }
  async end() {
    /* no-op */
  }
  /** Drain due replies (called by the worker). */
  pending(now = Date.now()) {
    const due = this.queue.filter((q) => q.at <= now);
    this.queue = this.queue.filter((q) => q.at > now);
    return due;
  }
}
