import { afterEach, describe, expect, it, vi } from "vitest";
import { signRefundChoice, verifyRefundChoice } from "../src/services/refund-choice-proof.js";
import { resolveLinkedConversation } from "../src/services/relink.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("../src/services/relink.js", () => ({ resolveLinkedConversation: vi.fn() }));
const context = () =>
  ({
    cfg: { widgetJwtSecret: "isolated-test-signing-secret" },
    conversation: { id: "guest-a", customerId: null, metadata: { widgetAuthGeneration: 0 } },
    db: {},
  }) as unknown as ToolCtx;
const choice = { bookingId: "BOOK1", bookingVersion: 2, ticketIds: ["ticket-a", "ticket-b"] };
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("guest refund choice proof", () => {
  it("carries only the exact booking/version/subset and survives a legitimate linked transport", async () => {
    const ctx = context();
    const proof = signRefundChoice(ctx, choice);
    await expect(
      verifyRefundChoice(ctx, proof, { ...choice, ticketIds: ["ticket-b", "ticket-a"] }),
    ).resolves.toBeUndefined();
    const body = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString());
    expect(Object.keys(body).sort()).toEqual(
      [
        "bookingId",
        "bookingVersion",
        "conversationId",
        "customerId",
        "expiresAt",
        "generation",
        "purpose",
        "ticketIds",
      ].sort(),
    );
    ctx.conversation.id = "guest-linked";
    vi.mocked(resolveLinkedConversation).mockResolvedValue({ id: "guest-linked" } as never);
    await expect(verifyRefundChoice(ctx, proof, choice)).resolves.toBeUndefined();
  });
  it("rejects altered bytes and changes to booking, version or selected tickets", async () => {
    const ctx = context();
    const proof = signRefundChoice(ctx, choice);
    await expect(verifyRefundChoice(ctx, `${proof}x`, choice)).rejects.toThrow("changed or expired");
    for (const changed of [
      { ...choice, bookingId: "BOOK2" },
      { ...choice, bookingVersion: 3 },
      { ...choice, ticketIds: ["ticket-a"] },
      { ...choice, ticketIds: undefined },
    ]) {
      await expect(verifyRefundChoice(ctx, proof, changed)).rejects.toThrow("changed or expired");
    }
  });
  it("rejects an unlinked session, logout generation and different authenticated customer", async () => {
    const ctx = context();
    const proof = signRefundChoice(ctx, choice);
    ctx.conversation.id = "unrelated";
    vi.mocked(resolveLinkedConversation).mockResolvedValue(undefined);
    await expect(verifyRefundChoice(ctx, proof, choice)).rejects.toThrow("changed or expired");
    ctx.conversation.id = "guest-a";
    ctx.conversation.metadata = { widgetAuthGeneration: 1 };
    await expect(verifyRefundChoice(ctx, proof, choice)).rejects.toThrow("changed or expired");
    const member = context();
    member.conversation.customerId = "member-a";
    const memberProof = signRefundChoice(member, choice);
    member.conversation.customerId = "member-b";
    await expect(verifyRefundChoice(member, memberProof, choice)).rejects.toThrow("changed or expired");
  });
  it("expires after three minutes without extending its deadline on verification", async () => {
    const ctx = context();
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const proof = signRefundChoice(ctx, choice);
    clock.mockReturnValue(now + 179_999);
    await expect(verifyRefundChoice(ctx, proof, choice)).resolves.toBeUndefined();
    clock.mockReturnValue(now + 180_000);
    await expect(verifyRefundChoice(ctx, proof, choice)).rejects.toThrow("changed or expired");
  });
});
